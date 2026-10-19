import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../../src/index';
import {
  QUESTION_TTL_REVISIONS, controllerCronEnabled, nextActors, openQuestions, previewNextActions, readDecisions,
  runController, runScheduledControllers, type ControllerSnapshot, type QuestionFact,
} from '../../../src/collab-store/controller';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 L3d (incrément 2a) — questions ouvertes (X13), prochaines actions en
// lecture seule, passage programmé désactivé par défaut.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => '0000-l3d-' + label + '-' + (++counter);

function snapshot(questions: QuestionFact[], revision = 10): ControllerSnapshot {
  return { cycle_id: 'c', revision, phase: 'P6', halted: false, auto_advance: 'none', outputs_satisfied: false, tasks: [], questions };
}

async function seed(cycle: string): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'd-vibe', reviewer: 'd-grok', tester: 'd-claude' });
}

async function ask(cycle: string, pid: string, payload: Record<string, unknown>, n: number, rev = 1): Promise<void> {
  await insertEventRow(db, { cycle, type: 'clarify.ask', participant: pid, role: '', payload: { question: 'q' + n, ...payload },
    key: cycle + ':ask:' + n, expectedRev: rev });
}

async function seqOf(cycle: string, n: number): Promise<number> {
  const row = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(cycle + ':ask:' + n).first<{ seq: number }>();
  return row!.seq;
}

describe('CC-5 L3d — règles des questions ouvertes (pures)', () => {
  it('question adressée → réveil du destinataire ; publique ou adressée à soi → aucun réveil', () => {
    const { decisions } = nextActors(snapshot([
      { seq: 5, author: 'vibe', addressee: 'claude', asked_at_revision: 9 },
      { seq: 6, author: 'vibe', addressee: null, asked_at_revision: 9 },
      { seq: 7, author: 'grok', addressee: 'grok', asked_at_revision: 9 },
    ]));
    expect(decisions).toEqual([expect.objectContaining({ kind: 'wake', actor: 'claude', action: 'answer_question',
      rule: 'question-open', subject: 'ask#5' })]);
  });

  it('expiration par révision (X13) : à partir du TTL, l\'auteur doit renouveler ou clore, plus de réveil du destinataire', () => {
    const fresh = { seq: 5, author: 'vibe', addressee: 'claude', asked_at_revision: 100 };
    expect(nextActors(snapshot([fresh], 100 + QUESTION_TTL_REVISIONS - 1)).decisions.map(d => d.action)).toEqual(['answer_question']);
    const expired = nextActors(snapshot([fresh], 100 + QUESTION_TTL_REVISIONS)).decisions;
    expect(expired).toEqual([expect.objectContaining({ actor: 'vibe', action: 'renew_or_close_question', rule: 'question-expired' })]);
    const publicExpired = nextActors(snapshot([{ ...fresh, addressee: null }], 100 + QUESTION_TTL_REVISIONS)).decisions;
    expect(publicExpired.map(d => d.actor)).toEqual(['vibe']);
  });

  it('HALT : aucune décision sur les questions non plus', () => {
    expect(nextActors({ ...snapshot([{ seq: 5, author: 'vibe', addressee: 'claude', asked_at_revision: 9 }]), halted: true }))
      .toEqual({ mode: 'halted', decisions: [] });
  });

  it('openQuestions : réponse liée = fermée, rôle résolu sur la tâche, identités ramenées à la famille, payload illisible = publique', () => {
    const tasks = [{ task_id: 't', status: 'accepted', revision: 1, owner_pid: 'vibe', reviewer_pid: 'sol', tester_pid: 'grok' }];
    const logical = (pid: string) => pid === 'sol' || pid === 'gpt6' ? 'chatgpt' : pid;
    const rows = [
      { seq: 1, type: 'clarify.ask', participant_id: 'vibe', payload_json: JSON.stringify({ question: 'a', to: 'reviewer', task: 't' }), expected_rev: 3 },
      { seq: 2, type: 'clarify.ask', participant_id: 'gpt6', payload_json: JSON.stringify({ question: 'b', to: 'claude' }), expected_rev: 4 },
      { seq: 3, type: 'clarify.ask', participant_id: 'grok', payload_json: '{pas du json', expected_rev: 5 },
      { seq: 4, type: 'clarify.answer', participant_id: 'claude', payload_json: JSON.stringify({ ask_seq: 2, answer: 'ok' }), expected_rev: 6 },
      { seq: 5, type: 'clarify.ask', participant_id: 'grok', payload_json: JSON.stringify({ question: 'c', to: 'owner', task: 'inconnue' }), expected_rev: 7 },
    ];
    expect(openQuestions(rows, tasks, logical)).toEqual([
      { seq: 1, author: 'vibe', addressee: 'chatgpt', asked_at_revision: 3 },
      { seq: 3, author: 'grok', addressee: null, asked_at_revision: 5 },
      { seq: 5, author: 'grok', addressee: null, asked_at_revision: 7 },
    ]);
  });
});

describe('CC-5 L3d — questions dans un passage réel (D1)', () => {
  it('question adressée → réveil journalisé ; réponse → plus de réveil', async () => {
    const cycle = uniq('ask');
    await seed(cycle);
    await ask(cycle, 'd-vibe', { to: 'tester', task: 'l0' }, 1);
    const first = await runController(db, cycle);
    expect(first.decisions.filter(d => d.action === 'answer_question'))
      .toEqual([expect.objectContaining({ actor: 'd-claude', subject: 'ask#' + await seqOf(cycle, 1) })]);
    await insertEventRow(db, { cycle, type: 'clarify.answer', participant: 'd-claude', role: '',
      payload: { ask_seq: await seqOf(cycle, 1), answer: 'oui' }, key: cycle + ':answer:1' });
    const second = await runController(db, cycle);
    expect(second.decisions.some(d => d.action === 'answer_question')).toBe(false);
  });
});

describe('CC-5 L3d — previewNextActions (lecture seule)', () => {
  it('ne rend que les décisions de l\'appelant, n\'écrit rien au journal', async () => {
    const cycle = uniq('preview');
    await seed(cycle);
    await ask(cycle, 'd-vibe', { to: 'd-grok' }, 1);
    const vibe = await previewNextActions(db, cycle, 'd-vibe');
    expect(vibe).toMatchObject({ mode: 'active', participant: 'd-vibe', coordinator: false });
    expect(vibe.mine.map(d => d.action)).toEqual(['implement']);
    expect(vibe.others).toBe(1);
    expect(vibe.all).toBeUndefined();
    const grok = await previewNextActions(db, cycle, 'd-grok', { all: true });
    expect(grok.mine.map(d => d.action)).toEqual(['answer_question']);
    expect(grok.all).toHaveLength(2);
    expect(await readDecisions(db, cycle)).toHaveLength(0);
  });

  it('famille d\'identité : sol voit les actions attribuées à gpt6', async () => {
    const cycle = uniq('family');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'd-gpt6', reviewer: 'd-grok', tester: 'd-claude' });
    for (const pid of ['d-gpt6', 'd-sol']) {
      await db.prepare("INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING").bind(pid).run();
      await db.prepare("INSERT OR REPLACE INTO participant_identity_families (participant_id, family_id, updated_at) VALUES (?1, 'd-chatgpt', 0)").bind(pid).run();
    }
    const view = await previewNextActions(db, cycle, 'd-sol');
    expect(view.participant).toBe('d-chatgpt');
    expect(view.mine.map(d => [d.task_id, d.action])).toEqual([['l0', 'implement']]);
  });

  it('décisions « coordinator » rendues au seul titulaire du mandat actif', async () => {
    const cycle = uniq('mandate');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    const state = ['# T', 'schema_version: CC-STATE-1', 'workflow_id: CC-T', 'revision: 2', 'base_revision: 1', 'next_action: t',
      'canonical_ref: main', 'based_on_sha: abc1234', 'phase: P6', 'framing_version: F', 'framing_ref: x', 'plan_version: P',
      'plan_ref: x', 'execution_ref: x', 'contract_ref: x', 'acceptance_ref: x', '', '## Owner decisions', '- Kevin, t.', '',
      '## Roles', '| Actor | Scoped acceptance/assignment | Pending evidence |', '| --- | --- | --- |', '| A | a | x |', '',
      '## Tasks', '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| l0 | done | A | author | B | C | none | none | none | 1 | x | x |',
      '| l1 | blocked | B | author | C | A | none | l0 | none | 1 | x | x |', '', '## Evidence', '| source | state |', '| --- | --- |', '| x | y |', ''].join('\n');
    await insertEventRow(db, { cycle, type: 'owner.decision', participant: 'owner', role: 'owner',
      payload: { action: 'import_state', content: state }, key: 'owner-state-import:' + cycle + ':s' });
    await db.prepare("INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision) VALUES ('l0', ?1, 'd-vibe', 'd-grok', 'd-claude', 'done', '[]', '', '', 1), ('l1', ?1, 'd-grok', 'd-claude', 'd-vibe', 'blocked', '[]', '', '', 1)").bind(cycle).run();
    await db.prepare('CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)').run();
    expect((await previewNextActions(db, cycle, 'd-claude')).mine).toEqual([]);
    await db.prepare("INSERT INTO delegated_mandates (cycle_id, participant_id, family_id, epoch, updated_at) VALUES (?1, 'd-claude', 'd-claude', 1, 0)").bind(cycle).run();
    const holder = await previewNextActions(db, cycle, 'd-claude');
    expect(holder.coordinator).toBe(true);
    expect(holder.mine).toEqual([expect.objectContaining({ kind: 'unblock', actor: 'coordinator', task_id: 'l1' })]);
    expect((await previewNextActions(db, cycle, 'd-vibe')).mine.some(d => d.actor === 'coordinator')).toBe(false);
  });

  it('cycle inconnu → mode dégradé sans décision', async () => {
    expect(await previewNextActions(db, uniq('missing'), 'd-vibe')).toMatchObject({ mode: 'degraded', error: 'UNKNOWN_CYCLE', mine: [] });
  });
});

describe('CC-5 L3d — passage programmé', () => {
  it('drapeau strict : seul « true » active', () => {
    expect(controllerCronEnabled('true')).toBe(true);
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) expect(controllerCronEnabled(value)).toBe(false);
  });

  it('parcourt les cycles ouverts, ignore les cycles fermés, journalise une fois', async () => {
    const open = uniq('sched-open');
    const closed = uniq('sched-closed');
    await seed(open);
    await insertCycleRow(db, closed, 'P6', 'closed');
    const results = await runScheduledControllers(db);
    expect(results.find(r => r.cycle_id === open)).toMatchObject({ mode: 'active', recorded: 1 });
    expect(results.some(r => r.cycle_id === closed)).toBe(false);
    expect((await runScheduledControllers(db)).find(r => r.cycle_id === open)).toMatchObject({ recorded: 0 });
  });

  it('handler scheduled du Worker : inerte sans CONTROLLER_CRON_ENABLED="true"', async () => {
    await ensureSchema(db);
    const waits: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const base = { COLLAB_STORE_ENABLED: 'true', COLLAB_DB: db };
    const handler = worker as unknown as { scheduled: (c: unknown, e: unknown, x: ExecutionContext) => Promise<void> };
    await handler.scheduled({}, base, ctx);
    await handler.scheduled({}, { ...base, CONTROLLER_CRON_ENABLED: 'false' }, ctx);
    await handler.scheduled({}, { CONTROLLER_CRON_ENABLED: 'true', COLLAB_STORE_ENABLED: 'false', COLLAB_DB: db }, ctx);
    expect(waits).toHaveLength(0);
    await handler.scheduled({}, { ...base, CONTROLLER_CRON_ENABLED: 'true' }, ctx);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });
});

describe('CC-5 L3d — outil MCP collab_next_actions', () => {
  type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
  type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

  async function tool(clientId: string): Promise<ToolHandler> {
    const { registerCollabStoreTools } = await import('../../../src/collab-store/mcp/tools');
    const { createCollabToolContext } = await import('../../../src/collab-store/mcp/context');
    const context = createCollabToolContext({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' }, 'agent:x', ['collab:'], {}, clientId);
    let handler: ToolHandler | null = null;
    registerCollabStoreTools({ registerTool(name: string, _spec: unknown, h: ToolHandler) { if (name === 'collab_next_actions') handler = h; } } as never, context);
    return handler!;
  }

  it('identité issue du jeton : le client associé à d-tool voit ses actions ; un client non associé est refusé', async () => {
    const { mapClient, registerParticipant } = await import('../../../src/collab-store/owner/decisions');
    const proof = { kind: 'secret' as const, subject: 'owner-secret' };
    await registerParticipant(db, { participant_id: 'd-tool', display_label: 'D tool', proof, op: 'l3d-tool-register' });
    await mapClient(db, { oauth_client_id: 'client-l3d-tool', participant_id: 'd-tool', proof, op: 'l3d-tool-map' });
    const cycle = uniq('tool');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: 'l0', cycle, owner: 'd-tool', reviewer: 'd-grok', tester: 'd-claude' });
    const ok = await (await tool('client-l3d-tool'))({ cycle });
    expect(ok.isError).toBeFalsy();
    const view = JSON.parse(ok.content[0].text) as { participant: string; mine: Array<{ action: string }> };
    expect(view.participant).toBe('d-tool');
    expect(view.mine.map(d => d.action)).toEqual(['implement']);
    const denied = await (await tool('client-l3d-unknown'))({ cycle });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('UNREGISTERED_CLIENT');
    expect(await readDecisions(db, cycle)).toHaveLength(0);
  });
});

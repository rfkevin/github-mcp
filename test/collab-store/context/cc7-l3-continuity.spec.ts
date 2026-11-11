import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONTINUITY_MAX_NOTES, HANDOVER_KIND, handoverLength, loadContinuity, parseHandover } from '../../../src/collab-store/context';
import { answerPrompt, continuityEnabled, createReadToolHost, ANSWER_READ_WINDOW } from '../../../src/collab-store/agentrun';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { outputSchemas } from '../../../src/collab-store/mcp/schemas';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertTaskRow } from '../a0-helpers';
import { collabToolHandler, OWNER_PROOF, uniqueIds } from '../coordinator-helpers';

// CC-7 L3 (incrément 1) — continuité chat/API d'un participant : notes de passation, exécutions API depuis la
// dernière visite du chat, lectures de continuité du canal API (porte éteinte par défaut), consigne élargie.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('cc7l3');
let key = 0;

async function event(cycle: string, input: { type: string; participant: string; role?: string; at: number; payload: unknown }) {
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, 0, ?7, '')",
  ].join(' ')).bind(cycle, input.at, input.type, input.participant, input.role ?? '', JSON.stringify(input.payload),
    cycle + ':ev:' + (++key)).run();
}

const handover = (done: string, extra: Record<string, unknown> = {}) => ({ kind: HANDOVER_KIND, done, todo: 'suite', learned: 'piège', ...extra });

async function run(cycle: string, participant: string, at: number, summary: string): Promise<string> {
  const runId = uid('run');
  const created = await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: '', taskKind: 'answer', prompt: 'p',
    maxSteps: 6, maxTokens: 24_000, maxCostCents: 0, deadlineAt: at + 900, now: at });
  expect(created.created).toBe(true);
  // Le moteur consigne le message final dans summary ; on termine l'exécution pour libérer le bail.
  await db.prepare("UPDATE agent_runs SET status = 'completed', stop_reason = 'final', summary = ?2 WHERE run_id = ?1").bind(runId, summary).run();
  return runId;
}

/** Cycle P6 : tâche t-mine (rôle de pa), tâche t-other (sans rôle de pa) ; chat de pa à t=150, API de pa à t=200. */
async function seed() {
  await ensureSchema(db);
  const cycle = uid('c');
  const [pa, pb] = [uid('pa'), uid('pb')];
  await insertCycleRow(db, cycle, 'P6');
  await insertTaskRow(db, { taskId: 't-mine', cycle, owner: pa, reviewer: pb, tester: uid('pt') });
  await insertTaskRow(db, { taskId: 't-other', cycle, owner: pb, reviewer: uid('pr'), tester: uid('pt') });
  const oldRun = await run(cycle, pa, 50, 'ancienne exécution');
  await event(cycle, { type: 'checkpoint', participant: pa, role: 'author', at: 150, payload: handover('note du chat') });
  await event(cycle, { type: 'clarify.answer', participant: pa, role: 'api-agent', at: 200, payload: { ask_seq: 1, answer: 'r' } });
  await event(cycle, { type: 'checkpoint', participant: pb, role: 'author', at: 210, payload: handover('note d’un autre') });
  const newRun = await run(cycle, pa, 300, 'Fait : réponse. Reste : rien. Appris : lire le registre.');
  await run(cycle, pb, 300, 'exécution d’un autre');
  return { cycle, pa, pb, oldRun, newRun };
}

describe('CC-7 L3 — notes de passation', () => {
  it('parseHandover : type exact, au moins une rubrique, rubriques bornées', () => {
    expect(parseHandover(JSON.stringify(handover('a')))).toEqual({ done: 'a', todo: 'suite', learned: 'piège' });
    expect(parseHandover(JSON.stringify({ kind: 'autre', done: 'a' }))).toBeNull();
    expect(parseHandover(JSON.stringify({ kind: HANDOVER_KIND, done: '  ', todo: 3 }))).toBeNull();
    expect(parseHandover('pas du json')).toBeNull();
    expect(parseHandover('[1]')).toBeNull();
    expect(parseHandover(JSON.stringify(handover('x'.repeat(5000))))!.done).toHaveLength(2400);
    expect(handoverLength({ done: 'ab', todo: 'c', learned: 7 })).toBe(3);
  });
});

describe('CC-7 L3 — loadContinuity', () => {
  it('dernière visite = dernier événement du chat ; exécutions API postérieures seulement ; rien d’un autre participant', async () => {
    const { cycle, pa, newRun } = await seed();
    const view = await loadContinuity(db, cycle, [pa]);
    expect(view.last_visit_at).toBe(150);
    expect(view.api_runs.map(r => r.run_id)).toEqual([newRun]);
    expect(view.api_runs[0].summary).toContain('Appris');
    expect(view.handovers).toHaveLength(1);
    expect(view.handovers[0]).toMatchObject({ channel: 'chat', done: 'note du chat' });
    expect(view.truncated).toEqual({ api_runs: false, handovers: false });
    expect(await loadContinuity(db, cycle, [])).toMatchObject({ last_visit_seq: 0, api_runs: [], handovers: [] });
  });

  it('bornes : au plus CONTINUITY_MAX_NOTES notes, plus récentes d’abord, troncature signalée', async () => {
    const { cycle, pa } = await seed();
    for (let i = 0; i < CONTINUITY_MAX_NOTES + 1; i += 1) {
      await event(cycle, { type: 'checkpoint', participant: pa, role: i % 2 ? 'api-agent' : 'author', at: 400 + i, payload: handover('n' + i) });
    }
    const view = await loadContinuity(db, cycle, [pa]);
    expect(view.handovers).toHaveLength(CONTINUITY_MAX_NOTES);
    expect(view.handovers[0].done).toBe('n' + CONTINUITY_MAX_NOTES);
    expect(view.handovers.some(note => note.channel === 'api')).toBe(true);
    expect(view.truncated.handovers).toBe(true);
  });
});

describe('CC-7 L3 — outils de continuité du canal API', () => {
  it('porte éteinte : listes inchangées ; allumée : outils ajoutés aux types connus seulement', () => {
    const off = createReadToolHost({ db, repository: null, github: null });
    const on = createReadToolHost({ db, repository: null, github: null, continuity: true });
    expect(off.list('answer')).toEqual(['store_context', 'store_delta']);
    expect(on.list('answer')).toEqual(['store_context', 'store_delta', 'store_memory', 'store_continuity']);
    expect(on.list('inconnu')).toEqual([]);
    expect(on.spec('answer', 'store_memory')).toEqual({ name: 'store_memory', effect: 'read' });
    expect(off.spec('answer', 'store_memory')).toBeNull();
    expect(on.schemas('answer').map(s => s.name)).toContain('store_continuity');
  });

  it('store_context élargi, store_continuity et store_memory limités au participant de l’exécution', async () => {
    const { cycle, pa, pb, newRun } = await seed();
    const mine = 'cc7l3-mine-' + key;
    const theirs = 'cc7l3-theirs-' + key;
    for (const [id, scope] of [[mine, 'participant:' + pa], [theirs, 'participant:' + pb]]) {
      await db.prepare("INSERT INTO memory_entries (id, version, scope, kind, text, confidence, status, author_pid) VALUES (?1, 1, ?2, 'fact', 't', 'observed', 'active', ?3)")
        .bind(id, scope, scope.slice('participant:'.length)).run();
    }
    const host = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const ctx = { run_id: newRun };
    const context = await host.execute({ id: '1', name: 'store_context', args: {} }, ctx) as { tasks: Array<{ task_id: string }>; registry: Array<{ task_id: string }> };
    expect(context.tasks.map(t => t.task_id)).toEqual(['t-mine']);
    expect(context.registry.map(t => t.task_id)).toEqual(['t-mine', 't-other']);
    const continuity = await host.execute({ id: '2', name: 'store_continuity', args: { participant: pb } }, ctx) as { handovers: Array<{ done: string }> };
    expect(continuity.handovers.map(note => note.done)).toEqual(['note du chat']);
    const memory = await host.execute({ id: '3', name: 'store_memory', args: {} }, ctx) as { entries: Array<{ id: string }> };
    const ids = memory.entries.map(entry => entry.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    const off = createReadToolHost({ db, repository: null, github: null });
    expect(await off.execute({ id: '4', name: 'store_context', args: {} }, ctx)).not.toHaveProperty('registry');
    await expect(off.execute({ id: '5', name: 'store_memory', args: {} }, ctx)).rejects.toThrow(/tool_not_allowlisted/);
  });

  it('consigne answer : inchangée sans continuité ; élargie avec passation au format Fait / Reste / Appris', () => {
    expect(continuityEnabled({})).toBe(false);
    expect(continuityEnabled({ AGENT_RUN_CONTINUITY: 'TRUE' })).toBe(false);
    expect(continuityEnabled({ AGENT_RUN_CONTINUITY: 'true' })).toBe(true);
    expect(answerPrompt('c', 42, false)).toContain('since_seq 41, limit 1');
    const wide = answerPrompt('c', 42, true);
    expect(wide).toContain('since_seq ' + (42 - ANSWER_READ_WINDOW) + ', limit ' + ANSWER_READ_WINDOW);
    expect(wide).toContain('store_continuity');
    expect(wide).toContain('Fait / Reste / Appris');
    expect(answerPrompt('c', 5, true)).toContain('since_seq 0,');
  });

  it('câblage engineFor : continuité seulement si AGENT_RUN_CONTINUITY = true', () => {
    const base = { AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: { run: async () => ({}) } as never };
    expect(engineFor(base, db)('r').tools.list('answer')).not.toContain('store_memory');
    expect(engineFor({ ...base, AGENT_RUN_CONTINUITY: 'true' }, db)('r').tools.list('answer')).toContain('store_memory');
  });
});

describe('CC-7 L3 — collab_get_context rend « depuis ta dernière visite »', () => {
  it('participant enregistré : since_last_visit conforme au schéma de sortie', async () => {
    const { cycle, pa, newRun } = await seed();
    const client = 'cc7l3-client-' + key;
    await registerParticipant(db, { participant_id: pa, display_label: pa, proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: pa, proof: OWNER_PROOF, op: 'map-' + client });
    const handler = await collabToolHandler(db, 'collab_get_context', client);
    const result = await handler({ cycle });
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const body = z.object(outputSchemas.collab_get_context).parse(JSON.parse(result.content[0].text));
    expect(body.since_last_visit?.api_runs.map(r => r.run_id)).toEqual([newRun]);
    expect(body.since_last_visit?.handovers.map(n => n.done)).toEqual(['note du chat']);
  });
});

describe('CC8 WorkSession — récupération paginée du contexte', () => {
  it('relit les notes anciennes au-delà de la fenêtre de cinq', async () => {
    const { cycle, pa } = await seed();
    for (let i = 0; i < 13; i += 1) {
      await event(cycle, { type: 'checkpoint', participant: pa, role: 'api-agent', at: 400 + i, payload: handover('histoire-' + i) });
    }
    const first = await loadContinuity(db, cycle, [pa], { page: 0, pageSize: 5 });
    const second = await loadContinuity(db, cycle, [pa], { page: 1, pageSize: 5 });
    const third = await loadContinuity(db, cycle, [pa], { page: 2, pageSize: 5 });
    expect(first.next_page).toBe(1);
    expect(second.next_page).toBe(2);
    expect(third.handovers.some(note => note.done === 'histoire-0')).toBe(true);
    expect(new Set([...first.handovers, ...second.handovers, ...third.handovers].map(n => n.seq)).size).toBe(14);
    expect(third.next_page).toBeNull();
  });

  it('relit la mémoire C4 visible au-delà de quarante entrées et cache celle des tiers', async () => {
    const { pa, pb, newRun } = await seed();
    const inserted = [];
    for (let i = 0; i < 47; i += 1) {
      const id = uid('mem');
      inserted.push(id);
      await db.prepare(
        "INSERT INTO memory_entries (id, version, scope, kind, text, confidence, status, author_pid) VALUES (?1, 1, ?2, 'lesson', 'test', 'observed', 'active', ?3)"
      ).bind(id, 'participant:' + pa, pa).run();
    }
    const foreign = uid('foreign');
    await db.prepare(
      "INSERT INTO memory_entries (id, version, scope, kind, text, confidence, status, author_pid) VALUES (?1, 1, ?2, 'lesson', 'secret', 'observed', 'active', ?3)"
    ).bind(foreign, 'participant:' + pb, pb).run();
    const host = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const received: string[] = [];
    let page = 0;
    while (page < 20) {
      const result = await host.execute({ id: 'page-' + page, name: 'store_memory', args: { page, limit: 20 } },
        { run_id: newRun }) as { entries: Array<{ id: string }>; next_page: number | null };
      received.push(...result.entries.map(entry => entry.id));
      if (result.next_page === null) break;
      page = result.next_page;
    }
    expect(received.length).toBeGreaterThanOrEqual(47);
    expect(new Set(received).size).toBe(received.length);
    for (const id of inserted) expect(received).toContain(id);
    expect(received).not.toContain(foreign);
    expect(page).toBeGreaterThan(0);
  });
});

describe('CC8 WorkSession — active_work sans fenêtre historique cachée', () => {
  it('chat MCP et agent API relisent les mêmes checkpoints paginés après plus de 50 événements', async () => {
    const { cycle, pa, pb, newRun } = await seed();
    for (let i = 0; i < 76; i++) {
      await event(cycle, { type: 'checkpoint', participant: pa, role: i % 2 === 0 ? 'api-agent' : 'author',
        at: 1_000 + i, payload: { task: 'task-' + (i % 13), state: 'progress-' + i } });
    }
    await event(cycle, { type: 'checkpoint', participant: pb, role: 'author', at: 2_000,
      payload: { task: 'private-foreign', summary: 'never surface' } });
    const client = uid('activework-client');
    await registerParticipant(db, { participant_id: pa, display_label: pa, proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: pa, proof: OWNER_PROOF, op: 'map-' + client });
    const chat = await collabToolHandler(db, 'collab_get_context', client);
    const api = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const chatIds: number[] = [], apiIds: number[] = [];
    for (let page = 0; page < 3; page++) {
      const args = { active_work_checkpoint_page: page, active_work_page_size: 5 };
      const fromChat = await chat({ cycle, ...args });
      expect(fromChat.isError, fromChat.content[0]?.text).toBeFalsy();
      const chatBody = z.object(outputSchemas.collab_get_context).parse(JSON.parse(fromChat.content[0].text));
      const fromApi = await api.execute({ id: 'aw-' + page, name: 'store_context', args }, { run_id: newRun })
        as { active_work: { last_checkpoints: Array<{ seq: number; task: string | null }>; next_page: { last_checkpoints: number | null } } };
      const chatWork = chatBody.active_work!;
      chatIds.push(...chatWork.last_checkpoints.map(x => x.seq));
      apiIds.push(...fromApi.active_work.last_checkpoints.map(x => x.seq));
      expect(fromApi.active_work.next_page.last_checkpoints).toBe(chatWork.next_page.last_checkpoints);
    }
    expect(chatIds).toEqual(apiIds);
    // 13 task-specific latest checkpoints plus the original taskless handover.
    expect(chatIds).toHaveLength(14);
    expect(new Set(chatIds).size).toBe(14);
  });

  it('les exécutions API ouvertes restent consultables après la cinquième sur les deux canaux', async () => {
    const { cycle, pa, pb, newRun } = await seed();
    const expected: string[] = [];
    for (let i = 0; i < 8; i++) {
      const runId = uid('open');
      const created = await createRun(db, { runId, cycleId: cycle, participantId: pa,
        taskId: 'long-' + i, taskKind: 'answer', prompt: 'continuité', maxSteps: -1,
        maxTokens: -1, maxCostCents: 0, deadlineAt: 4_000, now: 3_000 + i });
      expect(created.created).toBe(true);
      expected.push(runId);
    }
    await createRun(db, { runId: uid('foreign'), cycleId: cycle, participantId: pb,
      taskId: 'private', taskKind: 'answer', prompt: 'other', maxSteps: -1,
      maxTokens: -1, maxCostCents: 0, deadlineAt: 4_000, now: 3_500 });
    const client = uid('activework-run-client');
    await registerParticipant(db, { participant_id: pa, display_label: pa, proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: pa, proof: OWNER_PROOF, op: 'map-' + client });
    const chat = await collabToolHandler(db, 'collab_get_context', client);
    const api = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const allRuns: string[] = [];
    for (let page = 0; page < 2; page++) {
      const args = { active_work_run_page: page, active_work_page_size: 5 };
      const mc = await chat({ cycle, ...args });
      expect(mc.isError, mc.content[0]?.text).toBeFalsy();
      const chatBody = z.object(outputSchemas.collab_get_context).parse(JSON.parse(mc.content[0].text));
      const fromApi = await api.execute({ id: 'work-' + page, name: 'store_context', args }, { run_id: newRun })
        as { active_work: { open_api_runs: Array<{run_id: string}>; next_page: {open_api_runs: number | null} } };
      expect(fromApi.active_work.open_api_runs).toEqual(chatBody.active_work!.open_api_runs);
      allRuns.push(...fromApi.active_work.open_api_runs.map(row => row.run_id));
    }
    expect(allRuns).toHaveLength(8);
    expect(new Set(allRuns)).toEqual(new Set(expected));
  });
});

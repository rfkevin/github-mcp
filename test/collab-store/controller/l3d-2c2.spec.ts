import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { nextActors, type ControllerSnapshot, type TaskFacts } from '../../../src/collab-store/controller/rules';
import { latestCorrections } from '../../../src/collab-store/controller/snapshot';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
import { relayMessage } from '../../../src/collab-store/controller/relay';
import { requestCorrection, type CorrectionInput } from '../../../src/collab-store/controller/corrections';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { countEvents, insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 l3d (incrément 2c-2) — demande de correction ciblée du coordinateur (correction.request).
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);

function task(overrides: Partial<TaskFacts> = {}): TaskFacts {
  return { task_id: 't1', status: 'accepted', revision: 1, owner: 'vibe', reviewer: 'grok', tester: 'claude', dependencies: [],
    submission: null, verdicts: [], ...overrides };
}
function snapshot(tasks: TaskFacts[]): ControllerSnapshot {
  return { cycle_id: 'c', revision: 7, phase: 'P6', halted: false, auto_advance: 'none', outputs_satisfied: false, tasks };
}
const positives = [
  { participant: 'grok', verdict: 'positive' as const, head: HEAD, base: BASE, seq: 11 },
  { participant: 'claude', verdict: 'positive' as const, head: HEAD, base: BASE, seq: 12 },
];

describe('CC-5 l3d 2c-2 — règles : correction ouverte', () => {
  it('sans soumission : l\'auteur reçoit address_correction à la place de implement', () => {
    const { decisions } = nextActors(snapshot([task({ correction: { seq: 5, items: 2 } })]));
    expect(decisions).toMatchObject([{ actor: 'vibe', action: 'address_correction', rule: 'correction-requested', subject: 'corr#5' }]);
    expect(decisions[0].reason).toContain('2 corrections ciblées');
  });

  it('après une soumission : correction + relecture/test toujours réveillés, jamais merge_ready ni address_feedback', () => {
    const pending = nextActors(snapshot([task({ submission: { head: HEAD, base: BASE, seq: 10 }, correction: { seq: 15, items: 1 } })])).decisions;
    expect(pending.map(d => [d.actor, d.action]).sort()).toEqual([['claude', 'test'], ['grok', 'review'], ['vibe', 'address_correction']]);
    const twoPositive = nextActors(snapshot([task({ submission: { head: HEAD, base: BASE, seq: 10 }, verdicts: positives, correction: { seq: 15, items: 1 } })])).decisions;
    expect(twoPositive.map(d => d.action)).toEqual(['address_correction']); // merge_ready retenu tant que la demande est ouverte
    const negative = nextActors(snapshot([task({ submission: { head: HEAD, base: BASE, seq: 10 },
      verdicts: [{ participant: 'grok', verdict: 'negative', head: HEAD, base: BASE, seq: 11 }], correction: { seq: 15, items: 1 } })])).decisions;
    expect(negative.some(d => d.action === 'address_feedback')).toBe(false);
  });

  it('nouvelle soumission après la demande : la correction est close, règles habituelles', () => {
    const { decisions } = nextActors(snapshot([task({ submission: { head: HEAD2, base: BASE, seq: 20 }, correction: { seq: 15, items: 1 } })]));
    expect(decisions.map(d => d.action).sort()).toEqual(['review', 'test']);
    const merged = nextActors(snapshot([task({ submission: { head: HEAD, base: BASE, seq: 20 },
      verdicts: positives.map(v => ({ ...v, seq: v.seq + 20 })), correction: { seq: 15, items: 1 } })])).decisions;
    expect(merged).toMatchObject([{ kind: 'merge_ready' }]);
  });

  it('épisode : la demande réarme les clés ; sans demande, l\'épisode est inchangé (pas de rejournalisation)', () => {
    const plain = nextActors(snapshot([task()])).decisions[0];
    expect(plain.episode).toBe('r1:s0:v0,0');
    expect(nextActors(snapshot([task({ correction: null })])).decisions[0].episode).toBe('r1:s0:v0,0');
    expect(nextActors(snapshot([task({ correction: { seq: 5, items: 1 } })])).decisions[0].episode).toBe('r1:s0:v0,0:c5');
  });

  it('tâche terminée ou bloquée : aucune demande de correction réveillée', () => {
    for (const status of ['done', 'verified', 'blocked']) {
      expect(nextActors(snapshot([task({ status, correction: { seq: 5, items: 1 } })])).decisions).toEqual([]);
    }
  });

  it('latestCorrections : dernière demande par tâche, payload illisible ou sans point ignoré', () => {
    const map = latestCorrections([
      { seq: 3, payload_json: JSON.stringify({ task: 't1', items: ['a'] }) },
      { seq: 9, payload_json: JSON.stringify({ task: 't1', items: ['a', 'b'] }) },
      { seq: 7, payload_json: JSON.stringify({ task: 't2', items: [] }) },
      { seq: 8, payload_json: '{' },
    ]);
    expect(Object.fromEntries(map)).toEqual({ t1: { seq: 9, items: 2 } });
  });

  it('message à relayer lisible', () => {
    const decision = nextActors(snapshot([task({ correction: { seq: 5, items: 1 } })])).decisions[0];
    expect(relayMessage('c', 'Vibe', decision)).toContain('Vibe — traiter la demande de correction du coordinateur t1 (cycle c)');
  });
});

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => (label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return (error as { code?: string }).code ?? 'UNKNOWN'; }
  return 'NO_ERROR';
}

interface World { cycle: string; holder: string; author: string; other: string; rev: number }

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
}

async function world(): Promise<World> {
  await ensureSchema(db);
  const tag = uniq('w');
  const [holder, author, other] = ['ch', 'ca', 'co'].map(p => p + '-' + tag);
  for (const pid of [holder, author, other]) await registerParticipant(db, { participant_id: pid, display_label: pid, proof, op: uniq('reg') });
  const cycle = uniq('corr');
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 't0', cycle, owner: author, reviewer: other, tester: holder });
  await appointCycleCoordinator(db, { cycleId: cycle, participantId: holder, familyId: holder, expectedEpoch: 0, proof, op: uniq('appoint') });
  return { cycle, holder, author, other, rev: await revision(cycle) };
}

let opN = 0;
function input(w: World, extra: Partial<CorrectionInput> = {}, who = w.holder): CorrectionInput {
  return { cycle_id: w.cycle, participant_id: who, task_id: 't0', items: ['Couvrir le cas HALT pendant le lot.'],
    reason: 'Revue croisée du contrôleur.', expected_revision: w.rev, op_id: who + ':' + w.cycle + ':corr:' + (++opN), ...extra };
}

describe('CC-5 l3d 2c-2 — requestCorrection (D1)', () => {
  it('le coordinateur mandaté dépose la demande : événement serveur, révision +1, l\'auteur la voit dans collab_next_actions', async () => {
    const w = await world();
    const out = await requestCorrection(db, input(w, { items: ['Point A', 'Point B'] }));
    expect(out).toMatchObject({ status: 'applied', revision: w.rev + 1, task_id: 't0', items: 2 });
    const event = (await db.prepare('SELECT type, participant_id, role, payload_json FROM events WHERE seq = ?1').bind(out.event_seq)
      .first<{ type: string; participant_id: string; role: string; payload_json: string }>())!;
    expect(event).toMatchObject({ type: 'correction.request', participant_id: w.holder, role: 'coordinator' });
    expect(JSON.parse(event.payload_json)).toMatchObject({ task: 't0', items: ['Point A', 'Point B'], reason: 'Revue croisée du contrôleur.', mandate_epoch: 1 });
    expect(await revision(w.cycle)).toBe(w.rev + 1);
    const view = await previewNextActions(db, w.cycle, w.author);
    expect(view.mine).toMatchObject([{ action: 'address_correction', subject: 'corr#' + out.event_seq }]);
  });

  it('rejeu : duplicate sans seconde écriture ; même op_id, autres points → IDEMPOTENCY_CONFLICT', async () => {
    const w = await world();
    const first = input(w);
    const a = await requestCorrection(db, first);
    expect(await requestCorrection(db, first)).toMatchObject({ status: 'duplicate', event_seq: a.event_seq });
    expect(await codeOf(requestCorrection(db, { ...first, items: ['Autre chose'] }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countEvents(db, w.cycle, 'correction.request')).toBe(1);
  });

  it('réservé au titulaire du mandat : un autre participant, ou après vacance → CORRECTION_FORBIDDEN, rien écrit', async () => {
    const w = await world();
    expect(await codeOf(requestCorrection(db, input(w, {}, w.other)))).toBe('CORRECTION_FORBIDDEN');
    await appointCycleCoordinator(db, { cycleId: w.cycle, participantId: null, familyId: null, expectedEpoch: 1, proof, op: uniq('vacancy') });
    expect(await codeOf(requestCorrection(db, input(w, { expected_revision: await revision(w.cycle) })))).toBe('CORRECTION_FORBIDDEN');
    expect(await countEvents(db, w.cycle, 'correction.request')).toBe(0);
  });

  it('entrées et état : tâche inconnue, terminée, points invalides, révision périmée, op_id d\'un autre → refus, rien écrit', async () => {
    const w = await world();
    expect(await codeOf(requestCorrection(db, input(w, { task_id: 'nope' })))).toBe('TASK_UNKNOWN');
    for (const items of [[], Array.from({ length: 11 }, (_, i) => 'p' + i), ['  '], ['x'.repeat(301)]]) {
      expect(await codeOf(requestCorrection(db, input(w, { items })))).toBe('CORRECTION_INVALID');
    }
    expect(await codeOf(requestCorrection(db, input(w, { expected_revision: w.rev + 50 })))).toBe('STALE');
    expect(await codeOf(requestCorrection(db, input(w, { op_id: w.other + ':' + w.cycle + ':corr:1' })))).toBe('INVALID_OP_ID');
    await db.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1 AND task_id = 't0'").bind(w.cycle).run();
    expect(await codeOf(requestCorrection(db, input(w)))).toBe('TASK_CLOSED');
    expect(await countEvents(db, w.cycle, 'correction.request')).toBe(0);
  });

  it('course : tâche terminée entre les vérifications et le lot d\'écriture → CORRECTION_PRECONDITION_FAILED, rien écrit', async () => {
    const w = await world();
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            // Seul le lot d'écriture (5 instructions) est visé : les lots d'amorçage du schéma passent AVANT les vérifications.
            if (statements.length === 5) {
              await target.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1 AND task_id = 't0'").bind(w.cycle).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await codeOf(requestCorrection(racing, input(w)))).toBe('CORRECTION_PRECONDITION_FAILED');
    expect(await revision(w.cycle)).toBe(w.rev);
    expect(await countEvents(db, w.cycle, 'correction.request')).toBe(0);
  });

  it('un agent ne peut pas forger correction.request par collab_append_event', async () => {
    const w = await world();
    expect(await codeOf(new CollabStore(db).appendEvent({ cycle_id: w.cycle, type: 'correction.request' as never, participant_id: w.holder,
      expected_rev: w.rev, payload_json: JSON.stringify({ task: 't0', items: ['x'] }), op_id: w.holder + ':' + w.cycle + ':forge:1' })))
      .toBe('UNKNOWN_EVENT_TYPE');
    expect(await countEvents(db, w.cycle, 'correction.request')).toBe(0);
  });
});

describe('CC-5 l3d 2c-2 — outil MCP collab_request_correction', () => {
  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
  type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

  async function tool(clientId: string): Promise<ToolHandler> {
    const { registerCollabStoreTools } = await import('../../../src/collab-store/mcp/tools');
    const { createCollabToolContext } = await import('../../../src/collab-store/mcp/context');
    const context = createCollabToolContext({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' }, 'agent:x', ['collab:'], {}, clientId);
    let handler: ToolHandler | null = null;
    registerCollabStoreTools({ registerTool(name: string, _spec: unknown, h: ToolHandler) { if (name === 'collab_request_correction') handler = h; } } as never, context);
    return handler!;
  }

  it('identité issue du jeton : le coordinateur mandaté demande ; un client non associé est refusé', async () => {
    const { mapClient } = await import('../../../src/collab-store/owner/decisions');
    const w = await world();
    const client = uniq('client');
    await mapClient(db, { oauth_client_id: client, participant_id: w.holder, proof, op: uniq('map') });
    const ok = await (await tool(client))({ cycle: w.cycle, expected_rev: w.rev, task: 't0', items: ['Point A'], op_id: w.holder + ':' + w.cycle + ':corr:1' });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text)).toMatchObject({ status: 'applied', task_id: 't0', items: 1 });
    const denied = await (await tool(uniq('unknown')))({ cycle: w.cycle, expected_rev: w.rev + 1, task: 't0', items: ['Point A'], op_id: 'x:' + w.cycle + ':corr:1' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('non associé');
  });
});

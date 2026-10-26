import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost, createStoreWriteTools, runStep, ToolRefused, type ModelOutput } from '../../../src/collab-store/agentrun';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { uniqueIds } from '../coordinator-helpers';

// CC-7 L3 (incrément 2) — proposition de mémoire C4 par le canal API (parité S4) : candidate seulement,
// scope personnel par défaut, jamais le scope d'autrui ni un kind protégé ; porte continuité requise.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('cc7l3b');
const T = 1_980_000_000;
const KEY = (c: string) => c.repeat(64);

async function seedRun(phase = 'P6') {
  await ensureSchema(db);
  const cycle = uid('c');
  const participant = uid('p');
  await insertCycleRow(db, cycle, phase);
  await insertPhaseDefinition(db, cycle, phase, []);
  await insertTaskRow(db, { taskId: 'l3', cycle, owner: participant, reviewer: uid('r'), tester: uid('t') });
  const runId = uid('run');
  const created = await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: 'l3', taskKind: 'answer', prompt: 'p',
    maxSteps: 6, maxTokens: 24_000, maxCostCents: 0, deadlineAt: T + 900, now: T });
  expect(created.created).toBe(true);
  return { cycle, participant, runId };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRefused);
    return (error as Error).message;
  }
  throw new Error('refus attendu');
}

const memoryRows = (scope: string) => db.prepare('SELECT id, scope, kind, status, author_pid, confidence FROM memory_entries WHERE scope = ?1')
  .bind(scope).all<{ id: string; scope: string; kind: string; status: string; author_pid: string; confidence: string }>();

describe('CC-7 L3b — store_memory_propose : exposition', () => {
  it('seulement avec écritures store ET continuité, pour les types connus, effet write', () => {
    const both = createReadToolHost({ db, repository: null, github: null, storeWrites: true, continuity: true });
    expect(both.list('answer')).toContain('store_memory_propose');
    expect(both.list('research')).toContain('store_memory_propose');
    expect(both.spec('answer', 'store_memory_propose')).toEqual({ name: 'store_memory_propose', effect: 'write' });
    expect(both.list('fix')).toEqual([]);
    expect(createReadToolHost({ db, repository: null, github: null, storeWrites: true }).list('answer')).not.toContain('store_memory_propose');
    expect(createReadToolHost({ db, repository: null, github: null, continuity: true }).list('answer')).not.toContain('store_memory_propose');
    const schema = both.schemas('answer').find(s => s.name === 'store_memory_propose')!;
    const kinds = (schema.parameters as { properties: { kind: { enum: string[] } } }).properties.kind.enum;
    expect(kinds).not.toContain('decision');
    expect(kinds).not.toContain('invariant');
  });
});

describe('CC-7 L3b — store_memory_propose : écriture', () => {
  it('scope personnel par défaut : candidate de l’auteur de l’exécution, rejeu idempotent, lookup', async () => {
    const { cycle, participant, runId } = await seedRun();
    const tools = createStoreWriteTools(db);
    const call = { id: 'm', name: 'store_memory_propose', args: { text: 'Lire le registre avant de répondre.', kind: 'lesson' } };
    const ctx = { run_id: runId, effect_key: KEY('d') };
    expect(await tools.lookup(call, ctx)).toEqual({ found: false });
    const first = await tools.execute(call, ctx) as { seq: number; type: string; status: string };
    expect(first).toMatchObject({ type: 'memory.propose', status: 'applied' });
    expect((await tools.execute(call, ctx) as { seq: number; status: string })).toMatchObject({ seq: first.seq, status: 'duplicate' });
    expect(await tools.lookup(call, ctx)).toEqual({ found: true, result: { seq: first.seq, type: 'memory.propose', status: 'duplicate' } });
    const rows = (await memoryRows('participant:' + participant)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'lesson', status: 'candidate', author_pid: participant, confidence: 'hypothesis' });
    const event = await db.prepare("SELECT role, participant_id FROM events WHERE cycle_id = ?1 AND type = 'memory.propose'").bind(cycle)
      .first<{ role: string; participant_id: string }>();
    expect(event).toEqual({ role: 'api-agent', participant_id: participant });
  });

  it('scope partagé autorisé (candidate, confiance observed, références), via le moteur réel', async () => {
    const { runId } = await seedRun();
    const role = 'role:' + uid('role').replace(/[^A-Za-z0-9_-]/g, '');
    const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true, continuity: true });
    const outputs: ModelOutput[] = [
      { text: '', tool_calls: [{ id: 'a', name: 'store_memory_propose', args: { text: 'Le pool Workers AI est partagé.', kind: 'fact',
        scope: role, confidence: 'observed', evidence_refs: ['store seq 839'] } }] },
      { text: 'Fait / Reste / Appris', tool_calls: [] },
    ];
    let i = 0;
    const deps = { model: { async complete() { return { output: outputs[i++], usage: { tokens: 10, cost_cents: 0 } }; } }, tools: host, now: () => T, workerId: 'w' };
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    const rows = (await memoryRows(role)).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fact', status: 'candidate', confidence: 'observed' });
  });

  it('refus certains avant toute écriture : kind protégé, scope d’autrui, confiance, texte, références', async () => {
    const { participant, runId } = await seedRun();
    const tools = createStoreWriteTools(db);
    const ctx = { run_id: runId, effect_key: KEY('e') };
    const propose = (args: Record<string, unknown>) => tools.execute({ id: 'x', name: 'store_memory_propose', args }, ctx);
    expect(await refusal(propose({ text: 't', kind: 'decision' }))).toMatch(/kind/);
    expect(await refusal(propose({ text: 't', kind: 'invariant' }))).toMatch(/kind/);
    expect(await refusal(propose({ text: 't', kind: 'fact', scope: 'participant:autre' }))).toMatch(/scope/);
    expect(await refusal(propose({ text: 't', kind: 'fact', scope: 'participant:' + participant }))).toMatch(/scope/);
    expect(await refusal(propose({ text: 't', kind: 'fact', confidence: 'verified' }))).toMatch(/confidence/);
    expect(await refusal(propose({ text: 'x'.repeat(1001), kind: 'fact' }))).toMatch(/text/);
    expect(await refusal(propose({ text: 't', kind: 'fact', evidence_refs: [] }))).toMatch(/evidence_refs/);
    expect(await refusal(propose({ text: 't', kind: 'fact', evidence_refs: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toMatch(/evidence_refs/);
    expect((await memoryRows('participant:' + participant)).results).toHaveLength(0);
  });

  it('refus typé du store traduit en refus certain (cycle clos : rien n’est écrit)', async () => {
    const { cycle, participant, runId } = await seedRun();
    await db.prepare("UPDATE cycles SET status = 'closed' WHERE cycle_id = ?1").bind(cycle).run();
    const tools = createStoreWriteTools(db);
    const message = await refusal(tools.execute({ id: 'x', name: 'store_memory_propose', args: { text: 't', kind: 'fact' } },
      { run_id: runId, effect_key: KEY('f') }));
    expect(message).toBe('CYCLE_CLOSED');
    expect((await memoryRows('participant:' + participant)).results).toHaveLength(0);
  });
});

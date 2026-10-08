import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import stateR6 from './fixtures/cc3-state-r6.md?raw';
import { exportCycleState, type StateExport } from '../../../src/collab-store/export/state-export';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { importState, PROOF, registerCc3 } from './helpers';

// CC-3 F4 (audit github-mcp#79, A04) — un export est un instantané cohérent du store :
// une écriture concurrente (append de tâche, evidence.add, import owner, registre) tombe
// entièrement avant ou entièrement après, jamais entre deux lectures de l'export.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const uniq = (label: string) => 'f4-' + label + '-' + Date.now().toString(36) + '-' + (++n);

beforeAll(async () => {
  await ensureSchema(db);
  await registerCc3(db, 'f4-snapshot');
});

async function append(cycle: string, participant: string, type: string, payload: unknown) {
  const store = new CollabStore(db);
  const outcome = await store.appendEvent({
    cycle_id: cycle, type: type as never, participant_id: participant,
    expected_rev: await store.currentRevision(cycle), op_id: participant + ':' + cycle + ':w' + (++n) + ':1',
    payload_json: JSON.stringify(payload),
  });
  expect(outcome.status, JSON.stringify(outcome)).toBe('applied');
}

/**
 * D1 proxy that runs one concurrent write at EVERY database call made by the
 * code under test (each first/all/run/raw and before and after each batch).
 * The queued `writes` run first; once the queue is dry, `tail()` keeps
 * producing fresh concurrent writes, so the interleaving never depends on how
 * many database calls ensureSchema makes at bootstrap (schema batches, PRAGMA
 * probes and the crash-safe backfill probe included; F3, review Sol).
 * At the start of a batch it also records, on the real database, the export a
 * reader would get at that exact point: the snapshot the batch must reflect.
 */
function interleaving(real: D1Database, writes: Array<() => Promise<void>>, tail: () => Promise<void>) {
  const state = { calls: 0, injected: 0, atBatch: [] as StateExport[] };
  const hook = async () => {
    state.calls += 1;
    const write = writes.shift() ?? tail;
    await write();
    state.injected += 1;
  };
  const unwrap = (stmt: D1PreparedStatement) => (stmt as unknown as { real?: D1PreparedStatement }).real ?? stmt;
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, {
    get(target, prop) {
      if (prop === 'real') return target;
      if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
        return async (...args: unknown[]) => {
          await hook();
          return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop);
    },
  });
  const proxy = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          await hook();
          state.atBatch.push(await exportCycleState(real, currentCycle));
          const result = await target.batch(stmts.map(unwrap));
          await hook();
          return result;
        };
      }
      if (prop === 'exec') {
        return async (sql: string) => {
          await hook();
          return target.exec(sql);
        };
      }
      return Reflect.get(target, prop);
    },
  });
  return { db: proxy as D1Database, state };
}
let currentCycle = '';

async function preparedCycle(label: string): Promise<string> {
  const cycle = uniq(label);
  currentCycle = cycle;
  expect((await importState(db, cycle, stateR6)).status).toBe('applied');
  await append(cycle, 'sol', 'task.status', { task: { task_id: 'C3', status: 'verified' } });
  return cycle;
}

/** What the export must be: one point of the store, with a cursor that covers exactly its content. */
function expectSinglePoint(result: StateExport, atBatch: StateExport[]): void {
  // ensureSchema may batch its DDL first; the snapshot read is the last batch of the export.
  expect(atBatch.length).toBeGreaterThan(0);
  expect(result).toEqual(atBatch[atBatch.length - 1]);
}

describe('CC-3 F4 / A04 — export = instantané cohérent', () => {
  it('append de tâche et evidence.add injectés entre chaque lecture : un seul point du store, last_seq exact', async () => {
    const cycle = await preparedCycle('append');
    const writes = [
      () => append(cycle, 'grok', 'task.status', { task: { task_id: 'C4', status: 'review' } }), // Grok owns C4 (F1/A08 roles)
      () => append(cycle, 'grok', 'evidence.add', { source: 'f4 injected 1', state: 'between reads' }),
      () => append(cycle, 'vibe', 'evidence.add', { source: 'f4 injected 2', state: 'between reads' }),
      () => append(cycle, 'sol', 'task.status', { task: { task_id: 'C3', status: 'accepted' } }),
      () => append(cycle, 'grok', 'evidence.add', { source: 'f4 injected 3', state: 'between reads' }),
      () => append(cycle, 'grok', 'evidence.add', { source: 'f4 injected 4', state: 'between reads' }),
    ];
    const { db: racing, state } = interleaving(db, writes, () =>
      append(cycle, 'grok', 'evidence.add', { source: 'f4 tail ' + (++n), state: 'tail write' }));
    const result = await exportCycleState(racing, cycle);
    expectSinglePoint(result, state.atBatch);
    // The test is not vacuous: writes really landed around the export, and the store moved on.
    expect(state.injected).toBeGreaterThanOrEqual(2);
    const after = await exportCycleState(db, cycle);
    expect(after.last_seq).toBeGreaterThan(result.last_seq);
    // Every evidence row rendered has a store seq ≤ last_seq; none beyond.
    for (const seq of [...result.content.matchAll(/store seq (\d+)/g)].map(m => Number(m[1]))) {
      expect(seq).toBeLessThanOrEqual(result.last_seq);
    }
  });

  it('import owner concurrent : jamais un document mêlant l’ancienne base et les nouvelles données', async () => {
    const cycle = await preparedCycle('import');
    // A re-import of a different merged state (revision 7) replaces base and tasks.
    const next = stateR6.replace(/^revision: 6$/m, 'revision: 7').replace(/^base_revision: \d+$/m, 'base_revision: 6')
      .replace('| C3 | review |', '| C3 | accepted |');
    expect(next).not.toBe(stateR6);
    const writes = [
      () => append(cycle, 'vibe', 'evidence.add', { source: 'f4 before import', state: 'x' }),
      async () => { await importState(db, cycle, next); },
      () => append(cycle, 'grok', 'evidence.add', { source: 'f4 after import', state: 'y' }),
    ];
    const { db: racing, state } = interleaving(db, writes, () =>
      append(cycle, 'grok', 'evidence.add', { source: 'f4 tail ' + (++n), state: 'tail write' }));
    const result = await exportCycleState(racing, cycle);
    expectSinglePoint(result, state.atBatch);
    // Base, overlay and cursor belong to the same import.
    const rev = Number(/^revision: (\d+)$/m.exec(result.content)?.[1]);
    expect(rev).toBe(result.state_revision);
    expect(result.imported.state_revision === 6 ? [6, 7] : [7, 8]).toContain(rev);
    if (result.imported.state_revision === 7) expect(result.content).not.toContain('f4 before import');
  });

  it('changement du registre pendant l’export : libellés et contenu du même instant', async () => {
    const cycle = await preparedCycle('registry');
    await append(cycle, 'claude', 'task.claim', { task: { task_id: 'F4X', owner_pid: 'claude', reviewer_pid: 'sol', tester_pid: 'grok',
      status: 'in_progress', owned_paths: ['src/collab-store/export/'], next_action: 'snapshot' } });
    const writes = [
      async () => { await registerParticipant(db, { participant_id: 'grok', display_label: 'Grok F4', proof: PROOF, op: uniq('relabel') }); },
      async () => { await registerParticipant(db, { participant_id: 'grok', display_label: 'Grok', proof: PROOF, op: uniq('restore') }); },
    ];
    let flip = false;
    const { db: racing, state } = interleaving(db, writes, async () => {
      flip = !flip;
      await registerParticipant(db, {
        participant_id: 'grok', display_label: flip ? 'Grok F4' : 'Grok', proof: PROOF, op: uniq('tail'),
      });
    });
    const result = await exportCycleState(racing, cycle);
    expectSinglePoint(result, state.atBatch);
  });

  it('last_seq est un curseur de reprise sûr : jamais au-delà d’un événement absent du document (revue Sol)', async () => {
    const cycle = await preparedCycle('cursor');
    const store = new CollabStore(db);
    // Only rendered kinds so far: the cursor is the snapshot point.
    const clean = await exportCycleState(db, cycle);
    expect(clean.last_seq).toBe(clean.snapshot_seq);

    // A proposal, a checkpoint and an owner.request are not rendered by CC-STATE-1 export.
    await append(cycle, 'sol', 'proposal.submit', { content: 'f4 proposal never rendered' });
    const proposalSeq = (await store.getDelta(cycle, clean.snapshot_seq)).events[0].seq;
    await append(cycle, 'grok', 'evidence.add', { source: 'f4 after proposal', state: 'rendered' });
    await append(cycle, 'vibe', 'checkpoint', { note: 'f4 checkpoint' });
    const result = await exportCycleState(db, cycle);
    expect(result.content).not.toContain('f4 proposal never rendered');
    expect(result.content).toContain('f4 after proposal');
    expect(result.last_seq).toBe(proposalSeq - 1);
    expect(result.snapshot_seq).toBeGreaterThan(result.last_seq);
    // Zero loss: resuming the delta from last_seq returns every event absent from the document.
    const { events } = await store.getDelta(cycle, result.last_seq, 500);
    const resumed = new Set(events.map(event => event.type));
    for (const type of ['proposal.submit', 'checkpoint']) expect(resumed.has(type)).toBe(true);
    expect(events.at(-1)?.seq).toBe(result.snapshot_seq);
  });
});

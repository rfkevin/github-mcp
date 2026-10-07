import { describe, expect, it } from 'vitest';
import type { TaskStatus } from '../../../src/collab-store/proto/store';
import { cycleId, freshStore, metric, percentile } from './helpers';

const task = (status: TaskStatus, nextAction = 'go') => ({ taskId: 'C0', status, ownerPid: 'p-claude', nextAction });

describe('C0 S1 — concurrent writes at the same revision', () => {
  it('exactly one success and one STALE with delta, 100/100 runs', async () => {
    const { store } = await freshStore();
    let pass = 0;
    for (let run = 0; run < 100; run += 1) {
      const id = cycleId('s1');
      await store.createCycle(id);
      const [a, b] = await Promise.all([
        store.append({ cycleId: id, expectedRev: 0, participantId: 'p-a', opId: `a-${run}`, type: 'task.upsert', payload: {}, task: task('in_progress', 'a') }),
        store.append({ cycleId: id, expectedRev: 0, participantId: 'p-b', opId: `b-${run}`, type: 'task.upsert', payload: {}, task: task('review', 'b') }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['applied', 'stale']);
      const stale = a.status === 'stale' ? a : b;
      const applied = a.status === 'applied' ? a : b;
      if (stale.status !== 'stale' || applied.status !== 'applied') throw new Error('unreachable');
      expect(stale.currentRev).toBe(1);
      expect(stale.delta.map((event) => event.idempotency_key)).toEqual([applied.event.idempotency_key]);
      expect(await store.currentRev(id)).toBe(1);
      pass += 1;
    }
    metric('S1_runs_passed', pass);
  });

  it('retry with the same op_id returns the original event and writes nothing', async () => {
    const { store } = await freshStore();
    const id = cycleId('idem');
    await store.createCycle(id);
    const input = { cycleId: id, expectedRev: 0, participantId: 'p-a', opId: 'op-1', type: 'task.upsert' as const, payload: {}, task: task('accepted') };
    const first = await store.append(input);
    const retry = await store.append(input);
    expect(first.status).toBe('applied');
    expect(retry.status).toBe('duplicate');
    if (first.status !== 'applied' || retry.status !== 'duplicate') throw new Error('unreachable');
    expect(retry.event.seq).toBe(first.event.seq);
    expect(await store.currentRev(id)).toBe(1);
    await expect(store.append({ ...input, opId: '' })).rejects.toThrow('OP_ID_REQUIRED');
  });

  it('records append latency p50/p95 (local Miniflare, indicative only)', async () => {
    const { store } = await freshStore();
    const id = cycleId('lat');
    await store.createCycle(id);
    const samples: number[] = [];
    for (let rev = 0; rev < 200; rev += 1) {
      const start = performance.now();
      const result = await store.append({ cycleId: id, expectedRev: rev, participantId: 'p-a', opId: `l-${rev}`, type: 'checkpoint', payload: { rev } });
      samples.push(performance.now() - start);
      expect(result.status).toBe('applied');
    }
    metric('append_ms_p50', percentile(samples, 50));
    metric('append_ms_p95', percentile(samples, 95));
  });
});

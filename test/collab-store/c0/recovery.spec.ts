import { describe, expect, it } from 'vitest';
import { ProtoStore, type TaskStatus } from '../../../src/collab-store/proto/store';
import { cycleId, freshStore, metric, prng, restoreDb } from './helpers';

const STATUSES: TaskStatus[] = ['proposed', 'accepted', 'in_progress', 'review', 'verified', 'done', 'blocked'];

describe('C0 S2 — crash mid-mutation', () => {
  it('a failing statement after the event insert rolls back the whole batch', async () => {
    const { db, store } = await freshStore();
    const id = cycleId('s2');
    await store.createCycle(id);
    const before = await db.prepare('SELECT COALESCE(SUM(writes), 0) AS w FROM quota_counters').first<{ w: number }>();
    await expect(store.append({ cycleId: id, expectedRev: 0, participantId: 'p-a', opId: 'crash', type: 'task.upsert',
      payload: {}, task: { taskId: 'C0', status: 'not-a-status' as TaskStatus, ownerPid: 'p-a', nextAction: 'x' } })).rejects.toThrow();
    expect(await store.currentRev(id)).toBe(0);
    expect(await store.delta(id, 0)).toEqual([]);
    const tasks = await db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1').bind(id).first<{ n: number }>();
    expect(tasks?.n).toBe(0);
    const after = await db.prepare('SELECT COALESCE(SUM(writes), 0) AS w FROM quota_counters').first<{ w: number }>();
    expect(after?.w).toBe(before?.w);
    // The same op_id can be retried after the failure: nothing was recorded.
    const retry = await store.append({ cycleId: id, expectedRev: 0, participantId: 'p-a', opId: 'crash', type: 'task.upsert',
      payload: {}, task: { taskId: 'C0', status: 'accepted', ownerPid: 'p-a', nextAction: 'x' } });
    expect(retry.status).toBe('applied');
  });
});

describe('C0 S3 + S6 — replay and export/re-import', () => {
  it('replayed state equals materialized state, and survives export → empty DB → import', async () => {
    const { store } = await freshStore();
    const id = cycleId('s3');
    await store.createCycle(id);
    const random = prng(42);
    for (let rev = 0; rev < 200; rev += 1) {
      const taskId = `T${Math.floor(random() * 12)}`;
      const status = STATUSES[Math.floor(random() * STATUSES.length)];
      const result = await store.append({ cycleId: id, expectedRev: rev, participantId: `p-${rev % 5}`, opId: `r-${rev}`,
        type: rev % 4 === 0 ? 'checkpoint' : 'task.upsert', payload: { rev },
        task: rev % 4 === 0 ? undefined : { taskId, status, ownerPid: `p-${rev % 5}`, nextAction: `step ${rev}` } });
      expect(result.status).toBe('applied');
    }
    const materialized = await store.stateHash(id);
    expect(await store.replayHash(id)).toBe(materialized);
    metric('S3_events', 200);

    const exported = await store.exportCycle(id);
    const target = await restoreDb();
    await ProtoStore.importCycle(target, exported);
    const restored = new ProtoStore(target, { dailyWriteLimit: 100_000 });
    expect(await restored.stateHash(id)).toBe(materialized);
    expect(await restored.replayHash(id)).toBe(materialized);
    metric('S6_hash_equal', true);

    const gap = { cycleId: cycleId('gap'), events: exported.events.filter((event) => event.rev !== 7) };
    await expect(ProtoStore.importCycle(target, gap)).rejects.toThrow('EXPORT_GAP');
  });
});

describe('C0 quota guard', () => {
  it('fails closed with an explicit status and writes nothing once the daily limit is reached', async () => {
    const day = new Date('2031-01-01T10:00:00Z');
    const { db } = await freshStore();
    const store = new ProtoStore(db, { dailyWriteLimit: 3, now: () => day });
    const id = cycleId('quota');
    await store.createCycle(id);
    for (let rev = 0; rev < 3; rev += 1) {
      expect((await store.append({ cycleId: id, expectedRev: rev, participantId: 'p', opId: `q-${rev}`, type: 'note', payload: {} })).status).toBe('applied');
    }
    const blocked = await store.append({ cycleId: id, expectedRev: 3, participantId: 'p', opId: 'q-3', type: 'note', payload: {} });
    expect(blocked).toEqual({ status: 'quota_exhausted', day: '2031-01-01', limit: 3 });
    expect(await store.currentRev(id)).toBe(3);
    expect((await store.delta(id, 3)).length).toBe(0);
  });
});

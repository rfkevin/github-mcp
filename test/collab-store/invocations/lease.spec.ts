import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { InvocationService } from '../../../src/collab-store/invocations';
import { enqueue, uniqueCycle } from './helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC-4 A1 — invocation leases and recovery', () => {
  it('two concurrent lease attempts produce exactly one lease and one attempt', async () => {
    const cycle = uniqueCycle('lease-race');
    const { invocation } = await enqueue(db, cycle);
    let now = 1_800_000_000;
    const service = new InvocationService(db, { now: () => new Date(now * 1000) });
    const outcomes = await Promise.all([
      service.lease(invocation.wake_key, 'worker-a', 30),
      service.lease(invocation.wake_key, 'worker-b', 30),
    ]);
    expect(outcomes.filter(item => item.status === 'leased')).toHaveLength(1);
    expect(outcomes.filter(item => item.status === 'busy')).toHaveLength(1);
    const current = await service.getByWakeKey(invocation.wake_key);
    expect(current?.attempt_count).toBe(1);
    const attempts = await db.prepare('SELECT COUNT(*) AS n FROM invocation_attempts WHERE invocation_id = ?1')
      .bind(invocation.invocation_id).first<{ n: number }>();
    expect(attempts?.n).toBe(1);
    // Keep the shared D1 fixture clean for the reconciliation test below:
    // finish the winning lease instead of leaving unrelated expired work behind.
    const winner = current?.lease_owner;
    expect(winner).toMatch(/^worker-[ab]$/);
    await service.markRunning(invocation.wake_key, winner!);
    await service.succeed(invocation.wake_key, winner!, 'race-complete');
  });

  it('expired lease is recoverable once, then the second consecutive expiry stops retries', async () => {
    const cycle = uniqueCycle('expiry');
    const { invocation } = await enqueue(db, cycle);
    let now = 1_800_001_000;
    const service = new InvocationService(db, { now: () => new Date(now * 1000) });

    expect((await service.lease(invocation.wake_key, 'worker-a', 10)).status).toBe('leased');
    await service.markRunning(invocation.wake_key, 'worker-a');
    now += 11;
    expect(await service.reconcileExpired()).toBe(1);
    let current = await service.getByWakeKey(invocation.wake_key);
    expect(current).toMatchObject({ state: 'expired', attempt_count: 1, consecutive_failures: 1, last_error: 'lease_expired' });

    expect((await service.lease(invocation.wake_key, 'worker-b', 10)).status).toBe('leased');
    await service.markRunning(invocation.wake_key, 'worker-b');
    now += 11;
    expect(await service.reconcileExpired()).toBe(1);
    current = await service.getByWakeKey(invocation.wake_key);
    expect(current).toMatchObject({ state: 'failed', attempt_count: 2, consecutive_failures: 2, last_error: 'lease_expired' });
    expect((await service.lease(invocation.wake_key, 'worker-c', 10)).status).toBe('terminal');
    expect((await service.getByWakeKey(invocation.wake_key))?.attempt_count).toBe(2);
  });
});

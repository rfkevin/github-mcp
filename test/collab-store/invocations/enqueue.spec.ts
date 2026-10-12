import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { invocationIntent, sourceEvent, uniqueCycle } from './helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function counts(cycle: string) {
  await ensureSchema(db);
  const events = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  const invocations = await db.prepare('SELECT COUNT(*) AS n FROM invocations WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  return { events: events?.n ?? 0, invocations: invocations?.n ?? 0 };
}

describe('CC-4 A1 — transactional invocation outbox', () => {
  it('double delivery with a different op_id returns the same invocation and writes once', async () => {
    const cycle = uniqueCycle('double');
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    const intent = invocationIntent(cycle);
    const first = await store.appendActionableEvent(sourceEvent(cycle, 1), intent);
    const second = await store.appendActionableEvent(sourceEvent(cycle, 2), intent);
    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(first.invocation?.invocation_id).toBe(second.invocation?.invocation_id);
    expect(first.invocation?.wake_key).toMatch(/^[0-9a-f]{64}$/);
    expect(await counts(cycle)).toEqual({ events: 1, invocations: 1 });
  });

  it('same wake_key with different payload fails closed instead of creating a retry', async () => {
    const cycle = uniqueCycle('conflict');
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    await store.appendActionableEvent(sourceEvent(cycle, 1), invocationIntent(cycle, 1, '{"packet":"one"}'));
    await expect(store.appendActionableEvent(
      sourceEvent(cycle, 2),
      invocationIntent(cycle, 1, '{"packet":"two"}'),
    )).rejects.toMatchObject({ code: 'INVOCATION_PAYLOAD_CONFLICT' });
    expect(await counts(cycle)).toEqual({ events: 1, invocations: 1 });
  });

  it('STALE source event rolls back the outbox in the same D1 batch', async () => {
    const cycle = uniqueCycle('stale');
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    const opened = await store.appendEvent(sourceEvent(cycle, 1));
    expect(opened.status).toBe('applied');
    const stale = await store.appendActionableEvent(
      { ...sourceEvent(cycle, 2), expected_rev: 0 },
      invocationIntent(cycle, 1),
    );
    expect(stale.status).toBe('stale');
    expect(await counts(cycle)).toEqual({ events: 1, invocations: 0 });
  });

  it('source_revision must be the revision created by the actionable event', async () => {
    const cycle = uniqueCycle('source-rev');
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    await expect(store.appendActionableEvent(
      sourceEvent(cycle, 1),
      invocationIntent(cycle, 2),
    )).rejects.toMatchObject({ code: 'INVALID_INVOCATION' });
    expect(await counts(cycle)).toEqual({ events: 0, invocations: 0 });
  });
});

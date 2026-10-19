import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { acquireAgentLease, releaseAgentLease, AgentDenied } from '../../../src/collab-store/agents';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const cycle = () => 'l3b-lease-' + (++n);

describe('CC-5 L3b — bail agent fencing', () => {
  it('acquiert un bail puis refuse un second concurrent', async () => {
    await ensureSchema(db);
    const cycleId = cycle();
    const now = 1_700_000_000;
    const first = await acquireAgentLease(db, {
      cycleId, participantId: 'grok', taskId: 'l3b', workerId: 'w1', now, ttlSeconds: 60,
    });
    expect(first.worker_id).toBe('w1');
    await expect(acquireAgentLease(db, {
      cycleId, participantId: 'grok', taskId: 'l3b', workerId: 'w2', now: now + 1, ttlSeconds: 60,
    })).rejects.toThrow('agent_lease_held');
  });

  it('après release, un nouveau bail est possible', async () => {
    await ensureSchema(db);
    const cycleId = cycle();
    const now = 1_700_000_100;
    await acquireAgentLease(db, {
      cycleId, participantId: 'vibe', taskId: 'l3b', workerId: 'w1', now, ttlSeconds: 60,
    });
    await releaseAgentLease(db, {
      cycleId, participantId: 'vibe', taskId: 'l3b', workerId: 'w1', now: now + 1,
    });
    // status actif le plus récent : released → acquire regarde status='active' AND expires_at > now
    // La ligne released a status released, donc le prochain acquire doit réussir
    const again = await acquireAgentLease(db, {
      cycleId, participantId: 'vibe', taskId: 'l3b', workerId: 'w2', now: now + 2, ttlSeconds: 60,
    });
    expect(again.worker_id).toBe('w2');
  });

  it('journal append-only : UPDATE refusé', async () => {
    await ensureSchema(db);
    const cycleId = cycle();
    await acquireAgentLease(db, {
      cycleId, participantId: 'gpt6', workerId: 'w1', now: 1_700_000_200, ttlSeconds: 60,
    });
    await expect(
      db.prepare("UPDATE agent_leases SET status = 'x' WHERE cycle_id = ?1").bind(cycleId).run(),
    ).rejects.toThrow();
  });
});

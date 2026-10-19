import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { prepareDelegationApproval } from '../../../src/collab-store/store/delegation-approval';
import { bindDelegatedRequest } from '../../../src/collab-store/owner/delegation-binding';
import type { StoreEvent } from '../../../src/collab-store/contracts';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const cycle = () => 'l3c-deny-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
describe('CC-5 L3c approval and execution deny by default', () => {
  it('rejects approval when Kevin has not appointed a coordinator', async () => {
    await ensureSchema(db);
    const cycle_id = cycle();
    await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle_id).run();
    const event: StoreEvent = {
      cycle_id, type: 'delegation.approve', participant_id: 'vibe',
      expected_rev: 1, payload_json: JSON.stringify({request_id: 'r1'}),
      idempotency_key: 'vibe:' + cycle_id + ':approval:1',
    };
    await expect(prepareDelegationApproval(db, event)).rejects.toThrow('vacant_mandate');
    await expect(bindDelegatedRequest(db, {cycle: cycle_id, request_id: 'r1'}, 'gpt6'))
      .rejects.toThrow('not_active_coordinator');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'delegation.approve'")
      .bind(cycle_id).first()).toMatchObject({n: 0});
  });
  it('rejects client-provided reviewer identity or approval parameters', async () => {
    await ensureSchema(db);
    const cycle_id = cycle();
    await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycle_id).run();
    const event: StoreEvent = {
      cycle_id, type: 'delegation.approve', participant_id: 'vibe', expected_rev: 1,
      payload_json: JSON.stringify({request_id: 'r1', reviewer_pid: 'vibe'}),
      idempotency_key: 'vibe:' + cycle_id + ':approval:2',
    };
    await expect(prepareDelegationApproval(db, event)).rejects.toThrow('approval_requires_request_id_only');
  });
});

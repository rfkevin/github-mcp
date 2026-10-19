import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as execution from '../../../src/collab-store/owner/delegation-execution';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const id = (p: string) => 'l3c-' + p + '-' + Date.now().toString(36) + '-' + ++n;
async function fixture() {
  await ensureSchema(db);
  const cycleId = id('cycle');
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycleId).run();
  for (const participant of ['gpt6', 'vibe']) {
    await db.prepare("INSERT INTO participants (participant_id, display_label) VALUES (?1, ?1) ON CONFLICT(participant_id) DO NOTHING").bind(participant).run();
  }
  return cycleId;
}
describe('L3c D1 transactional mandates', () => {
  it('M3: unauthenticated execution and approval helpers are not exported', () => {
    expect(execution).not.toHaveProperty('executeDelegated');
    expect(execution).not.toHaveProperty('recordDelegatedApproval');
  });
  it('vacancy: no active coordinator before owner appointment', async () => {
    const cycleId = await fixture();
    expect(await execution.activeMandate(db, cycleId)).toBeNull();
  });
  it('owner appointment increments epoch and revocation fences queued approval', async () => {
    const cycleId = await fixture();
    const a = await execution.appointCycleCoordinator(db, { cycleId, participantId: 'gpt6', familyId: 'gpt6', expectedEpoch: 0, proof, op: id('appoint') });
    expect(a.status).toBe('applied');
    expect((await execution.activeMandate(db, cycleId))?.epoch).toBe(1);
    await execution.appointCycleCoordinator(db, { cycleId, participantId: null, familyId: null, expectedEpoch: 1, proof, op: id('revoke') });
    expect(await execution.activeMandate(db, cycleId)).toMatchObject({ epoch: 2, participant_id: null });
  });
  it('concurrent owner appointments with same epoch: at most one succeeds', async () => {
    const cycleId = await fixture();
    const attempts = await Promise.allSettled([
      execution.appointCycleCoordinator(db, { cycleId, participantId: 'gpt6', familyId: 'gpt6', expectedEpoch: 0, proof, op: id('a') }),
      execution.appointCycleCoordinator(db, { cycleId, participantId: 'vibe', familyId: 'vibe', expectedEpoch: 0, proof, op: id('b') }),
    ]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await execution.activeMandate(db, cycleId))?.epoch).toBe(1);
  });
});

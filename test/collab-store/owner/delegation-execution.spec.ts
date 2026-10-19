import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { activeMandate, appointCycleCoordinator, executeDelegated, recordDelegatedApproval } from '../../../src/collab-store/owner/delegation-execution';
import type { FourEyesInput } from '../../../src/collab-store/owner/delegation-policy';

const db = (env as unknown as { COLLAB_DB_C6_RESTORE: D1Database }).COLLAB_DB_C6_RESTORE;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const id = (p: string) => 'l3c-' + p + '-' + Date.now().toString(36) + '-' + ++n;
const digest = async (v: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v)))), b => b.toString(16).padStart(2, '0')).join('');
async function fixture() {
  await ensureSchema(db);
  const cycleId = id('cycle');
  await db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1)').bind(cycleId).run();
  for (const participant of ['gpt6', 'vibe']) {
    await db.prepare("INSERT INTO participants (participant_id, display_label) VALUES (?1, ?1) ON CONFLICT(participant_id) DO NOTHING").bind(participant).run();
  }
  await db.prepare('INSERT INTO budget_envelopes (scope, updated_at) VALUES (?1, ?2)').bind(cycleId, 1).run();
  const params = { cycle_id: cycleId, definitions: '[]' };
  const paramsHash = await digest(params);
  const requestId = id('request');
  const reviewer: FourEyesInput = {
    requestId, action: 'install_phases', paramsHash, maxCostCents: 0, expiresAt: 200,
    now: 100, coordinatorParticipant: 'gpt6', coordinatorFamily: 'gpt6',
    reviewerParticipant: 'vibe', reviewerFamily: 'vibe', authenticatedReviewer: true,
    approval: { requestId, action: 'install_phases', paramsHash, maxCostCents: 0, expiresAt: 200 },
  };
  const execution = { cycleId, participantId: 'gpt6', familyId: 'gpt6', epoch: 1,
    requestId, action: 'install_phases', params, paramsHash, maxCostCents: 0,
    expiresAt: 200, now: 100, reviewer, sideEffects: [] };
  return { cycleId, requestId, reviewer, execution };
}
describe('L3c D1 transactional mandates', () => {
  it('vacancy: no delegated execution before owner appointment', async () => {
    const f = await fixture();
    await expect(executeDelegated(db, f.execution)).rejects.toThrow('atomic_precondition_failed');
    expect(await activeMandate(db, f.cycleId)).toBeNull();
  });
  it('owner appointment increments epoch and revocation fences queued approval', async () => {
    const f = await fixture();
    const a = await appointCycleCoordinator(db, { cycleId: f.cycleId, participantId: 'gpt6', familyId: 'gpt6', expectedEpoch: 0, proof, op: id('appoint') });
    expect(a.status).toBe('applied');
    expect((await activeMandate(db, f.cycleId))?.epoch).toBe(1);
    await recordDelegatedApproval(db, { cycleId: f.cycleId, epoch: 1, requestId: f.requestId,
      action: f.execution.action, paramsHash: f.execution.paramsHash, maxCostCents: 0,
      expiresAt: 200, reviewer: f.reviewer });
    await appointCycleCoordinator(db, { cycleId: f.cycleId, participantId: null, familyId: null,
      expectedEpoch: 1, proof, op: id('revoke') });
    expect(await activeMandate(db, f.cycleId)).toMatchObject({ epoch: 2, participant_id: null });
    await expect(executeDelegated(db, f.execution)).rejects.toThrow('atomic_precondition_failed');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({ n: 0 });
  });
  it('concurrent owner appointments with same epoch: at most one succeeds', async () => {
    const f = await fixture();
    const attempts = await Promise.allSettled([
      appointCycleCoordinator(db, { cycleId: f.cycleId, participantId: 'gpt6', familyId: 'gpt6', expectedEpoch: 0, proof, op: id('a') }),
      appointCycleCoordinator(db, { cycleId: f.cycleId, participantId: 'vibe', familyId: 'vibe', expectedEpoch: 0, proof, op: id('b') }),
    ]);
    expect(attempts.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect((await activeMandate(db, f.cycleId))?.epoch).toBe(1);
  });
  it('rejects forged reviewer and never records approval', async () => {
    const f = await fixture();
    await appointCycleCoordinator(db, { cycleId: f.cycleId, participantId: 'gpt6', familyId: 'gpt6', expectedEpoch: 0, proof, op: id('appoint') });
    await expect(recordDelegatedApproval(db, { cycleId: f.cycleId, epoch: 1, requestId: f.requestId,
      action: f.execution.action, paramsHash: f.execution.paramsHash, maxCostCents: 0,
      expiresAt: 200, reviewer: { ...f.reviewer, reviewerFamily: 'gpt6' } })).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM delegated_approvals WHERE request_id = ?1').bind(f.requestId).first()).toMatchObject({ n: 0 });
  });
});

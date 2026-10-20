/** Fixed CC-5 delegated owner dispatcher. Never accepts caller-provided proof or SQL. */
import { bindDelegatedRequest } from './delegation-binding';
import { DelegationDenied } from './delegation-policy';
import { decideOwnerRequest } from './executable';

export async function executeBoundDelegation(
  db: D1Database,
  input: {cycle: string; request_id: string},
  authenticatedPid: string,
) {
  const bound = await bindDelegatedRequest(db, input, authenticatedPid);
  // Only executable owner actions implemented in the existing /owner dispatcher are allowed.
  if (bound.action !== 'install_phases' && bound.action !== 'import_state') throw new DelegationDenied('no_safe_owner_executor');
  const approval = await db.prepare([
    'SELECT reviewer_pid, reviewer_family, epoch, params_hash, max_cost_cents, expires_at, used',
    'FROM delegated_approvals WHERE request_id = ?1 AND cycle_id = ?2',
  ].join(' ')).bind(bound.requestId, bound.cycleId).first<{
    reviewer_pid: string; reviewer_family: string; epoch: number; params_hash: string;
    max_cost_cents: number; expires_at: number; used: number;
  }>();
  if (!approval || approval.used || approval.epoch !== bound.epoch ||
      approval.params_hash !== bound.paramsHash || approval.max_cost_cents !== bound.maxCostCents ||
      approval.expires_at !== bound.expiresAt) throw new DelegationDenied('four_eyes_approval_missing_or_stale');
  const proof = {
    kind: 'delegated' as const, subject: authenticatedPid, cycle_id: bound.cycleId,
    epoch: bound.epoch, request_id: bound.requestId,
    reviewer_pid: approval.reviewer_pid, reviewer_family: approval.reviewer_family,
    params_hash: bound.paramsHash, expires_at: bound.expiresAt,
    max_cost_cents: bound.maxCostCents,
  };
  return decideOwnerRequest(db, {
    request_id: bound.requestId, request_seq: bound.requestSeq, cycle_id: bound.cycleId,
    decision: 'approve', payload_sha256: bound.paramsHash, proof,
  });
}

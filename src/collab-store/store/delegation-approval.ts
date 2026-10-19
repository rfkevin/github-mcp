/** CC-5 L3c: approve an immutable owner.request using the authenticated append principal. */
import type { StoreEvent } from '../contracts';
import { DelegationDenied } from '../owner/delegation-policy';
import { bindDelegatedRequest } from '../owner/delegation-binding';
import { activeMandate } from '../owner/delegation-execution';

/** Statements MUST be included in the same CAS D1 batch as the journal append. */
export async function prepareDelegationApproval(db: D1Database, event: StoreEvent): Promise<D1PreparedStatement[]> {
  let body: unknown;
  try { body = JSON.parse(event.payload_json); } catch { throw new DelegationDenied('invalid_approval_payload'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || typeof (body as {request_id?: unknown}).request_id !== 'string') {
    throw new DelegationDenied('approval_requires_request_id_only');
  }
  const requestId = (body as {request_id: string}).request_id;
  const mandate = await activeMandate(db, event.cycle_id);
  if (!mandate?.participant_id) throw new DelegationDenied('vacant_mandate');
  const bound = await bindDelegatedRequest(db, {cycle: event.cycle_id, request_id: requestId}, mandate.participant_id);
  const reviewer = await db.prepare([
    'SELECT p.status, COALESCE(f.family_id, p.participant_id) AS family',
    'FROM participants p LEFT JOIN participant_identity_families f ON f.participant_id = p.participant_id',
    'WHERE p.participant_id = ?1',
  ].join(' ')).bind(event.participant_id).first<{status: string; family: string}>();
  const authorFamily = await db.prepare(
    'SELECT COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?1), ?1) AS family',
  ).bind(bound.authorPid).first<{family: string}>();
  if (reviewer?.status !== 'active' || reviewer.family === bound.coordinatorFamily ||
      reviewer.family === authorFamily?.family || event.participant_id === bound.coordinatorPid) {
    throw new DelegationDenied('four_eyes_family_or_identity');
  }
  // All derived values are checked again inside the append batch: revocation, HALT, families and request.
  return [
    db.prepare([
      'INSERT INTO collab_store_guard (ok) SELECT CASE WHEN',
      'EXISTS (SELECT 1 FROM delegated_mandates WHERE cycle_id = ?1 AND participant_id = ?2 AND family_id = ?3 AND epoch = ?4)',
      "AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')",
      "AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?5 AND status = 'active')",
      'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?5), ?5) = ?6',
      'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?2), ?2) = ?3',
      'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?7), ?7) != ?6',
      'AND NOT EXISTS (SELECT 1 FROM delegated_approvals WHERE request_id = ?8)',
      'AND EXISTS (SELECT 1 FROM events WHERE seq = ?9 AND cycle_id = ?1 AND type = \'owner.request\')',
      'THEN 1 ELSE 0 END',
    ].join(' ')).bind(bound.cycleId, bound.coordinatorPid, bound.coordinatorFamily, bound.epoch,
      event.participant_id, reviewer.family, bound.authorPid, requestId, bound.requestSeq),
    db.prepare([
      'INSERT INTO delegated_approvals (request_id, cycle_id, epoch, action, params_hash, max_cost_cents, expires_at, reviewer_pid, reviewer_family)',
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    ].join(' ')).bind(requestId, bound.cycleId, bound.epoch, bound.action, bound.paramsHash,
      bound.maxCostCents, bound.expiresAt, event.participant_id, reviewer.family),
  ];
}

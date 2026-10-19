/**
 * CC-5 L3c: authoritative binding for a delegated owner.request.
 * Only the existing OAuth identity resolver may supply authenticatedPid.
 * Client payload never supplies an executor, SQL statements, family or mandate.
 */
import { ensureSchema } from '../store/schema';
import { executablePayloadSha256, parseOwnerRequest } from './executable';
import { assertDelegatedAction, DelegationDenied } from './delegation-policy';

export interface BoundDelegation {
  cycleId: string;
  requestId: string;
  requestSeq: number;
  authorPid: string;
  coordinatorPid: string;
  coordinatorFamily: string;
  epoch: number;
  action: string;
  params: Record<string, unknown>;
  paramsHash: string;
  maxCostCents: number;
  expiresAt: number;
}

/** Read-only authorization prerequisite; the final D1 write MUST repeat every check in its batch. */
export async function bindDelegatedRequest(
  db: D1Database,
  input: { cycle: string; request_id: string },
  authenticatedPid: string,
  now = Math.floor(Date.now() / 1000),
): Promise<BoundDelegation> {
  await ensureSchema(db);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.cycle) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.request_id) ||
      !/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(authenticatedPid)) {
    throw new DelegationDenied('invalid_identity_or_request');
  }
  const mandate = await db.prepare(
    'SELECT participant_id, family_id, epoch FROM delegated_mandates WHERE cycle_id = ?1',
  ).bind(input.cycle).first<{participant_id: string | null; family_id: string | null; epoch: number}>();
  if (!mandate?.participant_id || !mandate.family_id || mandate.participant_id !== authenticatedPid) {
    throw new DelegationDenied('not_active_coordinator');
  }
  const family = await db.prepare(
    'SELECT COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?1), ?1) AS family',
  ).bind(authenticatedPid).first<{family: string}>();
  if (family?.family !== mandate.family_id) throw new DelegationDenied('family_changed');
  const rows = await db.prepare([
    'SELECT seq, participant_id, payload_json FROM events',
    "WHERE cycle_id = ?1 AND type = 'owner.request'",
    "AND json_valid(payload_json) AND json_extract(payload_json, '$.request_id') = ?2",
    'ORDER BY seq ASC LIMIT 2',
  ].join(' ')).bind(input.cycle, input.request_id)
    .all<{seq: number; participant_id: string; payload_json: string}>();
  if (rows.results.length !== 1) throw new DelegationDenied('missing_or_ambiguous_request');
  const row = rows.results[0];
  const parsed = await parseOwnerRequest(row.payload_json);
  if (parsed.kind !== 'executable' || parsed.request.request_id !== input.request_id ||
      parsed.request.cycle_id !== input.cycle) throw new DelegationDenied('invalid_stored_request');
  const req = parsed.request;
  const hash = await executablePayloadSha256(req.action, req.params);
  if (hash !== req.payload_sha256) throw new DelegationDenied('modified_request');
  if (req.expires_at === null || req.expires_at <= now) throw new DelegationDenied('request_expired');
  assertDelegatedAction({ action: req.action, params: req.params, cycleId: input.cycle,
    envelopeCents: req.max_cost_cents });
  const already = await db.prepare('SELECT 1 AS found FROM owner_decisions WHERE request_id = ?1')
    .bind(input.request_id).first();
  if (already) throw new DelegationDenied('already_decided');
  return {
    cycleId: input.cycle, requestId: input.request_id, requestSeq: row.seq,
    authorPid: row.participant_id, coordinatorPid: authenticatedPid,
    coordinatorFamily: mandate.family_id, epoch: mandate.epoch,
    action: req.action, params: req.params, paramsHash: hash,
    maxCostCents: req.max_cost_cents, expiresAt: req.expires_at,
  };
}

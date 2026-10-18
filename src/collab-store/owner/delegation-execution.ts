/**
 * CC-5 L3c D1 — cycle-scoped coordinator mandate and atomic delegation guards.
 * CC-4 global coordinator grants do NOT confer these powers.
 * Callers MUST authenticate owner proof and reviewer identity at their ingress.
 */
import { ensureSchema } from '../store/schema';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';
import { DelegationDenied, assertDelegatedAction, assertFourEyes, type FourEyesInput } from './delegation-policy';

const INIT = [
  "CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS delegated_approvals (request_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, epoch INTEGER NOT NULL, action TEXT NOT NULL, params_hash TEXT NOT NULL, max_cost_cents INTEGER NOT NULL, expires_at INTEGER NOT NULL, reviewer_pid TEXT NOT NULL, reviewer_family TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS delegated_usage (cycle_id TEXT PRIMARY KEY, reserved_cents INTEGER NOT NULL DEFAULT 0, spent_cents INTEGER NOT NULL DEFAULT 0)",
];
const IDENT = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const FAMILY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const REQUEST = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const ACTION_KEY = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
async function setup(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch(INIT.map(sql => db.prepare(sql)));
}
export interface Mandate { cycle_id: string; participant_id: string | null; family_id: string | null; epoch: number }
export async function activeMandate(db: D1Database, cycleId: string): Promise<Mandate | null> {
  await setup(db);
  return db.prepare('SELECT cycle_id, participant_id, family_id, epoch FROM delegated_mandates WHERE cycle_id = ?1')
    .bind(cycleId).first<Mandate>();
}
/** Owner-only appointment/revocation. Epoch increments even on vacancy; queued approvals become invalid. */
export async function appointCycleCoordinator(db: D1Database, input: {
  cycleId: string; participantId: string | null; familyId: string | null;
  expectedEpoch: number; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult> {
  await setup(db);
  if (!IDENT.test(input.cycleId) || !ACTION_KEY.test(input.op) ||
      !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0 ||
      (input.participantId === null) !== (input.familyId === null) ||
      (input.participantId !== null && (!IDENT.test(input.participantId) || !FAMILY.test(input.familyId!)))) {
    throw new DelegationDenied('invalid_appointment');
  }
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const guard = [
    'COALESCE((SELECT epoch FROM delegated_mandates WHERE cycle_id = ?4), 0) = ?5',
    input.participantId === null ? '1 = 1' : [
      'EXISTS (SELECT 1 FROM participants WHERE participant_id = ?6 AND status = \'active\')',
      "COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?6), ?6) = ?7",
    ].join(' AND '),
  ].join(' AND ');
  return ownerAppend(db, {
    cycleId: input.cycleId, key: 'owner:delegated-mandate:' + input.cycleId + ':' + input.op,
    payload: { action: 'appoint_cycle_coordinator', participant_id: input.participantId, epoch: input.expectedEpoch + 1 },
    proof: input.proof,
    extraGuard: { sql: guard, binds: input.participantId === null
      ? [input.cycleId, input.expectedEpoch] : [input.cycleId, input.expectedEpoch, input.participantId, input.familyId] },
    sideEffects: () => [
      db.prepare([
        'INSERT INTO delegated_mandates (cycle_id, participant_id, family_id, epoch, updated_at)',
        'VALUES (?1, ?2, ?3, ?4, ?5)',
        'ON CONFLICT(cycle_id) DO UPDATE SET participant_id = excluded.participant_id,',
        'family_id = excluded.family_id, epoch = excluded.epoch, updated_at = excluded.updated_at',
      ].join(' ')).bind(input.cycleId, input.participantId, input.familyId, input.expectedEpoch + 1, at),
      db.prepare('DELETE FROM delegated_approvals WHERE cycle_id = ?1').bind(input.cycleId),
    ], now: input.now,
  });
}
export interface DelegatedExecution {
  cycleId: string; participantId: string; familyId: string; epoch: number;
  requestId: string; action: string; params: Record<string, unknown>;
  paramsHash: string; maxCostCents: number; expiresAt: number;
  now: number; reviewer: FourEyesInput;
  /** Must be constructed server-side, not from user-supplied SQL. */
  sideEffects: D1PreparedStatement[];
}
/**
 * Execute once, fail closed. Guard, epoch, independent approval, budget reservation,
 * effects, and audit share ONE D1 batch; no JS precheck can authorize the operation.
 * Caller is responsible for authenticating participant + reviewer before invocation.
 */
export async function executeDelegated(db: D1Database, input: DelegatedExecution): Promise<void> {
  await setup(db);
  if (!REQUEST.test(input.requestId) || !IDENT.test(input.participantId) || !FAMILY.test(input.familyId) ||
      !Number.isSafeInteger(input.epoch) || input.epoch < 1 || !Number.isSafeInteger(input.now) ||
      !Number.isSafeInteger(input.maxCostCents) || input.maxCostCents < 0) throw new DelegationDenied('invalid_execution');
  assertDelegatedAction({ action: input.action, params: input.params, cycleId: input.cycleId, envelopeCents: input.maxCostCents });
  assertFourEyes(input.reviewer);
  if (input.reviewer.requestId !== input.requestId || input.reviewer.action !== input.action ||
      input.reviewer.paramsHash !== input.paramsHash || input.reviewer.maxCostCents !== input.maxCostCents ||
      input.reviewer.expiresAt !== input.expiresAt || input.reviewer.coordinatorParticipant !== input.participantId ||
      input.reviewer.coordinatorFamily !== input.familyId || input.reviewer.now !== input.now) {
    throw new DelegationDenied('review_binding_mismatch');
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input.params)));
  const computed = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  if (computed !== input.paramsHash) throw new DelegationDenied('params_hash_mismatch');
  const guard = [
    'INSERT INTO collab_store_guard (ok)',
    'SELECT CASE WHEN',
    'EXISTS (SELECT 1 FROM delegated_mandates WHERE cycle_id = ?1 AND participant_id = ?2 AND family_id = ?3 AND epoch = ?4)',
    'AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?2 AND status = \'active\')',
    'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?2), ?2) = ?3',
    'AND EXISTS (SELECT 1 FROM delegated_approvals WHERE request_id = ?5 AND cycle_id = ?1 AND epoch = ?4',
    'AND action = ?6 AND params_hash = ?7 AND max_cost_cents = ?8 AND expires_at = ?9',
    'AND reviewer_pid = ?10 AND reviewer_family = ?11 AND used = 0)',
    "AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')",
    'AND ?9 > ?12',
    'AND EXISTS (SELECT 1 FROM budget_envelopes WHERE scope = ?1 AND limit_cents - reserved_cents - spent_cents >= ?8)',
    'THEN 1 ELSE 0 END',
  ].join(' ');
  const key = 'delegated:' + input.cycleId + ':' + input.requestId + ':' + input.epoch;
  try {
    await db.batch([
      db.prepare(guard).bind(input.cycleId, input.participantId, input.familyId, input.epoch,
        input.requestId, input.action, input.paramsHash, input.maxCostCents, input.expiresAt,
        input.reviewer.reviewerParticipant, input.reviewer.reviewerFamily, input.now),
      db.prepare('UPDATE delegated_approvals SET used = 1 WHERE request_id = ?1 AND used = 0').bind(input.requestId),
      db.prepare('UPDATE budget_envelopes SET reserved_cents = reserved_cents + ?2 WHERE scope = ?1').bind(input.cycleId, input.maxCostCents),
      ...input.sideEffects,
      db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
        "VALUES (?1, ?2, 'owner.delegated', ?3, 'coordinator', ?4,",
        '(SELECT revision FROM cycles WHERE cycle_id = ?1), ?5, ?6)',
      ].join(' ')).bind(input.cycleId, input.now, input.participantId,
        JSON.stringify({ action: input.action, request_id: input.requestId, epoch: input.epoch,
          params_sha256: input.paramsHash, max_cost_cents: input.maxCostCents,
          reviewer_pid: input.reviewer.reviewerParticipant }), key, 'delegated-four-eyes'),
      db.prepare('UPDATE cycles SET revision = revision + 1 WHERE cycle_id = ?1').bind(input.cycleId),
      db.prepare('UPDATE budget_envelopes SET reserved_cents = reserved_cents - ?2, spent_cents = spent_cents + ?2 WHERE scope = ?1')
        .bind(input.cycleId, input.maxCostCents),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    throw new DelegationDenied('atomic_precondition_failed');
  }
}
/** Reviewer identity MUST be authenticated at ingress; recording is not authorization. */
export async function recordDelegatedApproval(db: D1Database, input: {
  cycleId: string; epoch: number; requestId: string; action: string; paramsHash: string;
  maxCostCents: number; expiresAt: number; reviewer: FourEyesInput;
}): Promise<void> {
  await setup(db);
  assertFourEyes(input.reviewer);
  if (!REQUEST.test(input.requestId) || !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
      input.requestId !== input.reviewer.requestId || input.action !== input.reviewer.action ||
      input.paramsHash !== input.reviewer.paramsHash || input.maxCostCents !== input.reviewer.maxCostCents ||
      input.expiresAt !== input.reviewer.expiresAt) throw new DelegationDenied('approval_binding_mismatch');
  try {
    await db.batch([
      db.prepare([
        'INSERT INTO collab_store_guard (ok) SELECT CASE WHEN',
        'EXISTS (SELECT 1 FROM delegated_mandates WHERE cycle_id = ?1 AND epoch = ?2',
        'AND participant_id = ?3 AND family_id = ?4)',
        'AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?5), ?5) = ?6',
        'AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?5 AND status = \'active\')',
        'AND NOT EXISTS (SELECT 1 FROM delegated_approvals WHERE request_id = ?7)',
        'THEN 1 ELSE 0 END',
      ].join(' ')).bind(input.cycleId, input.epoch, input.reviewer.coordinatorParticipant,
        input.reviewer.coordinatorFamily, input.reviewer.reviewerParticipant, input.reviewer.reviewerFamily, input.requestId),
      db.prepare([
        'INSERT INTO delegated_approvals (request_id, cycle_id, epoch, action, params_hash, max_cost_cents, expires_at, reviewer_pid, reviewer_family)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
      ].join(' ')).bind(input.requestId, input.cycleId, input.epoch, input.action, input.paramsHash,
        input.maxCostCents, input.expiresAt, input.reviewer.reviewerParticipant, input.reviewer.reviewerFamily),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch { throw new DelegationDenied('approval_precondition_failed'); }
}

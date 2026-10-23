/**
 * CC-5 L3c D1 — cycle-scoped coordinator mandate and atomic delegation guards.
 * CC-4 global coordinator grants do NOT confer these powers.
 * Callers MUST authenticate owner proof and reviewer identity at their ingress.
 */
import { ensureSchema } from '../store/schema';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';
import { DelegationDenied } from './delegation-policy';
import { rethrowIfCycleClosed } from './close';

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
    // CC-Owner V2 L2 : acte cycle-scopé — garde d'ouverture dans le lot (?4 = cycle).
    "COALESCE((SELECT status FROM cycles WHERE cycle_id = ?4), 'open') = 'open'",
    input.participantId === null ? '1 = 1' : [
      'EXISTS (SELECT 1 FROM participants WHERE participant_id = ?6 AND status = \'active\')',
      "COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?6), ?6) = ?7",
    ].join(' AND '),
  ].join(' AND ');
  let result: OwnerWriteResult;
  try {
    result = await ownerAppend(db, {
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
  } catch (error) {
    // CC-Owner V2 L2 : cycle clos entre-temps → CYCLE_CLOSED (sinon l'erreur d'origine).
    throw await rethrowIfCycleClosed(db, input.cycleId, error);
  }
  return result;
}

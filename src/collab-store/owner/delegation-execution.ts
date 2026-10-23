/**
 * CC-5 L3c D1 — cycle-scoped coordinator mandate and atomic delegation guards.
 * CC-4 global coordinator grants do NOT confer these powers.
 * Callers MUST authenticate owner proof and reviewer identity at their ingress.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import { assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';
import { DelegationDenied } from './delegation-policy';
import { rethrowIfCycleClosed } from './close';

const INIT = [
  "CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS delegated_approvals (request_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, epoch INTEGER NOT NULL, action TEXT NOT NULL, params_hash TEXT NOT NULL, max_cost_cents INTEGER NOT NULL, expires_at INTEGER NOT NULL, reviewer_pid TEXT NOT NULL, reviewer_family TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS delegated_usage (cycle_id TEXT PRIMARY KEY, reserved_cents INTEGER NOT NULL DEFAULT 0, spent_cents INTEGER NOT NULL DEFAULT 0)",
];
/** CC-Owner V2 L6 : identifiants d’un mandat coordinateur, réutilisés par validateParams (executable.ts). */
export const MANDATE_PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
export const MANDATE_FAMILY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
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
/**
 * CC-Owner V2 L6 : seq du dernier acte de mandat du cycle (nomination ou
 * révocation, formulaire ou demande exécutable), null s’il n’y en a pas —
 * précondition previous_seq d’une demande appoint_cycle_coordinator.
 */
export async function latestMandateActSeq(db: D1Database, cycleId: string): Promise<number | null> {
  await setup(db);
  const row = await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2")
    .bind(cycleId, 'owner:delegated-mandate:' + cycleId + ':').first<{ seq: number | null }>();
  return row?.seq ?? null;
}
/**
 * Owner-only appointment/revocation. Epoch increments even on vacancy; queued
 * approvals become invalid. CC-Owner V2 L6 : binding lie l’acte à
 * l’approbation d’une demande appoint_cycle_coordinator (previous_seq = seq du
 * dernier acte de mandat, null s’il n’y en a pas) ; jamais déléguable.
 */
export async function appointCycleCoordinator(db: D1Database, input: {
  cycleId: string; participantId: string | null; familyId: string | null;
  expectedEpoch: number; proof: OwnerProof; op: string;
  /** CC-Owner V2 L6 : approbation d’une demande appoint_cycle_coordinator — acte lié. */
  binding?: OwnerRequestBinding;
  now?: () => Date;
}): Promise<OwnerWriteResult> {
  await setup(db);
  // CC-Owner V2 L6 : cohérent avec NEVER_DELEGATED — l’acte lié n’accepte
  // que l’approbation owner de la demande (aucune preuve déléguée).
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'La nomination d’un coordinateur de cycle est un acte owner non déléguable.');
  }
  // L6 : previous_seq = dernier acte de mandat (pré-condition lisible hors lot,
  // revérifiée dans la garde ?5/?6 du lot).
  if (input.binding) assertBindingPrecondition(input.binding, await latestMandateActSeq(db, input.cycleId));
  if (!MANDATE_PARTICIPANT_RE.test(input.cycleId) || !ACTION_KEY.test(input.op) ||
      !Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0 ||
      (input.participantId === null) !== (input.familyId === null) ||
      (input.participantId !== null && (!MANDATE_PARTICIPANT_RE.test(input.participantId) || !MANDATE_FAMILY_RE.test(input.familyId!)))) {
    throw new DelegationDenied('invalid_appointment');
  }
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  // L6 lié : clé de liaison et garde de famille ?5 sur les actes de mandat du cycle.
  const key = input.binding
    ? bindingKey('owner:delegated-mandate:' + input.cycleId, input.binding)
    : 'owner:delegated-mandate:' + input.cycleId + ':' + input.op;
  const bound = input.binding ? bindingGuard(input.binding, 'owner:delegated-mandate:' + input.cycleId + ':') : null;
  // L6 : garde paramétrée par offset — liée (?4..?6 = bindingGuard), les gardes
  // du mandat suivent en ?7..?10 ; sinon ?4..?7 exactement comme avant.
  const base = bound ? 7 : 4;
  const guard = [
    'COALESCE((SELECT epoch FROM delegated_mandates WHERE cycle_id = ?' + base + '), 0) = ?' + (base + 1),
    // CC-Owner V2 L2 : acte cycle-scopé — garde d'ouverture dans le lot.
    "COALESCE((SELECT status FROM cycles WHERE cycle_id = ?" + base + "), 'open') = 'open'",
    input.participantId === null ? '1 = 1' : [
      'EXISTS (SELECT 1 FROM participants WHERE participant_id = ?' + (base + 2) + " AND status = \'active\')",
      'COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?' + (base + 2) + '), ?' + (base + 2) + ') = ?' + (base + 3),
    ].join(' AND '),
  ].join(' AND ');
  let result: OwnerWriteResult;
  try {
    result = await ownerAppend(db, {
      cycleId: input.cycleId, key,
      // L6 : bindingPayload en dernier — l’acte lié porte l’identité de la demande.
      payload: { action: 'appoint_cycle_coordinator', participant_id: input.participantId, epoch: input.expectedEpoch + 1,
        ...(input.binding ? bindingPayload(input.binding) : {}) },
      proof: input.proof,
      extraGuard: {
        sql: bound ? '(' + bound.sql + ') AND ' + guard : guard,
        binds: bound
          ? [...bound.binds, ...(input.participantId === null
            ? [input.cycleId, input.expectedEpoch] : [input.cycleId, input.expectedEpoch, input.participantId, input.familyId])]
          : (input.participantId === null
            ? [input.cycleId, input.expectedEpoch] : [input.cycleId, input.expectedEpoch, input.participantId, input.familyId]),
      },
      sideEffects: keyBind => [
        ...(input.binding ? bindingStatements(db, input.binding, input.proof, keyBind, input.now) : []),
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

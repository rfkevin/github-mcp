/**
 * CC-5 l3d — briques communes aux actes du coordinateur mandaté (phases souples 2c-1, demandes de correction 2c-2).
 *
 * - `cycleMandateEpoch` : l'appelant doit être un participant actif qui tient, en identité logique (famille #126),
 *   le mandat L3c du cycle ; renvoie l'époque lue, que le lot d'écriture revérifie.
 * - `mandateGuardSql` : le même contrôle en SQL, pour la garde `collab_store_guard` du lot.
 * - `settleGuardedWrite` : après l'échec d'un lot gardé, distingue rejeu gagnant, HALT, révision périmée et
 *   précondition changée (garde à 0), sans jamais écrire.
 */
import { CollabStoreError } from '../store/collab-store';
import { logicalIdentityOf } from '../identity/families';
import { activeMandate } from '../owner/delegation-execution';
import { assertAutomationRunning } from '../owner/automation';

/** Époque du mandat du cycle si l'appelant le tient (identité logique) ; sinon `forbiddenCode`. */
export async function cycleMandateEpoch(db: D1Database, cycleId: string, participantId: string, forbiddenCode: string): Promise<number> {
  const participant = await db.prepare('SELECT status FROM participants WHERE participant_id = ?1')
    .bind(participantId).first<{ status: string }>();
  const mandate = await activeMandate(db, cycleId);
  const holds = participant?.status === 'active' && mandate?.participant_id
    && await logicalIdentityOf(db, mandate.participant_id) === await logicalIdentityOf(db, participantId);
  if (!holds) {
    throw new CollabStoreError(forbiddenCode, 'Réservé au coordinateur qui tient le mandat actif de ce cycle (nommé par Kevin sur /owner).');
  }
  return mandate!.epoch;
}

/**
 * Prédicat SQL : participant `caller` actif ET titulaire logique du mandat du cycle à l'époque `epoch`.
 * Les arguments sont des marqueurs de paramètres (`?1`, `?5`…), jamais des valeurs.
 */
export function mandateGuardSql(cycle: string, epoch: string, caller: string): string {
  const family = (pid: string) => 'COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ' + pid + '), ' + pid + ')';
  return [
    "EXISTS (SELECT 1 FROM participants WHERE participant_id = " + caller + " AND status = 'active')",
    'AND EXISTS (SELECT 1 FROM delegated_mandates m WHERE m.cycle_id = ' + cycle + ' AND m.epoch = ' + epoch + ' AND m.participant_id IS NOT NULL',
    '  AND ' + family('m.participant_id') + ' = ' + family(caller) + ')',
  ].join(' ');
}

/**
 * Échec d'un lot gardé : un rejeu concurrent gagnant est renvoyé tel quel ; sinon HALT (`AUTOMATION_HALTED`),
 * révision changée (`STALE`), garde à 0 (`preconditionCode`) ; toute autre erreur est relancée.
 */
export async function settleGuardedWrite<T>(db: D1Database, input: {
  error: unknown;
  replay: () => Promise<T | null>;
  cycleId: string;
  expectedRevision: number;
  preconditionCode: string;
  preconditionMessage: string;
}): Promise<T> {
  const winner = await input.replay().catch(() => null);
  if (winner) return winner;
  await assertAutomationRunning(db);
  const current = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(input.cycleId).first<{ revision: number }>();
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw new CollabStoreError('STALE', 'Le cycle a bougé pendant l\'écriture : relisez la révision et réessayez.');
  }
  if (input.error instanceof Error && /CHECK constraint/i.test(input.error.message)) {
    throw new CollabStoreError(input.preconditionCode, input.preconditionMessage);
  }
  throw input.error;
}

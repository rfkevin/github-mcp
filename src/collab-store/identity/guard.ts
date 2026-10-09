/**
 * CC-3 C5 — write authorization from the server-derived identity.
 *
 * - The participant_id of an appended event must be the caller's own resolved
 *   participant: declaring another id (or a label) is refused, never rewritten.
 * - An unregistered client may only file `owner.request`.
 * - `owner.decision` stays refused for every caller (C1 validateAgentEvent);
 *   only the /owner channel records it.
 */
import { CollabStoreError } from '../store/collab-store';
import type { ParticipantIdentity } from './resolve';

export const UNREGISTERED_ALLOWED_TYPES: readonly string[] = ['owner.request'];

export function authorizeAppend(identity: ParticipantIdentity, declaredParticipant: string, type: string): string {
  if (declaredParticipant !== identity.participant_id) {
    throw new CollabStoreError('PARTICIPANT_MISMATCH',
      'participant_id ne correspond pas à l’identité dérivée du jeton : ' + identity.participant_id + '.');
  }
  if (identity.status === 'unregistered' && !UNREGISTERED_ALLOWED_TYPES.includes(type)) {
    throw new CollabStoreError('UNREGISTERED_CLIENT',
      'Client non enregistré : lecture et owner.request uniquement. Demandez au propriétaire d’associer ce client à un participant.');
  }
  return identity.participant_id;
}

/**
 * CC-3 CR-A / CR-01 — who may trigger a phase policy (collab_phase_advance).
 *
 * The advance itself is signed by the server-derived policy, never by the
 * caller; but it is a mutation, so the C5 restrictions apply before anything
 * else (even a replay): an unregistered client is refused, and a registered
 * participant must hold a role (owner, reviewer or tester) on a task of the
 * cycle. Any of the cycle's task roles may trigger; the policy, the matrix
 * and the entry/exit conditions still decide whether the advance happens.
 */
export async function authorizePhaseAdvance(db: D1Database, identity: ParticipantIdentity, cycleId: string): Promise<string> {
  if (identity.status === 'unregistered') {
    throw new CollabStoreError('UNREGISTERED_CLIENT',
      'Client non enregistré : lecture et owner.request uniquement. Demandez au propriétaire d’associer ce client à un participant.');
  }
  const role = await db.prepare(
    'SELECT 1 AS ok FROM tasks WHERE cycle_id = ?1 AND (owner_pid = ?2 OR reviewer_pid = ?2 OR tester_pid = ?2) LIMIT 1',
  ).bind(cycleId, identity.participant_id).first<{ ok: number }>();
  if (!role) {
    throw new CollabStoreError('PHASE_ADVANCE_FORBIDDEN',
      'Seuls les participants qui tiennent un rôle (owner, reviewer, testeur) sur une tâche du cycle peuvent déclencher la policy de phase.');
  }
  return identity.participant_id;
}

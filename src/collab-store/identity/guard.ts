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

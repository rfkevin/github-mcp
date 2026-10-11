/**
 * CC-3 C5 — server-derived participant identity (I8).
 *
 * The participant is resolved from the OAuth client id carried by the
 * validated token, through the owner-maintained `participant_clients` map.
 * Nothing the caller sends (participant_id field, display label, agent label)
 * can change the result. An unmapped client is `unregistered`: it may read and
 * file `owner.request`, nothing else (plan CC-PLAN-3/v1.1 §3.2).
 */
import { ensureSchema } from '../store/schema';
import { recordClientSighting } from './client-sightings';

export type ParticipantIdentity =
  | { status: 'registered'; participant_id: string; display_label: string; client_id: string }
  | { status: 'unregistered'; participant_id: string; client_id: string };

/** Stable, non-reversible pseudonym for an unmapped client (fits the C1 participant pattern). */
export async function unregisteredParticipantId(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('collab-client:' + clientId));
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
  return 'unregistered:' + hex;
}

export async function resolveParticipant(db: D1Database, clientId: string): Promise<ParticipantIdentity> {
  if (typeof clientId !== 'string' || !clientId) {
    return { status: 'unregistered', participant_id: await unregisteredParticipantId(''), client_id: '' };
  }
  await ensureSchema(db);
  const row = await db.prepare([
    'SELECT p.participant_id AS participant_id, p.display_label AS display_label',
    'FROM participant_clients c JOIN participants p ON p.participant_id = c.participant_id',
    "WHERE c.oauth_client_id = ?1 AND p.status = 'active'",
  ].join(' ')).bind(clientId).first<{ participant_id: string; display_label: string }>();
  if (!row) {
    return { status: 'unregistered', participant_id: await unregisteredParticipantId(clientId), client_id: clientId };
  }
  return { status: 'registered', participant_id: row.participant_id, display_label: row.display_label, client_id: clientId };
}

/**
 * Identity of the client carried by a VALIDATED token (/collab/mcp tool
 * context only). An unmapped client is recorded as sighted so that the owner
 * can map it by its pseudonym, including CIMD clients that listClients()
 * never returns. Mapped clients write nothing. Best effort: a failed record
 * never blocks the caller's read; the owner would then see UNKNOWN_CLIENT.
 */
export async function resolveTokenParticipant(db: D1Database, clientId: string): Promise<ParticipantIdentity> {
  const identity = await resolveParticipant(db, clientId);
  if (identity.status === 'unregistered' && identity.client_id) {
    try {
      await recordClientSighting(db, identity.client_id, identity.participant_id);
    } catch (error) {
      console.warn(JSON.stringify({ service: 'collab-identity', outcome: 'client_sighting_failed',
        name: error instanceof Error ? error.name : typeof error }));
    }
  }
  return identity;
}

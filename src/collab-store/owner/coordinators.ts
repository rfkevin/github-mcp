/**
 * CC-4 A4 (#121) — rôle de coordinateur accordé/révoqué uniquement par une
 * demande owner exécutable. Aucun label, champ MCP ou auto-déclaration ne peut
 * produire ce droit.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import {
  assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements,
  type OwnerRequestBinding,
} from './binding';
import type { OwnerProof } from './proof';
import { equivalentParticipantIds } from '../identity/families';

export const COORDINATOR_KEY_PREFIX = 'owner:coordinator:';
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
export const COORDINATOR_STATUSES = ['active', 'revoked'] as const;
export type CoordinatorStatus = (typeof COORDINATOR_STATUSES)[number];

function assertParticipantId(participantId: string): void {
  if (!PARTICIPANT_RE.test(participantId) || /^(owner|unregistered(:.*)?|system)$/i.test(participantId)) {
    throw new CollabStoreError('INVALID_PARTICIPANT_ID', 'Identifiant de participant coordinateur invalide ou réservé.');
  }
}

export async function latestCoordinatorActSeq(db: D1Database, participantId: string): Promise<number | null> {
  await ensureSchema(db);
  const prefix = COORDINATOR_KEY_PREFIX + participantId + ':';
  const row = await db.prepare(
    "SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2",
  ).bind(REGISTRY_CYCLE, prefix).first<{ seq: number | null }>();
  return row?.seq ?? null;
}

/**
 * Le participant doit être actif. Un grant accordé à un membre d'une famille
 * logique vaut pour les autres membres : il s'agit du même principal D12.
 */
export async function isCoordinator(db: D1Database, participantId: string): Promise<boolean> {
  await ensureSchema(db);
  const members = await equivalentParticipantIds(db, participantId);
  const placeholders = members.map((_, index) => '?' + (index + 1)).join(',');
  const row = await db.prepare([
    'SELECT 1 AS ok FROM coordinators c JOIN participants p ON p.participant_id = c.participant_id',
    "WHERE c.participant_id IN (" + placeholders + ") AND c.status = 'active' AND p.status = 'active' LIMIT 1",
  ].join(' ')).bind(...members).first<{ ok: number }>();
  return row?.ok === 1;
}

export async function listActiveCoordinators(db: D1Database): Promise<Array<{
  participant_id: string; display_label: string; event_seq: number | null; updated_at: number;
}>> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT c.participant_id, p.display_label, c.event_seq, c.updated_at',
    'FROM coordinators c JOIN participants p ON p.participant_id = c.participant_id',
    "WHERE c.status = 'active' AND p.status = 'active' ORDER BY c.participant_id",
  ].join(' ')).all<{ participant_id: string; display_label: string; event_seq: number | null; updated_at: number }>();
  return results;
}

/** Exécution liée d'une demande `grant_coordinator`, dans le même lot que la décision. */
export async function setCoordinatorGrant(db: D1Database, input: {
  participant_id: string;
  status: CoordinatorStatus;
  proof: OwnerProof;
  binding: OwnerRequestBinding;
  now?: () => Date;
}): Promise<OwnerWriteResult & { participant_id: string; coordinator_status: CoordinatorStatus }> {
  assertParticipantId(input.participant_id);
  if (!COORDINATOR_STATUSES.includes(input.status)) {
    throw new CollabStoreError('INVALID_COORDINATOR_STATUS', 'Statut coordinateur : active ou revoked.');
  }
  await ensureSchema(db);
  const participant = await db.prepare('SELECT status FROM participants WHERE participant_id = ?1')
    .bind(input.participant_id).first<{ status: string }>();
  if (!participant || participant.status !== 'active') {
    throw new CollabStoreError('COORDINATOR_PARTICIPANT_INACTIVE',
      'Le rôle coordinateur ne peut viser qu’un participant enregistré et actif.');
  }
  const previous = await latestCoordinatorActSeq(db, input.participant_id);
  assertBindingPrecondition(input.binding, previous);
  const prefix = COORDINATOR_KEY_PREFIX + input.participant_id;
  const bound = bindingGuard(input.binding, prefix + ':');
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const result = await ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: bindingKey(prefix, input.binding),
    payload: { action: 'grant_coordinator', participant_id: input.participant_id, status: input.status,
      ...bindingPayload(input.binding) },
    proof: input.proof,
    extraGuard: {
      sql: '(' + bound.sql + ") AND EXISTS (SELECT 1 FROM participants WHERE participant_id = ?7 AND status = 'active')",
      binds: [...bound.binds, input.participant_id],
    },
    sideEffects: eventKey => [
      ...bindingStatements(db, input.binding, input.proof, eventKey, input.now),
      db.prepare([
        'INSERT INTO coordinators (participant_id, status, event_seq, updated_at)',
        'VALUES (?1, ?2, (SELECT seq FROM events WHERE idempotency_key = ?3), ?4)',
        'ON CONFLICT(participant_id) DO UPDATE SET status = excluded.status, event_seq = excluded.event_seq, updated_at = excluded.updated_at',
      ].join(' ')).bind(input.participant_id, input.status, eventKey, at),
    ],
    now: input.now,
  });
  return { ...result, participant_id: input.participant_id, coordinator_status: input.status };
}

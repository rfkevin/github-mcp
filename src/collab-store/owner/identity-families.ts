/** CC-4 #126 — configuration owner-only des familles d'identité. */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { IDENTITY_FAMILY_RE } from '../identity/families';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import {
  assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements,
  type OwnerRequestBinding,
} from './binding';
import type { OwnerProof } from './proof';

export const IDENTITY_FAMILY_KEY_PREFIX = 'owner:identity-family:';
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

export async function latestIdentityFamilyActSeq(db: D1Database, familyId: string): Promise<number | null> {
  await ensureSchema(db);
  const prefix = IDENTITY_FAMILY_KEY_PREFIX + familyId + ':';
  const row = await db.prepare(
    "SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2",
  ).bind(REGISTRY_CYCLE, prefix).first<{ seq: number | null }>();
  return row?.seq ?? null;
}

function normalizeMembers(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 16 || (value.length !== 0 && value.length < 2)) {
    throw new CollabStoreError('IDENTITY_FAMILY_INVALID', 'Une famille contient 0 membre (suppression) ou 2 à 16 membres.');
  }
  const members = value.map(item => String(item).trim());
  if (members.some(item => !PARTICIPANT_RE.test(item) || /^(owner|unregistered(:.*)?|system)$/i.test(item))) {
    throw new CollabStoreError('IDENTITY_FAMILY_INVALID', 'Identifiant de participant invalide ou réservé dans la famille.');
  }
  if (new Set(members).size !== members.length) {
    throw new CollabStoreError('IDENTITY_FAMILY_INVALID', 'Un participant apparaît plusieurs fois dans la famille.');
  }
  return [...members].sort((left, right) => left.localeCompare(right));
}

export async function setIdentityFamily(db: D1Database, input: {
  family_id: string;
  members: readonly string[];
  proof: OwnerProof;
  binding: OwnerRequestBinding;
  now?: () => Date;
}): Promise<OwnerWriteResult & { family_id: string; members: string[] }> {
  const familyId = input.family_id.trim();
  if (!IDENTITY_FAMILY_RE.test(familyId)) {
    throw new CollabStoreError('IDENTITY_FAMILY_INVALID', 'family_id doit respecter [a-z0-9][a-z0-9_-]{0,63}.');
  }
  const members = normalizeMembers(input.members);
  await ensureSchema(db);
  for (const participantId of members) {
    const participant = await db.prepare('SELECT status FROM participants WHERE participant_id = ?1')
      .bind(participantId).first<{ status: string }>();
    if (!participant || participant.status !== 'active') {
      throw new CollabStoreError('IDENTITY_FAMILY_PARTICIPANT_INACTIVE',
        'Chaque membre doit être un participant enregistré et actif : ' + participantId + '.');
    }
    const other = await db.prepare(
      'SELECT family_id FROM participant_identity_families WHERE participant_id = ?1 AND family_id <> ?2',
    ).bind(participantId, familyId).first<{ family_id: string }>();
    if (other) {
      throw new CollabStoreError('IDENTITY_FAMILY_CONFLICT',
        'Un membre appartient déjà à une autre famille ; retirez-le d’abord via une demande owner distincte.');
    }
  }
  const previous = await latestIdentityFamilyActSeq(db, familyId);
  assertBindingPrecondition(input.binding, previous);
  const prefix = IDENTITY_FAMILY_KEY_PREFIX + familyId;
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const result = await ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: bindingKey(prefix, input.binding),
    payload: { action: 'set_identity_family', family_id: familyId, members, ...bindingPayload(input.binding) },
    proof: input.proof,
    extraGuard: bindingGuard(input.binding, prefix + ':'),
    sideEffects: eventKey => [
      ...bindingStatements(db, input.binding, input.proof, eventKey, input.now),
      db.prepare('DELETE FROM participant_identity_families WHERE family_id = ?1').bind(familyId),
      ...members.map(participantId => db.prepare([
        'INSERT INTO participant_identity_families (participant_id, family_id, event_seq, updated_at)',
        'VALUES (?1, ?2, (SELECT seq FROM events WHERE idempotency_key = ?3), ?4)',
      ].join(' ')).bind(participantId, familyId, eventKey, at)),
    ],
    now: input.now,
  });
  return { ...result, family_id: familyId, members };
}

/**
 * CC-4 #126 — identité logique commune à plusieurs participants historiques.
 *
 * Un participant garde son id, ses événements et ses preuves. `family_id` ne
 * remplace jamais participant_id dans le journal : il sert seulement à décider
 * si deux ids représentent la même identité logique pour les droits et D12.
 */
import { ensureSchema } from '../store/schema';
import { StateContractError } from '../../collab/contracts';

export const IDENTITY_FAMILY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface IdentityFamily {
  family_id: string;
  members: string[];
  event_seq: number | null;
  updated_at: number;
}

export async function logicalIdentityOf(db: D1Database, participantId: string): Promise<string> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT family_id FROM participant_identity_families WHERE participant_id = ?1')
    .bind(participantId).first<{ family_id: string }>();
  return row?.family_id ?? participantId;
}

export async function equivalentParticipantIds(db: D1Database, participantId: string): Promise<string[]> {
  const logical = await logicalIdentityOf(db, participantId);
  const { results } = await db.prepare(
    'SELECT participant_id FROM participant_identity_families WHERE family_id = ?1 ORDER BY participant_id',
  ).bind(logical).all<{ participant_id: string }>();
  if (results.length === 0) return [participantId];
  return results.map(row => row.participant_id);
}

export async function participantsEquivalent(db: D1Database, left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  return await logicalIdentityOf(db, left) === await logicalIdentityOf(db, right);
}

/** D12 : des ids historiques d'une même famille ne sont pas des pairs distincts. */
export async function assertDistinctLogicalParticipants(db: D1Database, pids: readonly string[]): Promise<void> {
  const logical = await Promise.all(pids.map(pid => logicalIdentityOf(db, pid)));
  if (new Set(logical).size !== logical.length) {
    throw new StateContractError(
      'DUPLICATE_LOGICAL_IDENTITY',
      'D12 : auteur, reviewer et testeur doivent représenter trois identités logiques distinctes.',
    );
  }
}

export async function listIdentityFamilies(db: D1Database): Promise<IdentityFamily[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT family_id, participant_id, event_seq, updated_at',
    'FROM participant_identity_families ORDER BY family_id, participant_id',
  ].join(' ')).all<{ family_id: string; participant_id: string; event_seq: number | null; updated_at: number }>();
  const families = new Map<string, IdentityFamily>();
  for (const row of results) {
    const current = families.get(row.family_id) ?? {
      family_id: row.family_id, members: [], event_seq: row.event_seq, updated_at: row.updated_at,
    };
    current.members.push(row.participant_id);
    current.event_seq = Math.max(current.event_seq ?? 0, row.event_seq ?? 0) || null;
    current.updated_at = Math.max(current.updated_at, row.updated_at);
    families.set(row.family_id, current);
  }
  return [...families.values()];
}

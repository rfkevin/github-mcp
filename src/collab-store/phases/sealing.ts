import { ensureSchema } from '../store/schema';
import { CollabStoreError } from '../store/collab-store';

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sealProposal(db: D1Database, input: {
  id: string;
  cycle_id: string;
  phase: string;
  participant_id: string;
  content: string;
}): Promise<{ id: string; content_hash: string }> {
  await ensureSchema(db);
  const contentHash = await sha256(input.content);
  await db.prepare([
    'INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)',
  ].join(' ')).bind(input.id, input.cycle_id, input.phase, input.participant_id, contentHash, input.content).run();
  return { id: input.id, content_hash: contentHash };
}

export async function readSealedProposal(db: D1Database, input: {
  id: string;
  participant_id: string;
}): Promise<{ id: string; participant_id: string; content_hash: string; content: string | null; revealed: boolean }> {
  await ensureSchema(db);
  const row = await db.prepare(
    'SELECT id, participant_id, content_hash, content, revealed_at FROM sealed_items WHERE id = ?1'
  ).bind(input.id).first<{ id: string; participant_id: string; content_hash: string; content: string; revealed_at: number | null }>();
  if (!row) throw new CollabStoreError('SEALED_ITEM_UNKNOWN', 'Proposition scellée inconnue : ' + input.id);
  const visible = row.participant_id === input.participant_id || row.revealed_at !== null;
  return {
    id: row.id,
    participant_id: row.participant_id,
    content_hash: row.content_hash,
    content: visible ? row.content : null,
    revealed: row.revealed_at !== null,
  };
}

export async function revealPhaseProposals(db: D1Database, cycleId: string, phase: string, at: number): Promise<void> {
  await ensureSchema(db);
  await db.prepare(
    'UPDATE sealed_items SET revealed_at = ?3 WHERE cycle_id = ?1 AND phase = ?2 AND revealed_at IS NULL'
  ).bind(cycleId, phase, at).run();
}

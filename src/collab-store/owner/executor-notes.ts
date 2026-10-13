/** CC-4 A4 (#121) — notes owner sur les exécuteurs, jamais modifiables via MCP. */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

export const EXECUTOR_NOTE_MAX = 1000;

export interface ExecutorNotes {
  strengths: string;
  weaknesses: string;
  event_seq: number | null;
  updated_at: number;
}

function note(value: string, field: string): string {
  if (typeof value !== 'string' || value.length > EXECUTOR_NOTE_MAX) {
    throw new CollabStoreError('EXECUTOR_NOTE_INVALID', field + ' doit contenir au plus ' + EXECUTOR_NOTE_MAX + ' caractères.');
  }
  return value.trim();
}

export async function loadExecutorNotes(db: D1Database, endpointId: string): Promise<ExecutorNotes | null> {
  await ensureSchema(db);
  return db.prepare('SELECT strengths, weaknesses, event_seq, updated_at FROM executor_notes WHERE endpoint_id = ?1')
    .bind(endpointId).first<ExecutorNotes>();
}

export async function setExecutorNotes(db: D1Database, input: {
  endpoint_id: string; strengths: string; weaknesses: string; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult & { notes: ExecutorNotes }> {
  await ensureSchema(db);
  const endpoint = await db.prepare('SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?1').bind(input.endpoint_id).first();
  if (!endpoint) throw new CollabStoreError('ENDPOINT_UNKNOWN', 'Endpoint inconnu : notes non modifiées.');
  const strengths = note(input.strengths, 'points forts');
  const weaknesses = note(input.weaknesses, 'points faibles');
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const result = await ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: 'owner:executor-note:' + input.endpoint_id + ':' + input.op,
    payload: { action: 'update_executor_notes', endpoint_id: input.endpoint_id, strengths, weaknesses },
    proof: input.proof,
    extraGuard: { sql: 'EXISTS (SELECT 1 FROM endpoints WHERE endpoint_id = ?4)', binds: [input.endpoint_id] },
    sideEffects: eventKey => [db.prepare([
      'INSERT INTO executor_notes (endpoint_id, strengths, weaknesses, event_seq, updated_at)',
      'VALUES (?1, ?2, ?3, (SELECT seq FROM events WHERE idempotency_key = ?4), ?5)',
      'ON CONFLICT(endpoint_id) DO UPDATE SET strengths = excluded.strengths, weaknesses = excluded.weaknesses,',
      ' event_seq = excluded.event_seq, updated_at = excluded.updated_at',
    ].join(' ')).bind(input.endpoint_id, strengths, weaknesses, eventKey, at)],
    now: input.now,
  });
  const stored = await loadExecutorNotes(db, input.endpoint_id);
  return { ...result, notes: stored ?? { strengths, weaknesses, event_seq: result.event.seq, updated_at: at } };
}

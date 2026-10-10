/**
 * CC-3 CR-F05 — load revealed P1 envelopes in bounded D1 batches.
 * Exactly one query per 99 distinct sealed ids (cycle_id uses the 100th bind).
 * No application-level event cap: callers keep their own pagination/cursors.
 */
import { parseSealedEnvelope } from '../phases/sealed-envelope';
import type { StoredStoreEvent } from './collab-store';

const SEALED_BATCH_SIZE = 99;

interface SealedRow {
  id: string;
  content: string;
  revealed_at: number | null;
}

export async function revealProposalPayloads(
  db: D1Database,
  cycleId: string,
  events: StoredStoreEvent[],
): Promise<StoredStoreEvent[]> {
  const metadataByIndex = new Map<number, { sealedId: string; metadata: Record<string, unknown> }>();
  const ids = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== 'proposal.submit' || event.cycle_id !== cycleId) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.payload_json) as unknown;
    } catch {
      // Preserve an unreadable event as-is; do not guess its sealed id.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const metadata = parsed as Record<string, unknown>;
    if (typeof metadata.sealed_id !== 'string') continue;
    metadataByIndex.set(index, { sealedId: metadata.sealed_id, metadata });
    ids.add(metadata.sealed_id);
  }

  if (ids.size === 0) return events;
  const rows = new Map<string, SealedRow>();
  const allIds = Array.from(ids);
  for (let index = 0; index < allIds.length; index += SEALED_BATCH_SIZE) {
    const batch = allIds.slice(index, index + SEALED_BATCH_SIZE);
    const placeholders = batch.map((_, i) => '?' + (i + 2)).join(', ');
    const { results } = await db.prepare(
      'SELECT id, content, revealed_at FROM sealed_items WHERE cycle_id = ?1 AND id IN (' + placeholders + ')'
    ).bind(cycleId, ...batch).all<SealedRow>();
    for (const row of results) rows.set(row.id, row);
  }

  return events.map((event, index) => {
    const info = metadataByIndex.get(index);
    if (!info) return event;
    const row = rows.get(info.sealedId);
    // Never reveal a missing or still-sealed envelope.
    if (!row || row.revealed_at === null) return event;
    // A corrupt revealed envelope must fail closed, just like the old single-row path.
    const envelope = parseSealedEnvelope(row.content);
    return {
      ...event,
      payload_json: JSON.stringify({
        ...info.metadata,
        content: envelope.content,
        nonce: envelope.nonce,
        revealed: true,
      }),
    };
  });
}

/**
 * CC-5 L5 — résumé d'archivage par cycle (D3-b, incrément 1).
 *
 * Le résumé n'est PAS une source d'autorité : le registre canonique (events,
 * memory_entries) reste toujours lu à la source pour tout acte protégé
 * (fail-closed, D3). Cycle inconnu → refus typé, aucun résumé inventé.
 */
import { scopeFamily } from '../contracts/memory';
import { sha256Hex } from '../memory/pause-resume';
import { ensureResearchSchema, ResearchError } from './schema';

export interface CycleArchiveMemoryFamily {
  family: string;
  entries: number;
  tokens: number;
  uses: number;
}

export interface CycleArchiveSummary {
  cycle_id: string;
  project: string;
  phase: string;
  revision: number;
  status: string;
  seq_from: number | null;
  seq_to: number | null;
  events: number;
  origin_memory_entries: number;
  /** Vue GLOBALE du store (tous scopes actifs, sans filtre de cycle) — T3. */
  store_memory_families: CycleArchiveMemoryFamily[];
  archive_sha256: string;
  notice: string;
}

export const ARCHIVE_SUMMARY_NOTICE =
  'Archive summary only (D3-b): the canonical journal (events, memory_entries) read at the source remains the authority; protected acts (D12, owner decisions) must never rely on this summary.';

/** Résumé d'archivage d'un cycle : plage seq du journal, empreinte sha256, stats mémoire. Lecture seule. */
export async function cycleArchiveSummary(db: D1Database, cycleId: string): Promise<CycleArchiveSummary> {
  await ensureResearchSchema(db);
  const cycle = await db
    .prepare('SELECT cycle_id, project, phase, revision, status FROM cycles WHERE cycle_id = ?1')
    .bind(cycleId)
    .first<{ cycle_id: string; project: string; phase: string; revision: number; status: string }>();
  if (!cycle) {
    throw new ResearchError('UNKNOWN_CYCLE', 'cycleArchiveSummary: unknown cycle ' + cycleId + ' (fail-closed, D3).');
  }
  const range = await db
    .prepare('SELECT MIN(seq) AS seq_from, MAX(seq) AS seq_to, COUNT(*) AS events FROM events WHERE cycle_id = ?1')
    .bind(cycleId)
    .first<{ seq_from: number | null; seq_to: number | null; events: number }>();
  const origin = await db
    .prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE expires_cycle = ?1')
    .bind(cycleId)
    .first<{ n: number }>();
  // T3 : vue GLOBALE du store (tous scopes actifs) — pas une mémoire du cycle.
  const { results } = await db
    .prepare(
      "SELECT scope, COUNT(*) AS entries, SUM(COALESCE(token_cost, 0)) AS tokens, SUM(uses) AS uses FROM memory_entries WHERE status = 'active' GROUP BY scope",
    )
    .all<{ scope: string; entries: number; tokens: number; uses: number }>();
  const byFamily = new Map<string, CycleArchiveMemoryFamily>();
  for (const row of results ?? []) {
    const family = scopeFamily(row.scope);
    let stats = byFamily.get(family);
    if (!stats) {
      stats = { family, entries: 0, tokens: 0, uses: 0 };
      byFamily.set(family, stats);
    }
    stats.entries += row.entries;
    stats.tokens += row.tokens;
    stats.uses += row.uses;
  }
  const summary: Omit<CycleArchiveSummary, 'archive_sha256'> = {
    cycle_id: cycle.cycle_id,
    project: cycle.project,
    phase: cycle.phase,
    revision: cycle.revision,
    status: cycle.status,
    seq_from: range?.seq_from ?? null,
    seq_to: range?.seq_to ?? null,
    events: range?.events ?? 0,
    origin_memory_entries: origin?.n ?? 0,
    store_memory_families: [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family)),
    notice: ARCHIVE_SUMMARY_NOTICE,
  };
  return { ...summary, archive_sha256: await sha256Hex(JSON.stringify(summary)) };
}

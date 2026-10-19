/**
 * CC-5 L5 — point d'entrée du chercheur planifié (D3, incrément 1).
 *
 * Consommateurs : contrôleur L3d (cron → runResearchPass, passId stable par
 * déclencheur pour l'idempotence), assembleur L3b (archiveCandidates +
 * archiveFirstCompare, câblage du compteur d'utilité à la construction du
 * paquet), digest /owner (listFindings). Pour tout acte protégé, relire le
 * registre canonique à la source : ces résumés ne sont pas des autorités.
 */
export { RESEARCH_FINDING_KINDS, RESEARCH_SCHEMA, ResearchError, ensureResearchSchema, type ResearchFindingKind } from './schema';
export { cycleArchiveSummary, type CycleArchiveMemoryFamily, type CycleArchiveSummary } from './archive';
export { researchPass, runResearchPass, type ResearchPassInput, type ResearchPassStatus, type ResearchPassSummary } from './run';
export {
  archiveCandidates,
  duplicateGroups,
  journalEventCounts,
  scopeMemoryStats,
  type ArchiveCandidate,
  type DuplicateGroup,
  type ScopeMemoryStats,
} from './snapshot';
import { ensureResearchSchema } from './schema';

export interface ResearchFindingRow {
  id: number;
  pass_id: string;
  cycle_id: string | null;
  kind: string;
  scope: string | null;
  detail_json: string;
  at: number;
}

/** Findings bornés, filtrables, ordre d'insertion (consommateurs L3b/L3d, digest /owner). */
export async function listFindings(
  db: D1Database,
  options: { cycleId?: string; sinceSeq?: number; kind?: string; limit?: number } = {},
): Promise<ResearchFindingRow[]> {
  await ensureResearchSchema(db);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const where: string[] = [];
  const binds: Array<string | number> = [];
  if (options.cycleId != null) {
    binds.push(options.cycleId);
    where.push('cycle_id = ?' + binds.length);
  }
  if (options.sinceSeq != null) {
    binds.push(options.sinceSeq);
    where.push('id > ?' + binds.length);
  }
  if (options.kind != null) {
    binds.push(options.kind);
    where.push('kind = ?' + binds.length);
  }
  const sql =
    'SELECT id, pass_id, cycle_id, kind, scope, detail_json, at FROM research_findings'
    + (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY id ASC LIMIT ?' + (binds.length + 1);
  binds.push(limit);
  const { results } = await db.prepare(sql).bind(...binds).all<ResearchFindingRow>();
  return (results ?? []).map(row => ({ ...row }));
}

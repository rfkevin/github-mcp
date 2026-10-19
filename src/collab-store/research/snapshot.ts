/**
 * CC-5 L5 — lectures d'hygiène du chercheur (D3), en lecture seule.
 *
 * Toutes les requêtes sont bornées et ne retournent JAMAIS le texte d'une
 * entrée mémoire : les scopes participant: sont privés (X2/CRB-R1) et un
 * finding peut circuler vers les consommateurs partagés (digest /owner,
 * backlog L3b). Les kinds critiques sont exclus via CRITICAL_KINDS_SQL,
 * dérivé de PROTECTED_KINDS (source unique).
 */
import { archiveFirstCompare, classifyScope, CRITICAL_KINDS_SQL, isCriticalKind } from '../memory/hygiene';
import { ensureResearchSchema } from './schema';

export interface ScopeMemoryStats {
  scope: string;
  family: string;
  private_scope: boolean;
  entries: number;
  capped_entries: number;
  critical_entries: number;
  tokens: number;
  uses: number;
  last_used_rev: number | null;
}

/** Stats d'hygiène par scope (entrées actives), famille et kinds critiques dérivés en JS. */
export async function scopeMemoryStats(db: D1Database): Promise<ScopeMemoryStats[]> {
  await ensureResearchSchema(db);
  const { results } = await db.prepare(
    "SELECT scope, kind, COUNT(*) AS entries, SUM(COALESCE(token_cost, 0)) AS tokens, SUM(uses) AS uses, MAX(last_used_rev) AS last_used_rev FROM memory_entries WHERE status = 'active' GROUP BY scope, kind ORDER BY scope, kind",
  ).all<{ scope: string; kind: string; entries: number; tokens: number; uses: number; last_used_rev: number | null }>();
  const byScope = new Map<string, ScopeMemoryStats>();
  for (const row of results ?? []) {
    let stats = byScope.get(row.scope);
    if (!stats) {
      const classification = classifyScope(row.scope);
      stats = {
        scope: row.scope,
        family: classification.family,
        private_scope: classification.private,
        entries: 0,
        capped_entries: 0,
        critical_entries: 0,
        tokens: 0,
        uses: 0,
        last_used_rev: null,
      };
      byScope.set(row.scope, stats);
    }
    stats.entries += row.entries;
    stats.tokens += row.tokens;
    stats.uses += row.uses;
    if (isCriticalKind(row.kind)) stats.critical_entries += row.entries;
    else stats.capped_entries += row.entries;
    if (row.last_used_rev != null && (stats.last_used_rev == null || row.last_used_rev > stats.last_used_rev)) {
      stats.last_used_rev = row.last_used_rev;
    }
  }
  return [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}

export interface ArchiveCandidate {
  id: string;
  version: number;
  scope: string;
  kind: string;
  uses: number;
  last_used_rev: number | null;
}

/** Candidates actives à l'archivage, ordre archive-first, SANS texte (X2 : scopes participant privés). */
export async function archiveCandidates(db: D1Database, limit = 20): Promise<ArchiveCandidate[]> {
  await ensureResearchSchema(db);
  const bounded = Math.max(1, Math.min(limit, 200));
  const { results } = await db.prepare(
    "SELECT id, version, scope, kind, uses, last_used_rev FROM memory_entries WHERE status = 'active' AND kind NOT IN ("
      + CRITICAL_KINDS_SQL
      + ') ORDER BY uses ASC, COALESCE(last_used_rev, 0) ASC, scope ASC, id ASC, version DESC LIMIT ?1',
  ).bind(bounded).all<{ id: string; version: number; scope: string; kind: string; uses: number; last_used_rev: number | null }>();
  const rows: ArchiveCandidate[] = (results ?? []).map(row => ({ ...row }));
  rows.sort((a, b) => archiveFirstCompare(a, b) || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
  return rows;
}

export interface DuplicateGroup {
  scope: string;
  kind: string;
  count: number;
  ids: string[];
}

/** Groupes d'entrées actives identiques (scope, kind, texte) — candidates à la consolidation C4. Sans texte (X2). */
export async function duplicateGroups(db: D1Database, limit = 10): Promise<DuplicateGroup[]> {
  await ensureResearchSchema(db);
  const bounded = Math.max(1, Math.min(limit, 100));
  const { results } = await db.prepare(
    "SELECT scope, kind, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids FROM memory_entries WHERE status = 'active' GROUP BY scope, kind, text HAVING COUNT(*) > 1 ORDER BY n DESC, scope, kind LIMIT ?1",
  ).bind(bounded).all<{ scope: string; kind: string; n: number; ids: string | null }>();
  return (results ?? []).map(row => ({
    scope: row.scope,
    kind: row.kind,
    count: row.n,
    ids: (row.ids ?? '').split('|').filter(Boolean),
  }));
}

/** Croissance du journal : nombre d'événements par cycle (top N). */
export async function journalEventCounts(db: D1Database, limit = 5): Promise<Array<{ cycle_id: string; events: number }>> {
  await ensureResearchSchema(db);
  const bounded = Math.max(1, Math.min(limit, 50));
  const { results } = await db.prepare(
    'SELECT cycle_id, COUNT(*) AS events FROM events GROUP BY cycle_id ORDER BY events DESC, cycle_id LIMIT ?1',
  ).bind(bounded).all<{ cycle_id: string; events: number }>();
  return (results ?? []).map(row => ({ cycle_id: row.cycle_id, events: row.events }));
}

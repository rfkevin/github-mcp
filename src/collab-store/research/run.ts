/**
 * CC-5 L5 — passage du chercheur planifié (D3, incrément 1).
 *
 * runResearchPass : lecture seule sur le registre canonique, UN SEUL lot D1
 * qui écrit le passage (research_passes) et ses findings (research_findings).
 * Jamais d'écriture dans events ni memory_entries.
 * Fail-closed : HALT (owner_flags, canal owner) → status 'halted', AUCUNE
 * écriture. Idempotent par pass_id : un rejeu renvoie le passage original
 * (status 'duplicate') sans seconde écriture — le compteur du contrôleur
 * L3d peut rejouer un déclencheur identique sans doublon.
 */
import { DEFAULT_SCOPE_ENTRY_CAPS, scopeEntryCap, type ScopeEntryCaps } from '../memory/hygiene';
import { sha256Hex } from '../memory/pause-resume';
import { isAutomationHalted } from '../owner/automation';
import { ensureResearchSchema, type ResearchFindingKind } from './schema';
import { archiveCandidates, duplicateGroups, journalEventCounts, scopeMemoryStats } from './snapshot';

export type ResearchPassStatus = 'recorded' | 'duplicate' | 'halted';

export interface ResearchPassSummary {
  pass_id: string;
  at: number;
  cycle_id: string | null;
  status: ResearchPassStatus;
  findings: Partial<Record<ResearchFindingKind, number>>;
  findings_count: number;
  snapshot_sha256: string;
}

export interface ResearchPassInput {
  passId?: string;
  cycleId?: string | null;
  caps?: ScopeEntryCaps;
  now?: () => Date;
}

interface PlannedFinding {
  kind: ResearchFindingKind;
  scope: string | null;
  detail: Record<string, unknown>;
}

async function findingKinds(db: D1Database, passId: string): Promise<Partial<Record<ResearchFindingKind, number>>> {
  const { results } = await db.prepare(
    'SELECT kind, COUNT(*) AS n FROM research_findings WHERE pass_id = ?1 GROUP BY kind',
  ).bind(passId).all<{ kind: ResearchFindingKind; n: number }>();
  const findings: Partial<Record<ResearchFindingKind, number>> = {};
  for (const row of results ?? []) findings[row.kind] = row.n;
  return findings;
}

/** Lecture d'un passage enregistré (résumé interne, jamais une autorité, D3-b). */
export async function researchPass(db: D1Database, passId: string): Promise<ResearchPassSummary | null> {
  await ensureResearchSchema(db);
  const row = await db.prepare(
    'SELECT pass_id, at, cycle_id, findings_count, snapshot_sha256, status FROM research_passes WHERE pass_id = ?1',
  ).bind(passId).first<{ pass_id: string; at: number; cycle_id: string | null; findings_count: number; snapshot_sha256: string; status: string }>();
  if (!row) return null;
  return {
    pass_id: row.pass_id,
    at: row.at,
    cycle_id: row.cycle_id,
    status: row.status as ResearchPassStatus,
    findings: await findingKinds(db, passId),
    findings_count: row.findings_count,
    snapshot_sha256: row.snapshot_sha256,
  };
}

/** Exécute un passage d'hygiène : findings alimentent le backlog, aucune mutation du registre. */
export async function runResearchPass(db: D1Database, input: ResearchPassInput = {}): Promise<ResearchPassSummary> {
  await ensureResearchSchema(db);
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const passId = input.passId ?? 'rp-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const cycleId = input.cycleId ?? null;
  if (await isAutomationHalted(db)) {
    return { pass_id: passId, at, cycle_id: cycleId, status: 'halted', findings: {}, findings_count: 0, snapshot_sha256: '' };
  }
  const existing = await researchPass(db, passId);
  if (existing) return { ...existing, status: 'duplicate' };
  const caps = input.caps ?? DEFAULT_SCOPE_ENTRY_CAPS;
  const stats = await scopeMemoryStats(db);
  const candidates = await archiveCandidates(db);
  const duplicates = await duplicateGroups(db);
  const growth = await journalEventCounts(db);
  const planned: PlannedFinding[] = [
    {
      kind: 'scope_stats',
      scope: null,
      detail: {
        scopes: stats.map(stat => ({
          scope: stat.scope,
          family: stat.family,
          private_scope: stat.private_scope,
          entries: stat.entries,
          capped_entries: stat.capped_entries,
          critical_entries: stat.critical_entries,
          tokens: stat.tokens,
          uses: stat.uses,
          last_used_rev: stat.last_used_rev,
        })),
      },
    },
  ];
  for (const stat of stats) {
    const cap = scopeEntryCap(stat.family, caps);
    if (stat.capped_entries > cap) {
      planned.push({
        kind: 'cap_pressure',
        scope: stat.scope,
        detail: { scope: stat.scope, family: stat.family, capped_entries: stat.capped_entries, cap },
      });
    }
  }
  planned.push({
    kind: 'archive_first',
    scope: null,
    detail: {
      candidates: candidates.map(candidate => ({
        id: candidate.id,
        version: candidate.version,
        scope: candidate.scope,
        kind: candidate.kind,
        uses: candidate.uses,
        last_used_rev: candidate.last_used_rev,
      })),
      hint: 'archive-first (D3-e): never-served first, then oldest last_used_rev; critical kinds never archived; act via memory.retire (C4), never a direct rewrite',
    },
  });
  planned.push({
    kind: 'consolidation_candidate',
    scope: null,
    detail: {
      groups: duplicates.map(group => ({ scope: group.scope, kind: group.kind, count: group.count, ids: group.ids })),
      hint: 'identical active (scope, kind, text) groups; consolidate via memory.consolidate (C4) with a consolidation binding (source_seq_range, source_hash, version, review_at)',
    },
  });
  planned.push({ kind: 'journal_growth', scope: null, detail: { cycles: growth } });
  const snapshotSha256 = await sha256Hex(JSON.stringify(planned));
  const findings: Partial<Record<ResearchFindingKind, number>> = {};
  for (const finding of planned) findings[finding.kind] = (findings[finding.kind] ?? 0) + 1;
  try {
    await db.batch([
      db
        .prepare('INSERT INTO research_passes (pass_id, cycle_id, at, findings_count, snapshot_sha256, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(passId, cycleId, at, planned.length, snapshotSha256, 'recorded'),
      ...planned.map(finding =>
        db
          .prepare('INSERT INTO research_findings (pass_id, cycle_id, kind, scope, detail_json, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
          .bind(passId, cycleId, finding.kind, finding.scope, JSON.stringify(finding.detail), at),
      ),
    ]);
  } catch (error) {
    // Un passage concurrent du même pass_id a pu gagner (PK) : juger l'état durable.
    const winner = await researchPass(db, passId);
    if (winner) return { ...winner, status: 'duplicate' };
    throw error;
  }
  return {
    pass_id: passId,
    at,
    cycle_id: cycleId,
    status: 'recorded',
    findings,
    findings_count: planned.length,
    snapshot_sha256: snapshotSha256,
  };
}

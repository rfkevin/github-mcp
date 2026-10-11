/**
 * CC-3 Lot X2/X5 (github-mcp#107) — indépendance P1 des cycles de travail.
 *
 * X5 : pendant P1, aucune mutation mémoire ne rend un NOUVEAU contenu partagé
 * visible au packet d'un cycle de travail ouvert en P1 — propose partagé,
 * consolidate partagé, review activant une candidate partagée. Les écritures
 * privées (participant:*), les retirements, les contenus déjà actifs et le
 * rejeu identique (duplicate, jugé avant le dispatch mémoire) restent permis.
 *
 * Décision JS read-only (assessSharedP1Write) + garde transactionnelle
 * (p1SnapshotGuard) : l'instantané des cycles de travail P1 ouverts non
 * système et de leurs tâches est re-vérifié au commit — un changement concurrent
 * entre le diagnostic et le batch roule tout en arrière (fail-closed, même
 * contrat que CR-D).
 *
 * Les cycles système (memory-alarms, owner-registry) sont exclus : ils ne
 * servent jamais de packet de travail. Limites résiduelles assumées (spec) :
 * promoteScope et memory.retire ne portent pas la garde (choix de spec), et
 * les mutations CONCURRENTES de project/status d'un cycle P1 ne sont pas
 * couvertes (aucun writer production trouvé) — documentées au guide §3/§9.
 *
 * Imports croisés : ce module n'utilise MEMORY_ALARM_CYCLE / REGISTRY_CYCLE
 * que dans les corps de fonctions — aucun usage top-level, le cycle
 * memory-store -> p1-independence -> owner/decisions -> store/collab-store ->
 * journal-lifecycle -> memory-store reste runtime-safe.
 */

import { scopeFamily, toProjectScopeKey } from '../contracts/memory';
import { MEMORY_ALARM_CYCLE } from './pause-resume';
import { REGISTRY_CYCLE } from '../owner/decisions';

/** Rôles projetables : role:<r> n'est visible qu'à un cycle de travail ayant au moins une tâche. */
export const PROJECTABLE_ROLES = new Set(['owner', 'reviewer', 'tester']);

/** Scope partagé (famille common/project/role/task) : soumis à la garde X5. */
export function isSharedMemoryScope(scope: string): boolean {
  const family = scopeFamily(scope);
  return family === 'common' || family === 'project' || family === 'role' || family === 'task';
}

/** Contexte d'écriture du journal : cycle visé, et création par cet append (expected_rev = 0). */
export interface JournalWriteContext {
  cycleId: string | null;
  createsCycle: boolean;
}

/** Instantané X5 : cycles de travail P1 ouverts non système, et leurs tâches. */
export interface P1Snapshot {
  cycles: number;
  tasks: number;
}

interface P1Context {
  project: string;
  taskIds: string[];
}

async function p1Contexts(db: D1Database, write: JournalWriteContext | null): Promise<Map<string, P1Context>> {
  const rows = await db
    .prepare([
      'SELECT c.cycle_id AS cycle_id, c.project AS project, t.task_id AS task_id',
      'FROM cycles c LEFT JOIN tasks t ON t.cycle_id = c.cycle_id',
      "WHERE c.phase = 'P1' AND c.status = 'open' AND c.cycle_id NOT IN (?1, ?2)",
    ].join(' '))
    .bind(MEMORY_ALARM_CYCLE, REGISTRY_CYCLE)
    .all<{ cycle_id: string; project: string | null; task_id: string | null }>();
  const contexts = new Map<string, P1Context>();
  for (const row of rows.results ?? []) {
    const context = contexts.get(row.cycle_id) ?? { project: row.project ?? '', taskIds: [] };
    if (row.task_id != null && !context.taskIds.includes(row.task_id)) context.taskIds.push(row.task_id);
    contexts.set(row.cycle_id, context);
  }
  // X5 : l'append qui CRÉE le cycle (expected_rev = 0) participe au diagnostic —
  // un cycle naît P1 open (défaut du schéma), son packet serait exposé.
  if (write?.createsCycle && write.cycleId && !contexts.has(write.cycleId)) {
    const existing = await db.prepare('SELECT 1 AS one FROM cycles WHERE cycle_id = ?1').bind(write.cycleId).first();
    if (!existing) contexts.set(write.cycleId, { project: '', taskIds: [] });
  }
  return contexts;
}

function scopeVisibleTo(scope: string, context: P1Context): boolean {
  if (scope === 'common') return true;
  const i = scope.indexOf(':');
  const family = i === -1 ? scope : scope.slice(0, i);
  const value = i === -1 ? '' : scope.slice(i + 1);
  if (family === 'project') return toProjectScopeKey(context.project) === value;
  if (family === 'task') return context.taskIds.includes(value);
  if (family === 'role') return PROJECTABLE_ROLES.has(value) && context.taskIds.length > 0;
  return false;
}

/**
 * Décision X5, read-only : `write` décrit l'append du journal (null = appel
 * interne du MemoryStore, sans création de cycle). Retourne blocked + l'instantané
 * à re-vérifier dans la transaction appelante via p1SnapshotGuard.
 */
export async function assessSharedP1Write(
  db: D1Database,
  scope: string,
  write: JournalWriteContext | null,
): Promise<{ blocked: boolean; snapshot: P1Snapshot }> {
  const contexts = await p1Contexts(db, write);
  let blocked = false;
  for (const context of contexts.values()) {
    if (scopeVisibleTo(scope, context)) {
      blocked = true;
      break;
    }
  }
  let tasks = 0;
  for (const context of contexts.values()) tasks += context.taskIds.length;
  return { blocked, snapshot: { cycles: contexts.size, tasks } };
}

/**
 * Garde transactionnelle X5 : le batch appelant ne passe que si l'instantané
 * (cycles de travail P1 ouverts non système, leurs tâches) est inchangé depuis
 * le diagnostic. À joindre aux statements APRÈS l'effet mémoire : un changement
 * concurrent roule tout en arrière, le caller re-diagnostique (fail-closed).
 */
export function p1SnapshotGuard(db: D1Database, snapshot: P1Snapshot): D1PreparedStatement {
  return db
    .prepare([
      'INSERT INTO collab_store_guard (ok)',
      'SELECT CASE WHEN',
      "  (SELECT COUNT(*) FROM cycles WHERE phase = 'P1' AND status = 'open' AND cycle_id NOT IN (?1, ?2)) = ?3",
      '  AND (SELECT COUNT(*) FROM tasks WHERE cycle_id IN (',
      "    SELECT cycle_id FROM cycles WHERE phase = 'P1' AND status = 'open' AND cycle_id NOT IN (?1, ?2)",
      '  )) = ?4',
      '  THEN 1 ELSE 0 END',
    ].join(' '))
    .bind(MEMORY_ALARM_CYCLE, REGISTRY_CYCLE, snapshot.cycles, snapshot.tasks);
}

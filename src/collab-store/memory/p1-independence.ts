/**
 * CC-3 Lot X2/X5 (github-mcp#107) — indépendance P1 des cycles de travail.
 *
 * X5 : pendant P1, aucune mutation mémoire ne rend un NOUVEAU contenu partagé
 * visible au packet d'un cycle de travail ouvert en P1 — propose partagé,
 * consolidate partagé, review activant une candidate partagée. Les écritures
 * privées (participant:*), les retirements, les contenus déjà actifs et le
 * rejeu identique (duplicate, jugé avant le dispatch mémoire) restent permis.
 *
 * Cycle de travail (revue Claude B1, PR #108) : un cycle P1 ouvert non système
 * ne compte QUE s'il porte des phase_definitions installées (ouverture
 * K-phases). Un cycle errant né d'un append — checkpoint, owner.request,
 * faute de frappe — n'a aucune définition (FK) et ne gèle donc jamais une
 * écriture partagée.
 *
 * Décision JS read-only (assessSharedP1Write) + garde transactionnelle
 * (p1SnapshotGuard) : l'EMPREINTE des cycles de travail P1 ouverts non
 * système et de leurs tâches (cycle#projet#tâche) est re-vérifiée au commit —
 * un changement concurrent entre le diagnostic et le batch, permutation à
 * effectif constant comprise, roule tout en arrière (fail-closed, revue
 * Claude B2 ; même contrat que CR-D).
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

/** Instantané X5 : empreinte des cycles de travail P1 ouverts non système et de leurs tâches. */
export interface P1Snapshot {
  keys: string[];
}

/** Critère cycle de travail (revue Claude B1) : P1 ouvert, non système, phase_definitions installées. */
const WORK_CYCLE_CRITERION = [
  "c.phase = 'P1' AND c.status = 'open' AND c.cycle_id NOT IN (?1, ?2)",
  'AND EXISTS (SELECT 1 FROM phase_definitions d WHERE d.cycle_id = c.cycle_id)',
].join(' ');

/** Lignes (cycle, projet, tâche) des cycles de travail — même critère au diagnostic et à la garde. */
const WORK_CYCLE_ROWS = [
  'SELECT c.cycle_id AS cycle_id, c.project AS project, t.task_id AS task_id',
  'FROM cycles c LEFT JOIN tasks t ON t.cycle_id = c.cycle_id',
  'WHERE ' + WORK_CYCLE_CRITERION,
].join(' ');

interface P1Context {
  project: string;
  taskIds: string[];
}

async function p1Contexts(db: D1Database): Promise<Map<string, P1Context>> {
  const rows = await db
    .prepare(WORK_CYCLE_ROWS)
    .bind(MEMORY_ALARM_CYCLE, REGISTRY_CYCLE)
    .all<{ cycle_id: string; project: string | null; task_id: string | null }>();
  const contexts = new Map<string, P1Context>();
  for (const row of rows.results ?? []) {
    const context = contexts.get(row.cycle_id) ?? { project: row.project ?? '', taskIds: [] };
    if (row.task_id != null && !context.taskIds.includes(row.task_id)) context.taskIds.push(row.task_id);
    contexts.set(row.cycle_id, context);
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

/** Clé d'empreinte (cycle, projet, tâche) — même forme côté JS et côté garde SQL (revue Claude B2). */
function fingerprintKey(cycleId: string, project: string, taskId: string): string {
  return cycleId + '#' + project + '#' + taskId;
}

/**
 * Décision X5, read-only : write décrit l'append du journal (null = appel
 * interne du MemoryStore). Conservé pour compat API — depuis la revue Claude
 * B1, un cycle naissant (expected_rev = 0) n'a pas encore de phase_definitions
 * (FK) et ne compte jamais comme cycle de travail. Retourne blocked +
 * l'empreinte à re-vérifier dans la transaction appelante via p1SnapshotGuard.
 */
export async function assessSharedP1Write(
  db: D1Database,
  scope: string,
  write: JournalWriteContext | null,
): Promise<{ blocked: boolean; snapshot: P1Snapshot }> {
  void write;
  const contexts = await p1Contexts(db);
  let blocked = false;
  const keys: string[] = [];
  contexts.forEach((context, cycleId) => {
    if (scopeVisibleTo(scope, context)) blocked = true;
    if (context.taskIds.length === 0) keys.push(fingerprintKey(cycleId, context.project, ''));
    else for (const taskId of context.taskIds) keys.push(fingerprintKey(cycleId, context.project, taskId));
  });
  return { blocked, snapshot: { keys } };
}

/**
 * Garde transactionnelle X5 : le batch appelant ne passe que si l'EMPREINTE
 * des cycles de travail P1 (cycle#projet#tâche — une clé par tâche, la tâche
 * vide pour un cycle sans tâche) est inchangée depuis le diagnostic,
 * permutation à effectif constant comprise (revue Claude B2). À joindre aux
 * statements APRÈS l'effet mémoire : un changement concurrent roule tout en
 * arrière, le caller re-diagnostique (fail-closed).
 */
export function p1SnapshotGuard(db: D1Database, snapshot: P1Snapshot): D1PreparedStatement {
  return db
    .prepare([
      'INSERT INTO collab_store_guard (ok)',
      'SELECT CASE WHEN',
      '  (SELECT COUNT(*) FROM (' + WORK_CYCLE_ROWS + ') AS w',
      "   WHERE w.cycle_id || '#' || w.project || '#' || COALESCE(w.task_id, '') NOT IN (SELECT value FROM json_each(?3))) = 0",
      '  AND (SELECT COUNT(*) FROM json_each(?3)',
      "   WHERE value NOT IN (SELECT w2.cycle_id || '#' || w2.project || '#' || COALESCE(w2.task_id, '') FROM (" + WORK_CYCLE_ROWS + ') AS w2)) = 0',
      '  THEN 1 ELSE 0 END',
    ].join(' '))
    .bind(MEMORY_ALARM_CYCLE, REGISTRY_CYCLE, JSON.stringify(snapshot.keys));
}

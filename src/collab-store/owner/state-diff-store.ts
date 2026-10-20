/**
 * CC-5 l3e (D13-5) — verdict serveur pour un import d'état délégué.
 *
 * Lit le DERNIER import du cycle (le contenu canonique est journalisé dans le
 * payload de l'owner.decision) et le compare à l'état proposé avec
 * classifyStateImport. Le verdict n'est jamais fourni par un appelant.
 *
 * Précondition : le seq du dernier import lu ici doit être celui que la
 * demande a déclaré (preconditions.previous_seq). La garde SQL de l'exécution
 * (bindingGuard) vérifie dans le même lot que ce seq n'a pas bougé : le contenu
 * comparé est donc exactement la base de l'import écrit (pas de TOCTOU).
 */
import { ensureSchema } from '../store/schema';
import { STATE_IMPORT_KEY_PREFIX } from '../export/state-export';
import { DelegationDenied } from './delegation-policy';
import { classifyStateImport, type StateDiffResult } from './state-diff';

export interface LatestImport {
  seq: number;
  content: string | null;
}

export async function latestStateImport(db: D1Database, cycleId: string): Promise<LatestImport | null> {
  await ensureSchema(db);
  const prefix = STATE_IMPORT_KEY_PREFIX + cycleId + ':';
  const row = await db.prepare([
    "SELECT seq, payload_json FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'",
    'AND substr(idempotency_key, 1, length(?2)) = ?2 ORDER BY seq DESC LIMIT 1',
  ].join(' ')).bind(cycleId, prefix).first<{ seq: number; payload_json: string }>();
  if (!row) return null;
  let content: unknown = null;
  try { content = (JSON.parse(row.payload_json) as { content?: unknown }).content; } catch { content = null; }
  return { seq: row.seq, content: typeof content === 'string' ? content : null };
}

/**
 * Verdict pour une demande d'import déléguée. Lève `state_precondition_stale` si le
 * dernier import n'est plus celui que la demande attendait.
 */
export async function delegatedStateDiff(db: D1Database, input: {
  cycle_id: string;
  previous_seq: number | null;
  markdown: string;
}): Promise<StateDiffResult> {
  const latest = await latestStateImport(db, input.cycle_id);
  if ((latest?.seq ?? null) !== input.previous_seq) throw new DelegationDenied('state_precondition_stale');
  return classifyStateImport(latest?.content ?? null, input.markdown);
}

export interface StateDiffPreview extends StateDiffResult {
  /** Le dernier import n'est plus celui que la demande attendait : l'exécution déléguée serait refusée. */
  stale: boolean;
  /** Le coordinateur pourrait l'exécuter après approbation d'une autre famille (verdict direct et précondition fraîche). */
  delegable: boolean;
}

/** Affichage /owner (lecture seule, ne lève jamais) : même calcul que delegatedStateDiff. */
export async function previewStateDiff(db: D1Database, input: { cycle_id: string; previous_seq: number | null; markdown: string }): Promise<StateDiffPreview> {
  const latest = await latestStateImport(db, input.cycle_id);
  const verdict = classifyStateImport(latest?.content ?? null, input.markdown);
  const stale = (latest?.seq ?? null) !== input.previous_seq;
  return { ...verdict, stale, delegable: verdict.level === 'direct' && !stale };
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ResolvedImportPlan {
  phase: string;
  tasks: ReadonlyArray<{ task_id: string; owner_pid: string; reviewer_pid: string; tester_pid: string; owned_paths: string[] }>;
  issue_refs: ReadonlyArray<{ repository: string; issue_number: number }>;
}

/**
 * D13-5 (revue ChatGPT) : le classifieur compare du TEXTE, mais l'import réécrit `tasks` à partir de
 * l'annuaire courant (étiquette -> participant). Pour une preuve DÉLÉGUÉE, la garde SQL du lot exige donc
 * que le plan RÉSOLU ne change aucun droit : mêmes tâches avec les mêmes owner/reviewer/tester/chemins
 * qu'en base, même phase, mêmes références d'issues, aucune issue prise à un autre cycle. Sinon le lot
 * n'écrit rien (il faut Kevin). Évalué dans le même lot D1 que la décision.
 */
export function withResolvedPlanGuard(guard: { sql: string; binds: unknown[] }, plan: ResolvedImportPlan): { sql: string; binds: unknown[] } {
  const first = guard.binds.length + 4; // les paramètres de garde commencent à ?4 (?1 clé, ?2 cycle, ?3 révision)
  const sep = String.fromCharCode(31);
  const rec = String.fromCharCode(30);
  const taskFp = plan.tasks.map(t => [t.task_id, t.owner_pid ?? '', t.reviewer_pid ?? '', t.tester_pid ?? '', JSON.stringify(t.owned_paths)].join(sep))
    .sort(byCodeUnit).join(rec);
  const refs = [...plan.issue_refs].sort((a, b) => byCodeUnit(a.repository, b.repository) || a.issue_number - b.issue_number)
    .map(ref => ref.repository + '#' + ref.issue_number);
  const sql = [
    guard.sql,
    "AND COALESCE((SELECT group_concat(f, char(30)) FROM (SELECT task_id || char(31) || COALESCE(owner_pid, '') || char(31) || COALESCE(reviewer_pid, '') || char(31) || COALESCE(tester_pid, '') || char(31) || COALESCE(owned_paths, '') AS f FROM tasks WHERE cycle_id = ?2 ORDER BY task_id)), '') = ?" + first,
    "AND COALESCE((SELECT phase FROM cycles WHERE cycle_id = ?2), '') = ?" + (first + 1),
    "AND COALESCE((SELECT group_concat(r, char(30)) FROM (SELECT repository || '#' || issue_number AS r FROM cycle_issue_refs_v2 WHERE cycle_id = ?2 ORDER BY repository, issue_number)), '') = ?" + (first + 2),
    "AND NOT EXISTS (SELECT 1 FROM cycle_issue_refs_v2 WHERE cycle_id != ?2 AND instr(?" + (first + 3) + ", char(30) || repository || '#' || issue_number || char(30)) > 0)",
  ].join(' ');
  return { sql, binds: [...guard.binds, taskFp, plan.phase, refs.join(rec), rec + refs.join(rec) + rec] };
}

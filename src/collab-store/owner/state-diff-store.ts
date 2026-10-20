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

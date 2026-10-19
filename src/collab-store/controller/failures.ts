/**
 * CC-5 L3d (incrément 2b-2b) — file des échecs du passage programmé.
 *
 * Aujourd'hui un passage en échec (cycle illisible, journal indisponible,
 * chercheur L5 en erreur) ne laisse aucune trace durable : le résultat du Cron
 * est perdu. Cette table interne, append-only (triggers), consigne chaque
 * échec avec une clé (portée, code, heure UTC) : au plus une ligne par heure
 * et par couple portée/code, quelle que soit la fréquence du Cron. Aucun
 * nouvel essai automatique n'est lancé (le passage suivant réessaie de
 * lui-même) : la file sert à rendre l'échec visible à Kevin (section
 * « À relayer » de /owner) et à mesurer sa durée.
 *
 * HALT : écriture conditionnée `WHERE NOT halt` dans la même requête (sous
 * HALT le contrôleur et le chercheur rendent « halted », pas un échec).
 * Fail-soft : une erreur d'écriture de la file n'interrompt jamais le passage.
 */
import { HALT_ACTIVE_SQL } from '../owner/automation';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';

export const FAILURE_WINDOW_S = 24 * 3600;
export const FAILURE_BUCKET_S = 3600;
/** Portée réservée au chercheur L5 (jamais un identifiant de cycle). */
export const RESEARCH_SCOPE = 'research:l5';

const INIT = [
  'CREATE TABLE IF NOT EXISTS controller_failures (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  failure_key TEXT NOT NULL UNIQUE,',
  '  scope TEXT NOT NULL,',
  '  error TEXT NOT NULL,',
  '  bucket INTEGER NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ')',
].join(' ');
const NO_UPDATE = "CREATE TRIGGER IF NOT EXISTS controller_failures_append_only_u BEFORE UPDATE ON controller_failures BEGIN SELECT RAISE(ABORT, 'append-only'); END";
const NO_DELETE = "CREATE TRIGGER IF NOT EXISTS controller_failures_append_only_d BEFORE DELETE ON controller_failures BEGIN SELECT RAISE(ABORT, 'append-only'); END";

export async function ensureFailureQueue(db: D1Database): Promise<void> {
  await db.batch([db.prepare(INIT), db.prepare(NO_UPDATE), db.prepare(NO_DELETE),
    db.prepare('CREATE INDEX IF NOT EXISTS controller_failures_recent ON controller_failures (created_at)')]);
}

const CODE = /^[A-Z0-9_]{1,64}$/;

/** Code d'erreur borné et sans donnée libre (jamais un message brut). */
export function failureCode(error: string | undefined): string {
  return error && CODE.test(error) ? error : 'UNKNOWN_ERROR';
}

export interface FailureInput { scope: string; error: string; now: number }

/** true si une nouvelle ligne a été écrite (false : même heure déjà consignée, ou HALT). */
export async function recordFailure(db: D1Database, input: FailureInput): Promise<boolean> {
  await ensureSchema(db); // owner_flags (HALT) doit exister : la garde est relue dans la requête d'écriture
  await ensureFailureQueue(db);
  const error = failureCode(input.error);
  const bucket = Math.floor(input.now / FAILURE_BUCKET_S);
  const key = await sha256Hex(input.scope + '\u001f' + error + '\u001f' + bucket);
  const result = await db.prepare([
    'INSERT OR IGNORE INTO controller_failures (failure_key, scope, error, bucket, created_at)',
    'SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT (' + HALT_ACTIVE_SQL + ')',
  ].join(' ')).bind(key, input.scope, error, bucket, input.now).run();
  return result.meta.changes === 1;
}

export interface FailureSummary { scope: string; error: string; hours: number; first_at: number; last_at: number }

/** Échecs des dernières 24 h, regroupés par portée et code. Lecture seule ; table absente → []. */
export async function recentFailures(db: D1Database, now: number): Promise<FailureSummary[]> {
  const table = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'controller_failures'")
    .first<{ ok: number }>();
  if (!table) return [];
  const { results } = await db.prepare([
    'SELECT scope, error, COUNT(*) AS hours, MIN(created_at) AS first_at, MAX(created_at) AS last_at',
    'FROM controller_failures WHERE created_at > ?1 GROUP BY scope, error ORDER BY last_at DESC LIMIT 20',
  ].join(' ')).bind(now - FAILURE_WINDOW_S).all<FailureSummary>();
  return results;
}

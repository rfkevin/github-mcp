/**
 * CC-5 L3 (A3a du plan) — journal de décision du contrôleur, append-only.
 *
 * Table interne hors schéma canonique gelé (même statut que l'outbox A1).
 * Chaque décision porte identité visée, règle, révision lue, objet (SHA,
 * phase) et raison. La clé d'idempotence ne dépend que du contenu de la
 * décision : rejouer le même état ne crée aucune ligne (pas de double réveil),
 * un nouvel état (nouveau head, verdict renouvelé) crée une nouvelle ligne.
 * Aucune ligne n'est jamais modifiée ni supprimée.
 */
import { sha256Hex } from '../store/hash';
import type { Decision } from './rules';

const INIT = [
  'CREATE TABLE IF NOT EXISTS controller_decisions (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  cycle_id TEXT NOT NULL,',
  '  decision_key TEXT NOT NULL UNIQUE,',
  '  revision INTEGER NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  actor TEXT NOT NULL,',
  "  task_id TEXT NOT NULL DEFAULT '',",
  '  action TEXT NOT NULL,',
  '  rule TEXT NOT NULL,',
  '  subject TEXT NOT NULL,',
  '  reason TEXT NOT NULL,',
  '  state_hash TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ')',
].join(' ');

const NO_UPDATE = [
  'CREATE TRIGGER IF NOT EXISTS controller_decisions_append_only_u',
  'BEFORE UPDATE ON controller_decisions BEGIN SELECT RAISE(ABORT, \'append-only\'); END',
].join(' ');
const NO_DELETE = [
  'CREATE TRIGGER IF NOT EXISTS controller_decisions_append_only_d',
  'BEFORE DELETE ON controller_decisions BEGIN SELECT RAISE(ABORT, \'append-only\'); END',
].join(' ');

export async function ensureControllerJournal(db: D1Database): Promise<void> {
  await db.batch([db.prepare(INIT), db.prepare(NO_UPDATE), db.prepare(NO_DELETE),
    db.prepare('CREATE INDEX IF NOT EXISTS controller_decisions_cycle ON controller_decisions (cycle_id, id)')]);
}

/**
 * Clé stable : cycle + contenu de la décision + épisode (jamais la révision du
 * cycle ni l'heure). Même état rejoué → même clé ; transition de la tâche ou
 * nouveau fait → nouvel épisode, donc nouvelle ligne (réveil réarmé).
 */
export async function decisionKey(cycleId: string, decision: Decision): Promise<string> {
  return sha256Hex([cycleId, decision.kind, decision.actor, decision.task_id ?? '', decision.action,
    decision.rule, decision.subject, decision.episode].join('\u001f'));
}

/**
 * l3d 2b-1 — rappel d'une décision restée sans suite. Une décision encore
 * active (même clé, donc même épisode) reçoit au plus une ligne « reminder »
 * par tranche de REMINDER_INTERVAL_S depuis sa première écriture, et au plus
 * REMINDER_MAX rappels : au-delà, plus rien (pas de bruit sans fin). Un
 * nouvel épisode repart de zéro (nouvelle clé).
 */
export const REMINDER_INTERVAL_S = 6 * 3600;
export const REMINDER_MAX = 3;

/** Tranche de rappel atteinte (0 = pas encore de rappel), bornée à REMINDER_MAX. */
export function reminderBucket(firstAt: number, now: number): number {
  const bucket = Math.floor((now - firstAt) / REMINDER_INTERVAL_S);
  return Math.min(Math.max(bucket, 0), REMINDER_MAX);
}

export interface JournalResult { halted: boolean; recorded: Decision[]; already: Decision[]; reminded: Decision[] }

/** Lecture des clés déjà journalisées, par paquets (limite de paramètres liés de D1). */
async function knownKeys(db: D1Database, keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let start = 0; start < keys.length; start += 90) {
    const chunk = keys.slice(start, start + 90);
    const placeholders = chunk.map((_, index) => '?' + (index + 1)).join(', ');
    const rows = await db.prepare('SELECT decision_key, created_at FROM controller_decisions WHERE decision_key IN (' + placeholders + ')')
      .bind(...chunk).all<{ decision_key: string; created_at: number }>();
    for (const row of rows.results) out.set(row.decision_key, row.created_at);
  }
  return out;
}

const HALT_SET = "EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')";

/**
 * Enregistre les décisions nouvelles en un lot ; les décisions déjà vues sont
 * signalées, jamais réécrites. HALT est relu DANS le lot d'écriture (même
 * transaction D1) et chaque insertion est conditionnée à son absence : un
 * arrêt posé après l'instantané n'écrit aucune décision (fencing, A3c).
 */
export async function recordDecisions(db: D1Database, input: {
  cycleId: string; revision: number; stateHash: string; decisions: Decision[]; now: number;
}): Promise<JournalResult> {
  await ensureControllerJournal(db);
  if (input.decisions.length === 0) return { halted: false, recorded: [], already: [], reminded: [] };
  const keys = await Promise.all(input.decisions.map(decision => decisionKey(input.cycleId, decision)));
  const firstSeen = await knownKeys(db, keys);
  const fresh = input.decisions.map((decision, index) => ({ decision, key: keys[index] })).filter(item => !firstSeen.has(item.key));
  const already = input.decisions.filter((_, index) => firstSeen.has(keys[index]));
  // Rappels : une clé dérivée par (décision, tranche) ; INSERT OR IGNORE garantit une ligne par tranche.
  const due: Array<{ decision: Decision; key: string; bucket: number }> = [];
  for (let index = 0; index < input.decisions.length; index += 1) {
    const firstAt = firstSeen.get(keys[index]);
    if (firstAt === undefined) continue;
    const bucket = reminderBucket(firstAt, input.now);
    if (bucket >= 1) due.push({ decision: input.decisions[index], key: await sha256Hex(keys[index] + '\u001freminder\u001f' + bucket), bucket });
  }
  const dueSeen = await knownKeys(db, due.map(item => item.key));
  const reminders = due.filter(item => !dueSeen.has(item.key));
  const insert = (key: string, decision: Decision, rule: string, reason: string) => db.prepare([
    'INSERT OR IGNORE INTO controller_decisions',
    '(cycle_id, decision_key, revision, kind, actor, task_id, action, rule, subject, reason, state_hash, created_at)',
    'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12 WHERE NOT ' + HALT_SET,
  ].join(' ')).bind(input.cycleId, key, input.revision, decision.kind, decision.actor, decision.task_id ?? '',
    decision.action, rule, decision.subject, reason, input.stateHash, input.now);
  const results = await db.batch([
    db.prepare('SELECT CASE WHEN ' + HALT_SET + ' THEN 1 ELSE 0 END AS halted'),
    ...fresh.map(({ decision, key }) => insert(key, decision, decision.rule, decision.reason)),
    ...reminders.map(({ decision, key, bucket }) => insert(key, decision, 'reminder',
      'Rappel ' + bucket + '/' + REMINDER_MAX + ' (' + decision.rule + ') : ' + decision.reason)),
  ]);
  if ((results[0].results as Array<{ halted: number }>)[0]?.halted === 1) return { halted: true, recorded: [], already, reminded: [] };
  return { halted: false, recorded: fresh.map(item => item.decision), already, reminded: reminders.map(item => item.decision) };
}

export interface JournalRow {
  id: number; revision: number; kind: string; actor: string; task_id: string; action: string;
  rule: string; subject: string; reason: string; state_hash: string; created_at: number;
}

/** Lecture du journal d'un cycle, dans l'ordre d'écriture. */
export async function readDecisions(db: D1Database, cycleId: string, limit = 200): Promise<JournalRow[]> {
  await ensureControllerJournal(db);
  const rows = await db.prepare([
    'SELECT id, revision, kind, actor, task_id, action, rule, subject, reason, state_hash, created_at',
    'FROM controller_decisions WHERE cycle_id = ?1 ORDER BY id LIMIT ?2',
  ].join(' ')).bind(cycleId, Math.min(Math.max(Math.trunc(limit), 1), 1000)).all<JournalRow>();
  return rows.results;
}

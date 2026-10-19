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

/** Clé stable : cycle + contenu de la décision (jamais la révision ni l'heure). */
export async function decisionKey(cycleId: string, decision: Decision): Promise<string> {
  return sha256Hex([cycleId, decision.kind, decision.actor, decision.task_id ?? '', decision.action,
    decision.rule, decision.subject].join('\u001f'));
}

export interface JournalResult { recorded: Decision[]; already: Decision[] }

/** Enregistre les décisions nouvelles en un lot ; les décisions déjà vues sont signalées, jamais réécrites. */
export async function recordDecisions(db: D1Database, input: {
  cycleId: string; revision: number; stateHash: string; decisions: Decision[]; now: number;
}): Promise<JournalResult> {
  await ensureControllerJournal(db);
  if (input.decisions.length === 0) return { recorded: [], already: [] };
  const keys = await Promise.all(input.decisions.map(decision => decisionKey(input.cycleId, decision)));
  const placeholders = keys.map((_, index) => '?' + (index + 1)).join(', ');
  const seen = await db.prepare('SELECT decision_key FROM controller_decisions WHERE decision_key IN (' + placeholders + ')')
    .bind(...keys).all<{ decision_key: string }>();
  const known = new Set(seen.results.map(row => row.decision_key));
  const fresh = input.decisions.map((decision, index) => ({ decision, key: keys[index] })).filter(item => !known.has(item.key));
  if (fresh.length) {
    await db.batch(fresh.map(({ decision, key }) => db.prepare([
      'INSERT OR IGNORE INTO controller_decisions',
      '(cycle_id, decision_key, revision, kind, actor, task_id, action, rule, subject, reason, state_hash, created_at)',
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)',
    ].join(' ')).bind(input.cycleId, key, input.revision, decision.kind, decision.actor, decision.task_id ?? '',
      decision.action, decision.rule, decision.subject, decision.reason, input.stateHash, input.now)));
  }
  return { recorded: fresh.map(item => item.decision), already: input.decisions.filter((_, index) => known.has(keys[index])) };
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

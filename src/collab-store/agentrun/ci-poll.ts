/**
 * CC8 S7 — relevés de CI sans appel modèle (vote seq 1657, option seq 1665, GO de Kevin le 2026-11-06).
 *
 * Constat (audit seq 1626, pilotes Vibe n° 1 à 3) : chaque relevé d'une CI encore `pending`
 * passait par le modèle. Il consommait une étape, un appel complet (consigne, schémas, dernière étape)
 * et des jetons, et multipliait les appels vers un palier gratuit qui répond déjà 429.
 *
 * Ici, quand le DERNIER effet de la dernière étape terminée est un `github_check_result` qui
 * demande d'attendre (`next_action = 'wait'`), le serveur relit LUI-MÊME la CI à l'alarme suivante :
 * - même outil, mêmes arguments, mêmes gardes (authorize : HALT, pause, bail/fence, tâche active,
 *   head de la branche, cible corrélée) — le modèle ne fournit rien de nouveau ;
 * - aucune étape (`steps_done` inchangé), aucun appel modèle, aucun jeton ;
 * - au plus CI_POLL_MAX relevés par appel d'origine, et jamais à moins de CI_POLL_FLOOR_S de la deadline ;
 * - journal append-only `agent_run_ci_polls` : la ligne d'effet d'origine n'est jamais réécrite ;
 * - relecture D12 GPT-6 (seq 1687) : le relevé k est RÉCLAMÉ dans D1 (ligne `pending`, CAS) AVANT
 *   toute lecture GitHub — deux alarmes (at-least-once, entrelacement sur await) ne lisent jamais deux
 *   fois le même k ; une réclamation périmée (réponse perdue, coupure) est close `ambiguous` sans
 *   nouvelle lecture et le relevé suivant prend k + 1 ; triggers SQL : aucune suppression, et une ligne
 *   ne change qu'une fois, de `pending` vers `completed` ou `ambiguous`.
 * Le modèle n'est rappelé qu'une fois la CI terminée (ou les relevés épuisés, ou un refus) ; il voit
 * alors le dernier relevé comme résultat de son appel d'origine.
 */
import { sha256Hex } from '../store/hash';
import type { ToolCall } from './engine';

export const CI_POLL_TOOL = 'github_check_result';
export const CI_POLL_MAX = 20;
/** Marge minimale avant la deadline pour lancer un relevé (même plancher que les effets S1b-2). */
export const CI_POLL_FLOOR_S = 30;
/** Réclamation d'un relevé en vol : au-delà, elle est close `ambiguous` (même borne que les effets). */
export const CI_POLL_CLAIM_S = 120;

const ensured = new WeakSet<D1Database>();

export async function ensureCiPollSchema(db: D1Database): Promise<void> {
  if (ensured.has(db)) return;
  await db.batch([
    db.prepare([
      'CREATE TABLE IF NOT EXISTS agent_run_ci_polls (',
      '  run_id TEXT NOT NULL,',
      '  n INTEGER NOT NULL,',
      '  idx INTEGER NOT NULL,',
      '  k INTEGER NOT NULL,',
      "  status TEXT NOT NULL CHECK (status IN ('pending','completed','ambiguous')),",
      "  claimed_by TEXT NOT NULL,",
      '  claimed_at INTEGER NOT NULL,',
      "  result TEXT NOT NULL DEFAULT '',",
      '  completed_at INTEGER,',
      '  PRIMARY KEY (run_id, n, idx, k)',
      ')',
    ].join(' ')),
    db.prepare("CREATE TRIGGER IF NOT EXISTS agent_run_ci_polls_no_delete BEFORE DELETE ON agent_run_ci_polls"
      + " BEGIN SELECT RAISE(ABORT, 'append-only'); END"),
    // Une seule transition permise : pending → completed | ambiguous, identité de la ligne inchangée.
    db.prepare(["CREATE TRIGGER IF NOT EXISTS agent_run_ci_polls_frozen BEFORE UPDATE ON agent_run_ci_polls",
      "WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('completed','ambiguous')",
      '  OR NEW.run_id <> OLD.run_id OR NEW.n <> OLD.n OR NEW.idx <> OLD.idx OR NEW.k <> OLD.k',
      '  OR NEW.claimed_by <> OLD.claimed_by OR NEW.claimed_at <> OLD.claimed_at',
      "BEGIN SELECT RAISE(ABORT, 'append-only'); END"].join(' ')),
  ]);
  ensured.add(db);
}

/** Un relevé est-il demandé ? Lecture seule du résultat (effet d'origine ou dernier relevé). */
export function ciWaitRequested(result: string | null | undefined): boolean {
  if (!result) return false;
  try {
    const value: unknown = JSON.parse(result);
    return !!value && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).next_action === 'wait';
  } catch {
    return false;
  }
}

export interface PendingCiPoll {
  n: number;
  idx: number;
  /** Appel d'origine, tel que le modèle l'a émis (id, nom, arguments). */
  call: ToolCall;
  /** Relevés déjà réclamés pour cet appel (en vol compris). */
  polls: number;
  /** Relevé k encore en vol (réclamé, sans issue) : à attendre, ou à clore s'il est périmé. */
  inflight?: { k: number; claimed_by: string; claimed_at: number };
}

/**
 * Relevé à faire pour l'exécution, ou null. Conditions cumulatives :
 * - au moins une étape terminée et AUCUNE étape suivante réclamée (pas de concurrence avec une étape modèle) ;
 * - le dernier effet de cette étape est un github_check_result terminé ;
 * - son dernier résultat connu (relevé le plus récent, sinon l'effet) demande d'attendre ;
 * - moins de CI_POLL_MAX relevés déjà faits.
 */
export async function pendingCiPoll(db: D1Database, runId: string, stepsDone: number): Promise<PendingCiPoll | null> {
  if (stepsDone < 1) return null;
  const n = stepsDone - 1;
  const next = await db.prepare('SELECT 1 AS x FROM agent_run_steps WHERE run_id = ?1 AND n = ?2').bind(runId, stepsDone).first();
  if (next) return null;
  const last = await db.prepare(
    'SELECT idx, tool, status, result FROM agent_run_effects WHERE run_id = ?1 AND n = ?2 ORDER BY idx DESC LIMIT 1',
  ).bind(runId, n).first<{ idx: number; tool: string; status: string; result: string | null }>();
  if (!last || last.tool !== CI_POLL_TOOL || last.status !== 'completed') return null;
  const poll = await db.prepare(
    'SELECT k, status, claimed_by, claimed_at, result FROM agent_run_ci_polls WHERE run_id = ?1 AND n = ?2 AND idx = ?3 ORDER BY k DESC LIMIT 1',
  ).bind(runId, n, last.idx).first<{ k: number; status: string; claimed_by: string; claimed_at: number; result: string }>();
  const polls = poll?.k ?? 0;
  const inflight = poll?.status === 'pending' ? { k: poll.k, claimed_by: poll.claimed_by, claimed_at: poll.claimed_at } : undefined;
  if (!inflight && (polls >= CI_POLL_MAX || !ciWaitRequested(poll ? poll.result : last.result))) return null;
  const step = await db.prepare("SELECT model_output FROM agent_run_steps WHERE run_id = ?1 AND n = ?2 AND state = 'completed'")
    .bind(runId, n).first<{ model_output: string | null }>();
  if (!step?.model_output) return null;
  let call: ToolCall | undefined;
  try {
    const output = JSON.parse(step.model_output) as { tool_calls?: ToolCall[] };
    call = output.tool_calls?.[last.idx];
  } catch {
    return null;
  }
  if (!call || call.name !== CI_POLL_TOOL) return null;
  return { n, idx: last.idx, call, polls, ...(inflight ? { inflight } : {}) };
}

/** Clé d'effet déterministe d'un relevé : rejouable après coupure, jamais partagée avec l'effet d'origine. */
export async function ciPollKey(runId: string, pending: PendingCiPoll, k: number): Promise<string> {
  return sha256Hex(JSON.stringify(['ci-poll', runId, pending.n, pending.idx, k]));
}

/**
 * Réclame le relevé k AVANT toute lecture externe. `guard` est une condition SQL (garde LIVE du moteur,
 * ?1 = run_id) évaluée dans le même ordre d'insertion. true = ce worker détient k ; false = k déjà pris.
 */
export async function claimCiPoll(db: D1Database, runId: string, pending: PendingCiPoll, k: number,
  worker: string, now: number, guard: string): Promise<boolean> {
  const claimed = await db.prepare([
    'INSERT OR IGNORE INTO agent_run_ci_polls (run_id, n, idx, k, status, claimed_by, claimed_at)',
    "SELECT ?1, ?2, ?3, ?4, 'pending', ?5, ?6 WHERE " + guard,
  ].join(' ')).bind(runId, pending.n, pending.idx, k, worker, now).run();
  return claimed.meta.changes === 1;
}

/** Issue du relevé k : seulement par son détenteur, seulement depuis `pending` (le trigger le garantit aussi). */
export async function completeCiPoll(db: D1Database, runId: string, pending: PendingCiPoll, k: number,
  claim: { claimed_by: string; claimed_at: number }, status: 'completed' | 'ambiguous', result: string, now: number): Promise<boolean> {
  const done = await db.prepare([
    'UPDATE agent_run_ci_polls SET status = ?7, result = ?8, completed_at = ?9',
    "WHERE run_id = ?1 AND n = ?2 AND idx = ?3 AND k = ?4 AND status = 'pending' AND claimed_by = ?5 AND claimed_at = ?6",
  ].join(' ')).bind(runId, pending.n, pending.idx, k, claim.claimed_by, claim.claimed_at, status, result, now).run();
  return done.meta.changes === 1;
}

/** Dernier relevé de chaque appel d'origine d'une exécution : clé `${n}:${idx}`. */
export async function latestCiPolls(db: D1Database, runId: string): Promise<Map<string, { k: number; result: string }>> {
  await ensureCiPollSchema(db);
  const { results } = await db.prepare([
    "SELECT p.n, p.idx, p.k, p.result FROM agent_run_ci_polls p WHERE p.run_id = ?1 AND p.status <> 'pending'",
    "AND p.k = (SELECT MAX(q.k) FROM agent_run_ci_polls q WHERE q.run_id = p.run_id AND q.n = p.n AND q.idx = p.idx AND q.status <> 'pending')",
  ].join(' ')).bind(runId).all<{ n: number; idx: number; k: number; result: string }>();
  return new Map(results.map(row => [row.n + ':' + row.idx, { k: row.k, result: row.result }]));
}

/** Tous les relevés d'une exécution, dans l'ordre (n, idx, k), pour la garde de complétude. */
export async function allCiPolls(db: D1Database, runId: string): Promise<Array<{ n: number; idx: number; k: number; result: string }>> {
  await ensureCiPollSchema(db);
  const { results } = await db.prepare("SELECT n, idx, k, result FROM agent_run_ci_polls WHERE run_id = ?1 AND status = 'completed' ORDER BY n, idx, k")
    .bind(runId).all<{ n: number; idx: number; k: number; result: string }>();
  return results;
}

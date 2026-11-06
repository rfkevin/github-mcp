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
 * - journal append-only `agent_run_ci_polls` : la ligne d'effet d'origine n'est jamais réécrite.
 * Le modèle n'est rappelé qu'une fois la CI terminée (ou les relevés épuisés, ou un refus) ; il voit
 * alors le dernier relevé comme résultat de son appel d'origine.
 */
import { sha256Hex } from '../store/hash';
import type { ToolCall } from './engine';

export const CI_POLL_TOOL = 'github_check_result';
export const CI_POLL_MAX = 20;
/** Marge minimale avant la deadline pour lancer un relevé (même plancher que les effets S1b-2). */
export const CI_POLL_FLOOR_S = 30;

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
      '  result TEXT NOT NULL,',
      '  created_at INTEGER NOT NULL,',
      '  PRIMARY KEY (run_id, n, idx, k)',
      ')',
    ].join(' ')),
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
  /** Relevés déjà faits pour cet appel. */
  polls: number;
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
    'SELECT k, result FROM agent_run_ci_polls WHERE run_id = ?1 AND n = ?2 AND idx = ?3 ORDER BY k DESC LIMIT 1',
  ).bind(runId, n, last.idx).first<{ k: number; result: string }>();
  const polls = poll?.k ?? 0;
  if (polls >= CI_POLL_MAX || !ciWaitRequested(poll ? poll.result : last.result)) return null;
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
  return { n, idx: last.idx, call, polls };
}

/** Clé d'effet déterministe d'un relevé : rejouable après coupure, jamais partagée avec l'effet d'origine. */
export async function ciPollKey(runId: string, pending: PendingCiPoll, k: number): Promise<string> {
  return sha256Hex(JSON.stringify(['ci-poll', runId, pending.n, pending.idx, k]));
}

/** Enregistre le relevé k (append-only ; un doublon après coupure est ignoré). */
export async function recordCiPoll(db: D1Database, runId: string, pending: PendingCiPoll, k: number,
  result: string, now: number): Promise<void> {
  await db.prepare('INSERT OR IGNORE INTO agent_run_ci_polls (run_id, n, idx, k, result, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(runId, pending.n, pending.idx, k, result, now).run();
}

/** Dernier relevé de chaque appel d'origine d'une exécution : clé `${n}:${idx}`. */
export async function latestCiPolls(db: D1Database, runId: string): Promise<Map<string, { k: number; result: string }>> {
  await ensureCiPollSchema(db);
  const { results } = await db.prepare([
    'SELECT p.n, p.idx, p.k, p.result FROM agent_run_ci_polls p WHERE p.run_id = ?1',
    'AND p.k = (SELECT MAX(q.k) FROM agent_run_ci_polls q WHERE q.run_id = p.run_id AND q.n = p.n AND q.idx = p.idx)',
  ].join(' ')).bind(runId).all<{ n: number; idx: number; k: number; result: string }>();
  return new Map(results.map(row => [row.n + ':' + row.idx, { k: row.k, result: row.result }]));
}

/** Tous les relevés d'une exécution, dans l'ordre (n, idx, k), pour la garde de complétude. */
export async function allCiPolls(db: D1Database, runId: string): Promise<Array<{ n: number; idx: number; k: number; result: string }>> {
  await ensureCiPollSchema(db);
  const { results } = await db.prepare('SELECT n, idx, k, result FROM agent_run_ci_polls WHERE run_id = ?1 ORDER BY n, idx, k')
    .bind(runId).all<{ n: number; idx: number; k: number; result: string }>();
  return results;
}

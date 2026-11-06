/**
 * CC-5 l7e — continuité chat / API : lister, préempter et relâcher les exécutions
 * du participant serveur uniquement (masquage CR-C). N'utilise que les exports
 * publics du moteur (preemptByChat, releaseChat, runSummary, leaseKeyOf).
 */
import { cycleMandateEpoch } from '../coordinator/mandate';
import { ensureAgentRunSchema } from './schema';
import { preemptByChat, releaseChat, runSummary, leaseKeyOf } from './engine';

export const CHAT_HOLD_SECONDS_DEFAULT = 900;
export const LIST_RUNS_LIMIT = 40;

export interface AgentRunListItem {
  run_id: string;
  cycle_id: string;
  task_id: string;
  task_kind: string;
  status: string;
  steps_done: number;
  tokens_used: number;
  cost_cents: number;
  stop_reason: string;
  summary: string;
  updated_at: number;
  fence_holder: string | null;
  fence_generation: number | null;
}

/** Liste les exécutions d'UN participant (jamais un autre — CR-C). */
export async function listRunsForParticipant(
  db: D1Database,
  participantId: string,
  options: { cycleId?: string; limit?: number } = {},
): Promise<AgentRunListItem[]> {
  await ensureAgentRunSchema(db);
  const limit = Math.min(LIST_RUNS_LIMIT, Math.max(1, options.limit ?? LIST_RUNS_LIMIT));
  const cycle = options.cycleId?.trim() || null;
  const sql = cycle
    ? [
        'SELECT r.run_id, r.cycle_id, r.task_id, r.task_kind, r.status, r.steps_done, r.tokens_used,',
        '  r.cost_cents, r.stop_reason, r.summary, r.updated_at, f.holder AS fence_holder, f.generation AS fence_generation',
        'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
        'WHERE r.participant_id = ?1 AND r.cycle_id = ?2 ORDER BY r.updated_at DESC LIMIT ?3',
      ].join(' ')
    : [
        'SELECT r.run_id, r.cycle_id, r.task_id, r.task_kind, r.status, r.steps_done, r.tokens_used,',
        '  r.cost_cents, r.stop_reason, r.summary, r.updated_at, f.holder AS fence_holder, f.generation AS fence_generation',
        'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
        'WHERE r.participant_id = ?1 ORDER BY r.updated_at DESC LIMIT ?2',
      ].join(' ');
  const stmt = cycle
    ? db.prepare(sql).bind(participantId, cycle, limit)
    : db.prepare(sql).bind(participantId, limit);
  const { results } = await stmt.all<AgentRunListItem>();
  return results ?? [];
}

/** Résumé d'une exécution uniquement si elle appartient au participant. */
export async function runSummaryForParticipant(
  db: D1Database,
  participantId: string,
  runId: string,
): Promise<(NonNullable<Awaited<ReturnType<typeof runSummary>>> & { run_id: string; cycle_id: string; task_id: string }) | null> {
  await ensureAgentRunSchema(db);
  const row = await db.prepare(
    'SELECT run_id, cycle_id, task_id FROM agent_runs WHERE run_id = ?1 AND participant_id = ?2',
  ).bind(runId, participantId).first<{ run_id: string; cycle_id: string; task_id: string }>();
  if (!row) return null;
  const summary = await runSummary(db, runId);
  if (!summary) return null;
  return { ...summary, run_id: row.run_id, cycle_id: row.cycle_id, task_id: row.task_id };
}

// ---------------------------------------------------------------- CC8 S7 lot B R5 (#282) : résumé expurgé

/** Seuls champs d'un résultat d'outil repris dans le résumé expurgé (identifiants, SHA, statuts). */
const RECEIPT_KEYS = ['branch', 'sha', 'head_sha', 'commit_sha', 'base_sha', 'targetSha', 'runId', 'run_id', 'number', 'status',
  'conclusion', 'next_action', 'verifiedSuccess', 'draft', 'merged', 'error'] as const;
const SAFE_VALUE = /^[A-Za-z0-9_.:/-]{1,64}$/;
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{16,}/g, /sk-[A-Za-z0-9_-]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, /AKIA[0-9A-Z]{16}/g, /AIza[0-9A-Za-z_-]{20,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi];

/** Masque les formes connues de secrets dans un texte borné. */
export function maskSecrets(text: string, max = 500): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '[masqué]'), text).slice(0, max);
}

/** Valeur scalaire sûre : booléen, nombre fini, ou court identifiant sans forme de secret. */
function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !SAFE_VALUE.test(value) || maskSecrets(value) !== value) return undefined;
  // Longue chaîne mêlant majuscules, minuscules et chiffres (jeton probable), sauf SHA hexadécimal : écartée.
  if (value.length >= 20 && !/^[a-f0-9]{40}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return undefined;
  return value;
}

/** Reçu d'un résultat JSON : liste blanche de clés et valeurs sûres, rien d'autre. */
export function redactedReceipt(result: string | null): Record<string, string | number | boolean> {
  const receipt: Record<string, string | number | boolean> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(result ?? ''); } catch { return receipt; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return receipt;
  for (const key of RECEIPT_KEYS) {
    const value = safeScalar((parsed as Record<string, unknown>)[key]);
    if (value !== undefined) receipt[key] = value;
  }
  return receipt;
}

/**
 * Résumé déterministe et EXPURGÉ d'une exécution, pour son propriétaire ou le coordinateur du cycle :
 * statut, stop_reason (secrets masqués), étapes (serveur / modèle), jetons, coût, effets réduits à leurs
 * reçus, relevés CI, appels modèle (maillon choisi, servi, repli), preuve serveur. Jamais de prompt, de
 * sortie modèle, d'arguments d'outil, de contenu de fichier ni de résumé texte du modèle.
 */
export async function redactedRunSummary(db: D1Database, runId: string) {
  await ensureAgentRunSchema(db);
  const run = await db.prepare([
    'SELECT run_id, cycle_id, participant_id, task_id, task_kind, status, stop_reason, steps_done, max_steps, tokens_used, cost_cents,',
    '  created_at, updated_at, (SELECT COUNT(*) FROM agent_run_server_steps s WHERE s.run_id = agent_runs.run_id) AS server_steps',
    'FROM agent_runs WHERE run_id = ?1',
  ].join(' ')).bind(runId).first<{ run_id: string; cycle_id: string; participant_id: string; task_id: string; task_kind: string;
    status: string; stop_reason: string; steps_done: number; max_steps: number; tokens_used: number; cost_cents: number;
    created_at: number; updated_at: number; server_steps: number }>();
  if (!run) return null;
  const all = async <T>(sql: string): Promise<T[]> => {
    try {
      return (await db.prepare(sql).bind(runId).all<T>()).results ?? [];
    } catch {
      return []; // table optionnelle absente (relevés CI, choix de modèle)
    }
  };
  const effects = await all<{ n: number; idx: number; tool: string; status: string; result: string | null }>(
    'SELECT n, idx, tool, status, result FROM agent_run_effects WHERE run_id = ?1 ORDER BY n, idx');
  const polls = await all<{ n: number; idx: number; k: number; status: string; result: string }>(
    'SELECT n, idx, k, status, result FROM agent_run_ci_polls WHERE run_id = ?1 ORDER BY n, idx, k');
  const calls = await all<{ n: number; k: number; chosen_ref: string; ref: string; ok: number; failure: string; latency_ms: number }>(
    'SELECT n, k, chosen_ref, ref, ok, failure, latency_ms FROM agent_run_model_calls WHERE run_id = ?1 ORDER BY n, k');
  const choices = await all<{ n: number; ref: string; chosen_by: string; effort: string | null }>(
    'SELECT n, ref, chosen_by, effort FROM agent_model_choices WHERE run_id = ?1 ORDER BY n');
  const proof = await db.prepare('SELECT status, reason, attempts, event_seq FROM agent_run_proofs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; reason: string; attempts: number; event_seq: number | null }>();
  return {
    run_id: run.run_id, cycle_id: run.cycle_id, participant_id: run.participant_id, task_id: run.task_id, task_kind: run.task_kind,
    status: run.status, stop_reason: maskSecrets(run.stop_reason ?? ''), steps_done: run.steps_done, server_steps: run.server_steps,
    model_steps: run.steps_done - run.server_steps, max_steps: run.max_steps, tokens_used: run.tokens_used, cost_cents: run.cost_cents,
    created_at: run.created_at, updated_at: run.updated_at,
    effects: effects.map(e => ({ n: e.n, idx: e.idx, tool: e.tool, status: e.status, receipt: redactedReceipt(e.result) })),
    ci_polls: polls.map(p => ({ n: p.n, idx: p.idx, k: p.k, status: p.status, receipt: redactedReceipt(p.result) })),
    model_choices: choices.map(c => ({ n: c.n, ref: c.ref, chosen_by: c.chosen_by, effort: c.effort })),
    model_calls: calls.map(c => ({ n: c.n, k: c.k, chosen_ref: c.chosen_ref, served_ref: c.ref, ok: c.ok === 1,
      fallback: c.ref !== c.chosen_ref, failure: c.failure, latency_ms: c.latency_ms })),
    proof: proof ? { status: proof.status, reason: proof.reason, attempts: proof.attempts, event_seq: proof.event_seq } : null,
  };
}

/**
 * Résumé expurgé lisible par le propriétaire du run OU par le coordinateur qui tient le mandat actif
 * du cycle du run (R5). Toute autre identité : null (aucune fuite d'existence).
 */
export async function redactedRunSummaryFor(db: D1Database, participantId: string, runId: string) {
  await ensureAgentRunSchema(db);
  const row = await db.prepare('SELECT cycle_id, participant_id FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ cycle_id: string; participant_id: string }>();
  if (!row) return null;
  if (row.participant_id !== participantId) {
    try {
      await cycleMandateEpoch(db, row.cycle_id, participantId, 'AGENT_RUN_NOT_OWNED');
    } catch {
      return null;
    }
  }
  return redactedRunSummary(db, runId);
}

/**
 * CC-7 L1 — préemption chat par identité (S5).
 * Le bail est dérivé de (cycle, participant, task) via leaseKeyOf : le chat peut
 * prendre la main AVANT toute exécution API. Plus d'exigence de run préalable
 * (sinon le chat ne pouvait pas ouvrir le bail automatiquement).
 * L'identité est celle du jeton serveur ; on ne touche jamais le fence d'autrui.
 */
export async function preemptOwnRun(
  db: D1Database,
  input: { participantId: string; cycleId: string; taskId: string; now: number; holdSeconds?: number },
): Promise<{ ok: true; generation: number } | { ok: false; reason: 'not_owner' }> {
  if (!input.participantId || !input.cycleId) return { ok: false, reason: 'not_owner' };
  await ensureAgentRunSchema(db);
  const generation = await preemptByChat(db, {
    cycleId: input.cycleId,
    participantId: input.participantId,
    taskId: input.taskId || '',
    now: input.now,
    holdSeconds: input.holdSeconds ?? CHAT_HOLD_SECONDS_DEFAULT,
  });
  return { ok: true, generation };
}

/** CC-7 L1 — relâchement chat par identité ; pas d'exigence de run préalable. */
export async function releaseOwnRun(
  db: D1Database,
  input: { participantId: string; cycleId: string; taskId: string; now: number },
): Promise<{ ok: true } | { ok: false; reason: 'not_owner' }> {
  if (!input.participantId || !input.cycleId) return { ok: false, reason: 'not_owner' };
  await ensureAgentRunSchema(db);
  await releaseChat(db, {
    cycleId: input.cycleId,
    participantId: input.participantId,
    taskId: input.taskId || '',
    now: input.now,
  });
  return { ok: true };
}

/** Vue owner lecture seule : dernières exécutions tous participants (pas de masquage CR-C côté owner). */
export async function listRunsForOwner(
  db: D1Database,
  limit = 30,
): Promise<Array<AgentRunListItem & { participant_id: string }>> {
  await ensureAgentRunSchema(db);
  const { results } = await db.prepare([
    'SELECT r.run_id, r.cycle_id, r.participant_id, r.task_id, r.task_kind, r.status, r.steps_done,',
    '  r.tokens_used, r.cost_cents, r.stop_reason, r.summary, r.updated_at,',
    '  f.holder AS fence_holder, f.generation AS fence_generation',
    'FROM agent_runs r LEFT JOIN agent_fences f ON f.lease_key = r.lease_key',
    'ORDER BY r.updated_at DESC LIMIT ?1',
  ].join(' ')).bind(Math.min(50, Math.max(1, limit))).all<AgentRunListItem & { participant_id: string }>();
  return results ?? [];
}

export { leaseKeyOf };

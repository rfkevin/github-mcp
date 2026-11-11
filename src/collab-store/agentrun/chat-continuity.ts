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

// Relecture D12 GPT-6 (PR #285, B2) : vue FAIL-CLOSED. Aucun texte libre : chaque champ repris est validé
// par une forme stricte ou une liste fermée ; tout le reste est écarté (pas de masquage par motifs de secrets,
// qui laisserait passer un format inconnu).
const SHA_FIELD = /^[a-f0-9]{40}$/;
const RECEIPT_FIELDS: Record<string, (value: unknown) => boolean> = {
  sha: v => typeof v === 'string' && SHA_FIELD.test(v),
  head_sha: v => typeof v === 'string' && SHA_FIELD.test(v),
  commit_sha: v => typeof v === 'string' && SHA_FIELD.test(v),
  base_sha: v => typeof v === 'string' && SHA_FIELD.test(v),
  targetSha: v => typeof v === 'string' && SHA_FIELD.test(v),
  branch: v => typeof v === 'string' && /^mcp\/\d{1,20}\/[a-z0-9][a-z0-9._-]{0,80}$/.test(v),
  number: v => Number.isSafeInteger(v) && Number(v) > 0,
  runId: v => Number.isSafeInteger(v) && Number(v) > 0,
  run_id: v => Number.isSafeInteger(v) && Number(v) > 0,
  status: v => typeof v === 'string' && ['queued', 'in_progress', 'completed', 'pending', 'requested', 'waiting', 'open', 'closed'].includes(v),
  conclusion: v => typeof v === 'string'
    && ['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale'].includes(v),
  next_action: v => typeof v === 'string' && ['wait', 'correct', 'request_D12', 'escalate'].includes(v),
  verifiedSuccess: v => typeof v === 'boolean',
  draft: v => typeof v === 'boolean',
  merged: v => typeof v === 'boolean',
};

/** Reçu d'un résultat JSON : seuls les champs de RECEIPT_FIELDS dont la valeur a la forme attendue. */
export function redactedReceipt(result: string | null): Record<string, string | number | boolean> {
  const receipt: Record<string, string | number | boolean> = {};
  let parsed: unknown;
  try { parsed = JSON.parse(result ?? ''); } catch { return receipt; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return receipt;
  for (const [key, valid] of Object.entries(RECEIPT_FIELDS)) {
    const value = (parsed as Record<string, unknown>)[key];
    if (valid(value)) receipt[key] = value as string | number | boolean;
  }
  return receipt;
}

/** Causes typées issues du moteur uniquement ; aucun texte libre n'est exposé aux autres agents.
 * CC8 U1 : les arrêts de préparation et l'absence d'effet store doivent être diagnostiquables
 * par le coordinateur sans divulguer les sorties, arguments ou erreurs du modèle.
 */
const STOP_CLASSES = new Set(['no_tool_call', 'tool_not_offered', 'multiple_tool_calls', 'branch_name', 'scope_refused', 'scope_invalid',
  'branch_refused', 'checks_refused', 'check_unexpected', 'pr_already_open', 'server_cap', 'tool_unavailable', 'precheck_failed',
  'github_evidence_missing', 'ci_escalate', 'ci_unknown', 'preparation_incomplete',
  'preparation_tools_unavailable', 'preparation_base_unverified', 'task_grant_unavailable',
  'commit_budget_exhausted', 'store_effect_missing']);

/**
 * Ensemble FERMÉ des codes d'arrêt écrits par le moteur (settle, stopAs, arrêts guidés, fin d'exécution).
 * Relecture D12 GPT-6 #285 (B2) : un préfixe syntaxiquement valide mais inconnu (« zq7hush: … ») peut
 * venir d'un texte libre ; il n'est jamais repris, seul « other » l'est.
 */
export const STOP_CODES: ReadonlySet<string> = new Set(['final', 'halted', 'preempted', 'step_limit', 'token_limit', 'cost_limit',
  'deadline', 'step_attempts_exhausted', 'model_transient', 'model_permanent', 'effect_outcome_unknown', 'guided_stop',
  'guided_violation', 'guided_preparation_violation', 'guided_handover_violation', 'incomplete_final']);

/** Code d'arrêt typé (ensemble fermé) et cause connue ; jamais le texte libre de stop_reason. */
export function typedStop(stopReason: string | null): { stop_code: string; stop_class: string | null } {
  const [code, detail] = (stopReason ?? '').split(':').map(part => part.trim());
  const stopCode = STOP_CODES.has(code ?? '') ? code : 'other';
  return { stop_code: stopCode, stop_class: detail && STOP_CLASSES.has(detail) ? detail : null };
}

/**
 * Résumé déterministe et EXPURGÉ d'une exécution, pour son propriétaire ou le coordinateur du cycle :
 * statut, code d'arrêt typé (jamais le texte libre de stop_reason), étapes (serveur / modèle), jetons, coût,
 * effets réduits à leurs reçus validés, relevés CI, appels modèle (maillon choisi, servi, repli), preuve
 * serveur. Jamais de prompt, de sortie modèle, d'argument d'outil, de contenu de fichier, de message
 * d'erreur ni de résumé texte du modèle.
 */
/** E0 : ne renvoyer que des COMPTEURS issus du JSON du modèle, jamais son contenu. */
function toolCallCount(output: string | null): number | null {
  if (output === null) return null;
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const calls = (value as { tool_calls?: unknown }).tool_calls;
    return Array.isArray(calls) ? calls.length : null;
  } catch {
    return null;
  }
}

const STEP_TRACE_STATES = new Set(['claimed', 'completed', 'failed', 'pending']);

export async function redactedRunSummary(db: D1Database, runId: string) {
  await ensureAgentRunSchema(db);
  const run = await db.prepare([
    'SELECT run_id, cycle_id, participant_id, task_id, task_kind, status, stop_reason, steps_done, max_steps, max_tokens, tokens_used, cost_cents, max_cost_cents,',
    '  created_at, updated_at, (SELECT COUNT(*) FROM agent_run_server_steps s WHERE s.run_id = agent_runs.run_id) AS server_steps',
    'FROM agent_runs WHERE run_id = ?1',
  ].join(' ')).bind(runId).first<{ run_id: string; cycle_id: string; participant_id: string; task_id: string; task_kind: string;
    status: string; stop_reason: string; steps_done: number; max_steps: number; max_tokens: number; tokens_used: number; cost_cents: number; max_cost_cents: number;
    created_at: number; updated_at: number; server_steps: number }>();
  if (!run) return null;
  const all = async <T>(sql: string): Promise<T[]> => {
    try {
      return (await db.prepare(sql).bind(runId).all<T>()).results ?? [];
    } catch {
      return []; // table optionnelle absente (relevés CI, choix de modèle)
    }
  };
  // Les anciennes sorties restent dans D1. Le client ne reçoit ni leur texte ni leurs arguments.
  const traces = await all<{ n: number; state: string; model_output: string | null; results: string | null;
    tokens: number; cost_cents: number }>(
    'SELECT n, state, model_output, results, tokens, cost_cents FROM agent_run_steps WHERE run_id = ?1 ORDER BY n DESC LIMIT 64');
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
    status: run.status, ...typedStop(run.stop_reason), steps_done: run.steps_done, server_steps: run.server_steps,
    model_steps: run.steps_done - run.server_steps, max_steps: run.max_steps, max_tokens: run.max_tokens,
    tokens_used: run.tokens_used, cost_cents: run.cost_cents, max_cost_cents: run.max_cost_cents,
    created_at: run.created_at, updated_at: run.updated_at,
    // E0 : outil demandé = compteur structurel ; outil exécuté = reçu redacted déjà présent dans effects.
    step_traces: traces.reverse().map(t => ({
      n: t.n, state: STEP_TRACE_STATES.has(t.state) ? t.state : 'other',
      model_output_recorded: t.model_output !== null,
      tool_calls_requested: toolCallCount(t.model_output),
      tool_results_recorded: t.results !== null,
      tokens: t.tokens, cost_cents: t.cost_cents,
    })),
    effects: effects.map(e => ({ n: e.n, idx: e.idx, tool: e.tool, status: e.status, receipt: redactedReceipt(e.result) })),
    ci_polls: polls.map(p => ({ n: p.n, idx: p.idx, k: p.k, status: p.status, receipt: redactedReceipt(p.result) })),
    model_choices: choices.map(c => ({ n: c.n, ref: c.ref, chosen_by: c.chosen_by, effort: c.effort })),
    model_calls: calls.map(c => ({ n: c.n, k: c.k, chosen_ref: c.chosen_ref, served_ref: c.ref, ok: c.ok === 1,
      fallback: c.ref !== c.chosen_ref, failure: c.failure === 'transient' || c.failure === 'permanent' ? c.failure : '', latency_ms: c.latency_ms })),
    // Raisons de preuve : codes posés par run-proof.ts (identifiants), jamais de texte externe.
    proof: proof ? { status: proof.status, reason: /^[a-z_:]{1,80}$/.test(proof.reason) ? proof.reason : 'other', attempts: proof.attempts,
      event_seq: proof.event_seq } : null,
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

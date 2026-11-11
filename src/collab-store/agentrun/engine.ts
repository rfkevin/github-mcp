/**
 * CC-5 l7 (incrément 7a) — moteur d'exécution autonome d'un agent API, une étape à la fois.
 *
 * Contrat (l7 v2.1 seq 457, note L7-1 v1.1 seq 462) :
 * - `runStep` fait UNE étape (appel modèle → outils → checkpoint) et rend la main.
 *   L'orchestrateur (Durable Object + alarme en 7b, ou une étape Workflows si
 *   Kevin passe en Workers Paid) l'appelle en boucle ; le moteur ne garde aucun
 *   état en mémoire : tout est relu dans D1, source de vérité.
 * - Double réveil : l'étape est réclamée par CAS (PRIMARY KEY (run_id, n)) ; le
 *   second appel reçoit `busy` et n'exécute rien.
 * - Réclamation liée (revue D12 #188) : chaque transition opérationnelle de
 *   l'étape (décision du modèle, intention et lancement d'un effet, checkpoint,
 *   arrêt) exige la réclamation EXACTE (claimed_by ET numéro de tentative) ; un
 *   ancien worker resté en vie après une reprise, même avec le même workerId,
 *   ne peut plus rien faire avancer.
 * - Effet en vol : un effet `pending` plus récent que EFFECT_TIMEOUT_S n'est pas
 *   repris (busy) ; le moteur borne lui-même chaque exécution d'outil à
 *   EFFECT_TIMEOUT_S (au-delà : ambiguous), toujours sous STEP_TIMEOUT_S.
 * - Fencing (L7-4) : chaque écriture de l'exécution revalide dans le même lot D1
 *   que la génération du bail est toujours la sienne, que le chat ne l'a pas
 *   reprise et que HALT n'est pas posé (garde LIVE).
 * - Effets externes (R2) : intent → pending → completed | failed | ambiguous.
 *   Un effet resté pending (crash entre l'effet et son enregistrement) n'est
 *   JAMAIS réémis à l'aveugle : `lookup` cherche s'il a eu lieu ; sans réponse
 *   sûre, l'exécution passe en `needs_reconcile`.
 * - Retries bornés : MAX_STEP_ATTEMPTS réclamations par étape, puis `failed`.
 * - Plafonds (R5) vérifiés à chaque étape : étapes, jetons, coût, échéance.
 * - Le canal API n'émet aucun verdict D12 LIBRE (L7-6) : outils interdits refusés en
 *   code même si l'hôte les déclare ; toute écriture reste soumise à
 *   `assertNotD12Verdict` SAUF `store_verdict` (L5b, S10) et `store_contribute`
 *   (L6b-2, sortie de phase de conception sans PR), seules portes à
 *   verdict du canal API, re-vérifiée serveur (verdict-tools.ts).
 *
 * Écritures hors garde, volontairement (audit) : l'usage d'un appel modèle (toujours
 * comptabilisé, même si l'étape est ensuite refusée ou si l'appel échoue, leçon L0),
 * le résultat réel d'un effet déjà envoyé (completed, failed, ambiguous), et `settle`
 * qui ne fait que constater une condition d'arrêt (HALT, préemption, plafond).
 */
import { sha256Hex } from '../store/hash';
import { API_AGENT_FORBIDDEN, assertNotD12Verdict } from '../agents/tools';
import { ensureAgentRunSchema } from './schema';
import { allCiPolls, ciPollKey, claimCiPoll, completeCiPoll, CI_POLL_CLAIM_S, CI_POLL_FLOOR_S, CI_POLL_TOOL, ensureCiPollSchema,
  latestCiPolls, pendingCiPoll, type PendingCiPoll } from './ci-poll';
import { modelFailureKind } from './model-failure';
import { verifyContext } from './verify-guided';
import { HANDOVER_WRITE_TOOLS, HANDOVER_INSTRUCTION, handoverViolation,
  PREPARATION_ROUNDS_MAX, PREPARATION_READ_TOOLS, PREPARATION_DISCOVERY_TOOLS,
  readPreparationEvidence, preparationInstruction, preparationNoToolCallFeedback,
  isRecoverablePreparationViolation, shouldRecoverPreparation, preparationRecoveriesRemaining,
  preparationViolation, type PreparationRecord } from './guided-preparation';
import { missionOf, type MissionKind } from './mission-quality';
import { applyGuidedFill, canonicalGuidedOutput, GUIDED_PRECHECK_TOOL, GUIDED_SERVER_MAX, GUIDED_TOOL, guidedPrecheck, guidedViolation,
  planGuidedS7, PRECHECK_HINTS, guidedBareDependencies, type GuidedStep } from './s7-guided';
// CC-8 S1b-2 : politique unique de temps (plan v2 seq 1376) — le moteur ne fait que l'appliquer.
import { EFFECT_LAUNCH_FLOOR_S, EFFECT_TIMEOUT_MS, STEP_MODEL_BUDGET_FLOOR_MS, STEP_TIMEOUT_MS, stepModelBudgetMs } from './run-policy';

// CC-8 S1b-2 : dérivée de la politique unique (run-policy.ts), API en secondes conservée.
export const STEP_TIMEOUT_S = STEP_TIMEOUT_MS / 1000;
/** S1b : trois réclamations au maximum par étape, bornées par deadline_at (15 min). */
export const MAX_STEP_ATTEMPTS = 3;
/** Durée maximale d'une exécution d'outil ; un effet pending plus récent est considéré en vol. */
export const EFFECT_TIMEOUT_S = EFFECT_TIMEOUT_MS / 1000;
export const MAX_TOOL_CALLS_PER_STEP = 8;
export const RESULT_MAX_CHARS = 16 * 1024;

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ModelOutput { text: string; tool_calls: ToolCall[] }
/** Split values are provided by the adapter when reported by the provider. */
export interface ModelUsage { tokens: number; cost_cents: number; input_tokens?: number | null; output_tokens?: number | null }
export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ModelClient {
  complete(input: { messages: AgentMessage[]; tools: string[]; task_kind: string;
    /** CC-8 S1b-2 : budget de temps restant pour les appels modèle de l'étape (ms, optionnel). */
    budget_left_ms?: number;
    /** Unspent aggregate input+output tokens prior to contacting the model provider. */
    budget_left_tokens?: number }): Promise<{ output: ModelOutput; usage: ModelUsage }>;
}

/** Erreur d'appel modèle qui porte l'usage déjà consommé (comptabilisé quand même). */
export class ModelCallError extends Error {
  constructor(message: string, readonly usage: ModelUsage | null = null) { super(message); }
}

/** Refus certain d'un outil : l'effet n'a PAS eu lieu (validation, garde). */
export class ToolRefused extends Error {}

export interface ToolSpec { name: string; effect: 'read' | 'write' }

export type LookupResult = { found: true; result: unknown } | { found: false } | null;

export interface ToolHost {
  /** Allowlist deny-by-default par type de tâche : null = outil refusé. */
  spec(taskKind: string, name: string): ToolSpec | null;
  list(taskKind: string): string[];
  /** prefetch : lecture préparée par le SERVEUR (vérification guidée), jamais posée par un appel modèle. */
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string; prefetch?: boolean }): Promise<unknown>;
  /** Après un effet incertain : l'effet a-t-il eu lieu ? null = impossible de savoir. */
  lookup?(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

export interface EngineDeps {
  model: ModelClient;
  tools: ToolHost;
  now: () => number;
  workerId: string;
  /** Borne d'exécution d'un outil en ms (défaut EFFECT_TIMEOUT_S), réduite par les tests. */
  effectTimeoutMs?: number;
  /** CC8: opt-in de compaction des anciens résultats pour le seul contexte fournisseur.
   * Les étapes et effets persistés D1 demeurent intacts (audit, reprise, fencing). */
  compactHistory?: boolean;
  /** Mandats GitHub de réussite posés par le propriétaire, jamais par le modèle. */
  githubCompletionGrants?: readonly GitHubCompletionGrant[];
  /** Grants D1 are checked on every planning/completion step, never injected by the model. */
  dynamicGrantFor?: (target:{cycle_id:string;task_id:string;participant_id:string})=>Promise<GitHubCompletionGrant|null>;
  /** CC8 S7 mode guidé : étapes mécaniques émises par le serveur sous mandat S7 (activé au runtime). */
  guidedS7?: boolean;
  /** CC8: opt-in consultation context/memory/repo before S7 code writes. */
  guidedPreparation?: boolean;
  /**
   * CC8 S7 vérification guidée (décision de Kevin, 07/11) : runs review/test avec contexte préparé par le
   * serveur (PR, CI au head, diff borné) réinjecté à chaque étape, outils libres. Activé au runtime.
   */
  guidedVerify?: boolean;
  /** Points de crash injectables pour les tests (lever une exception = coupure). */
  probe?: (point: 'after_model' | 'before_effect' | 'after_effect' | 'after_effect_recorded') => void | Promise<void>;
}

export interface GitHubCompletionGrant { cycle: string; participant: string; task: string; branch: string;
  /** Lot C R3 (#283) : mission déclarée par le propriétaire ; absent = pilote technique. */
  mission?: MissionKind; acceptance?: readonly string[] }

export type RunStatus = 'running' | 'completed' | 'failed' | 'halted' | 'preempted' | 'needs_reconcile'
  | 'step_limit' | 'token_limit' | 'cost_limit' | 'deadline';

export interface StepResult { outcome: RunStatus | 'stepped' | 'busy' | 'retry' | 'unknown_run' }

interface RunRow {
  run_id: string; cycle_id: string; participant_id: string; task_id: string;
  lease_key: string; generation: number; task_kind: string; status: RunStatus;
  steps_done: number; prompt: string;
  /** CC-8 S1b-2 : deadline d'exécution (secondes) — borne le budget d'appels modèle de l'étape. */
  deadline_at: number;
}
interface StepRow { state: string; claimed_by: string; claimed_at: number; attempts: number; model_output: string | null }
interface EffectRow { status: string; result: string | null; updated_at: number }
/** Réclamation exacte d'une étape : seul son titulaire courant peut la faire avancer. */
interface Claim { n: number; worker: string; attempts: number }
interface ResultEntry { id: string; content: string; error?: true }

export function leaseKeyOf(cycleId: string, participantId: string, taskId: string): string {
  return [cycleId, participantId, taskId || '~'].join('\u001f');
}

const HALTED = "EXISTS (SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1')";
/** Garde de toute écriture d'une exécution : ?1 = run_id. */
const LIVE = [
  'EXISTS (SELECT 1 FROM agent_runs r JOIN agent_fences f ON f.lease_key = r.lease_key',
  "  WHERE r.run_id = ?1 AND r.status = 'running' AND f.generation = r.generation AND f.holder = 'api')",
  'AND NOT ' + HALTED,
].join(' ');
/** Plafonds par exécution : ?1 = run_id, ?4 = maintenant. */
// CC8 S7 mode guidé : max_steps ne compte que les étapes modèle ; une étape serveur est bornée
// par son plafond propre (GUIDED_SERVER_MAX), les jetons, le coût et la deadline restant communs.
const SERVER_STEPS = '(SELECT COUNT(*) FROM agent_run_server_steps ss WHERE ss.run_id = ?1)';
const withinLimits = (server: boolean) => [
  'EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1',
  server ? '  AND ' + SERVER_STEPS + ' < ' + GUIDED_SERVER_MAX : '  AND steps_done - ' + SERVER_STEPS + ' < max_steps',
  '  AND tokens_used < max_tokens AND cost_cents <= max_cost_cents AND ?4 < deadline_at)',
].join(' ');
const WITHIN_LIMITS = withinLimits(false);
/** CC8 S7 mode guidé : empreinte des effets et relevés de CI d'une exécution (?1 = run_id), pour un arrêt CAS. */
const GUIDED_STATE = [
  "((SELECT COUNT(*) || ':' || COALESCE(SUM(status = 'completed'), 0) || ':' || COALESCE(SUM(status = 'failed'), 0)",
  '  FROM agent_run_effects WHERE run_id = ?1)',
  "  || '/' || (SELECT COUNT(*) || ':' || COALESCE(SUM(status = 'pending'), 0) FROM agent_run_ci_polls WHERE run_id = ?1))",
].join(' ');
/** Trace bornée d'une sortie modèle rejetée en mode guidé (journal). */
const GUIDED_TRACE_MAX = 2_000;

/** Réclamation exacte : ?1 = run_id ; les trois autres paramètres sont fournis par l'appelant. */
function claimHeld(n: string, worker: string, attempts: string): string {
  return 'EXISTS (SELECT 1 FROM agent_run_steps WHERE run_id = ?1 AND n = ' + n + ' AND claimed_by = ' + worker
    + " AND attempts = " + attempts + " AND state <> 'completed')";
}

function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort(byCodeUnit)
      .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function asContent(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > RESULT_MAX_CHARS ? text.slice(0, RESULT_MAX_CHARS) + '…[tronqué]' : text;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- bail et préemption

/** Le chat reprend la main (L7-4) : nouvelle génération, l'exécution API en cours perd ses écritures. */
export async function preemptByChat(db: D1Database, input: {
  cycleId: string; participantId: string; taskId: string; now: number; holdSeconds: number;
}): Promise<number> {
  await ensureAgentRunSchema(db);
  const key = leaseKeyOf(input.cycleId, input.participantId, input.taskId);
  await db.prepare([
    "INSERT INTO agent_fences (lease_key, generation, holder, held_until, updated_at) VALUES (?1, 1, 'chat', ?2, ?3)",
    "ON CONFLICT(lease_key) DO UPDATE SET generation = agent_fences.generation + 1, holder = 'chat',",
    '  held_until = excluded.held_until, updated_at = excluded.updated_at',
  ].join(' ')).bind(key, input.now + Math.max(0, input.holdSeconds), input.now).run();
  return (await db.prepare('SELECT generation FROM agent_fences WHERE lease_key = ?1').bind(key).first<{ generation: number }>())!.generation;
}

/** Fin de session chat : le bail redevient libre (sans nouvelle génération). */
export async function releaseChat(db: D1Database, input: { cycleId: string; participantId: string; taskId: string; now: number }): Promise<void> {
  await ensureAgentRunSchema(db);
  await db.prepare("UPDATE agent_fences SET holder = 'none', held_until = 0, updated_at = ?2 WHERE lease_key = ?1 AND holder = 'chat'")
    .bind(leaseKeyOf(input.cycleId, input.participantId, input.taskId), input.now).run();
}

// ---------------------------------------------------------------- création

export interface CreateRunInput {
  runId: string; cycleId: string; participantId: string; taskId: string; taskKind: string; prompt: string;
  maxSteps: number; maxTokens: number; maxCostCents: number; deadlineAt: number; now: number;
}

export type CreateRunResult = { created: true; generation: number } | { created: false; reason: string };

/**
 * Crée une exécution et prend le bail côté API dans UN lot D1 : refusé si HALT,
 * si le chat tient le bail, ou si une exécution est déjà active pour la même clé.
 * Même run_id rejoué : aucune seconde exécution.
 */
export async function createRun(db: D1Database, input: CreateRunInput): Promise<CreateRunResult> {
  await ensureAgentRunSchema(db);
  const key = leaseKeyOf(input.cycleId, input.participantId, input.taskId);
  const active = "SELECT 1 FROM agent_runs WHERE lease_key = ?1 AND status IN ('running','needs_reconcile')";
  await db.batch([
    db.prepare([
      "INSERT INTO agent_fences (lease_key, generation, holder, held_until, updated_at) SELECT ?1, 1, 'api', 0, ?2",
      'WHERE NOT ' + HALTED + ' AND NOT EXISTS (' + active + ')',
      "ON CONFLICT(lease_key) DO UPDATE SET generation = agent_fences.generation + 1, holder = 'api', held_until = 0,",
      "  updated_at = excluded.updated_at WHERE (agent_fences.holder <> 'chat' OR agent_fences.held_until <= excluded.updated_at)",
      '  AND NOT ' + HALTED,
    ].join(' ')).bind(key, input.now),
    db.prepare([
      'INSERT OR IGNORE INTO agent_runs (run_id, cycle_id, participant_id, task_id, lease_key, generation, task_kind, status,',
      '  max_steps, max_tokens, max_cost_cents, deadline_at, prompt, created_at, updated_at)',
      "SELECT ?2, ?3, ?4, ?5, ?1, f.generation, ?6, 'running', ?7, ?8, ?9, ?10, ?11, ?12, ?12",
      "FROM agent_fences f WHERE f.lease_key = ?1 AND f.holder = 'api' AND f.updated_at = ?12",
      '  AND NOT ' + HALTED + ' AND NOT EXISTS (' + active + ')',
    ].join(' ')).bind(key, input.runId, input.cycleId, input.participantId, input.taskId, input.taskKind,
      Math.max(1, input.maxSteps), Math.max(1, input.maxTokens), Math.max(0, input.maxCostCents), input.deadlineAt,
      input.prompt, input.now),
    // 7b : outbox de réveil dans le même lot, seulement si l'exécution vient d'être créée par ce lot.
    db.prepare([
      'INSERT OR IGNORE INTO agent_run_wakeups (run_id, lease_key, requested_at, status)',
      "SELECT ?1, ?2, ?3, 'pending' WHERE EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1 AND lease_key = ?2 AND created_at = ?3)",
    ].join(' ')).bind(input.runId, key, input.now),
  ]);
  const run = await db.prepare('SELECT generation, created_at, lease_key FROM agent_runs WHERE run_id = ?1')
    .bind(input.runId).first<{ generation: number; created_at: number; lease_key: string }>();
  if (run && run.created_at === input.now && run.lease_key === key) return { created: true, generation: run.generation };
  if (run) return { created: false, reason: 'run_exists' };
  if (await db.prepare('SELECT 1 FROM owner_flags WHERE name = ?1 AND value = ?2').bind('halt', '1').first()) {
    return { created: false, reason: 'halted' };
  }
  const fence = await db.prepare('SELECT holder, held_until FROM agent_fences WHERE lease_key = ?1').bind(key).first<{ holder: string; held_until: number }>();
  if (fence?.holder === 'chat' && fence.held_until > input.now) return { created: false, reason: 'chat_holds_lease' };
  return { created: false, reason: 'run_already_active' };
}

// ---------------------------------------------------------------- étape

async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare('SELECT run_id, cycle_id, participant_id, task_id, lease_key, generation, task_kind, status, steps_done, prompt, deadline_at FROM agent_runs WHERE run_id = ?1')
    .bind(runId).first<RunRow>();
}

/** Arrête l'exécution si une condition d'arrêt est vraie ; rend le statut courant. */
export async function settle(db: D1Database, runId: string, now: number, deferStepLimit = false): Promise<RunStatus> {
  const reason = [
    'CASE WHEN ' + HALTED + " THEN 'halted'",
    '  WHEN NOT EXISTS (SELECT 1 FROM agent_fences f WHERE f.lease_key = agent_runs.lease_key',
    "    AND f.generation = agent_runs.generation AND f.holder = 'api') THEN 'preempted'",
    // CC8 S7 mode guidé : étapes modèle seulement ; reportable quand la suite peut être une étape serveur.
    "  WHEN ?3 = 0 AND steps_done - (SELECT COUNT(*) FROM agent_run_server_steps ss WHERE ss.run_id = agent_runs.run_id) >= max_steps THEN 'step_limit'",
    "  WHEN tokens_used >= max_tokens THEN 'token_limit'",
    "  WHEN cost_cents > max_cost_cents THEN 'cost_limit'",
    "  WHEN ?2 >= deadline_at THEN 'deadline'",
    "  ELSE 'running' END",
  ].join(' ');
  await db.prepare('UPDATE agent_runs SET status = ' + reason + ', stop_reason = ' + reason
    + ", updated_at = ?2 WHERE run_id = ?1 AND status = 'running'").bind(runId, now, deferStepLimit ? 1 : 0).run();
  return (await db.prepare('SELECT status FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ status: RunStatus }>())!.status;
}

async function stopAs(db: D1Database, runId: string, status: 'failed' | 'needs_reconcile', reason: string, now: number, claim: Claim): Promise<void> {
  await db.prepare("UPDATE agent_runs SET status = ?2, stop_reason = ?3, updated_at = ?4 WHERE run_id = ?1 AND status = 'running' AND "
    + claimHeld('?5', '?6', '?7')).bind(runId, status, reason.slice(0, 500), now, claim.n, claim.worker, claim.attempts).run();
}

async function settled(db: D1Database, runId: string, now: number): Promise<StepResult> {
  const status = await settle(db, runId, now);
  return { outcome: status === 'running' ? 'busy' : status };
}

/** CC8 S7 : succès attesté UNIQUEMENT par les effets persistés et les résultats GitHub.
 * Une sortie texte du modèle ou un tool refusé ne constitue pas une preuve.
 */
export interface GithubCompletionEffect { tool: string; status: string; result: string | null }
const COMPLETION_SHA = /^[a-f0-9]{40}$/;

function completedPayload(effect: GithubCompletionEffect): Record<string, unknown> | null {
  if (effect.status !== 'completed' || !effect.result) return null;
  try {
    const value: unknown = JSON.parse(effect.result);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Les indices respectent l'ordre D1 (n,idx), aucune preuve externe n'est simulée. */
export function githubCompletionSatisfied(effects: readonly GithubCompletionEffect[], branch: string): boolean {
  const entries = effects.map(e => ({ tool: e.tool, value: completedPayload(e) }));
  const scope = entries.findIndex(e => e.tool === 'github_write_scope' && e.value?.branch === branch);
  if (scope < 0) return false;
  const createdAt = entries.findIndex((e, i) => i > scope && e.tool === 'github_create_branch'
    && e.value?.branch === branch && typeof e.value.sha === 'string' && COMPLETION_SHA.test(e.value.sha));
  // CC8 S7 mode guidé : une branche préexistante est prouvée par la tête lue par le serveur dans le mandat.
  const head = entries[scope].value?.branch_head;
  const created = createdAt >= 0 ? createdAt : typeof head === 'string' && COMPLETION_SHA.test(head) ? scope : -1;
  if (created < 0) return false;
  for (let k = created + 1; k < entries.length; k++) {
    const commit = entries[k];
    const sha = commit.value?.commit_sha;
    if (!['github_commit_files', 'github_replace_text'].includes(commit.tool)
      || commit.value?.branch !== branch || typeof sha !== 'string' || !COMPLETION_SHA.test(sha)) continue;
    const started = entries.findIndex((e, i) => i > k && e.tool === 'github_run_checks'
      && e.value?.targetSha === sha && typeof e.value.runId === 'number'
      && Number.isSafeInteger(e.value.runId) && e.value.runId > 0);
    if (started < 0) continue;
    const checked = entries.findIndex((e, i) => i > started && e.tool === 'github_check_result'
      && e.value?.targetSha === sha && e.value?.verifiedSuccess === true
      && e.value?.status === 'completed');
    if (checked < 0) continue;
    const pr = entries.findIndex((e, i) => i > checked && e.tool === 'github_open_pr'
      && e.value?.branch === branch && e.value?.head_sha === sha
      && typeof e.value.number === 'number' && Number.isSafeInteger(e.value.number)
      && e.value.number > 0 && e.value?.draft === false);
    if (pr >= 0) return true;
  }
  return false;
}

/** CC8 S8 : un final d'agent API ne prouve pas une réponse, un verdict ou une contribution. */
export async function storeCompletionVerified(db: D1Database, run: Pick<RunRow,
  'run_id' | 'cycle_id' | 'participant_id' | 'task_id' | 'task_kind' | 'prompt'>): Promise<boolean> {
  const tool = ({ answer: 'store_answer', review: 'store_verdict', test: 'store_verdict',
    design: 'store_contribute' } as Record<string, string>)[run.task_kind];
  if (!tool) return false;
  const ask = /^Question #([1-9][0-9]*) du cycle /.exec(run.prompt);
  const pair = /Couple exact à vérifier : head ([a-f0-9]{40}), base ([a-f0-9]{40})/.exec(run.prompt);
  if (run.task_kind === 'answer' && !ask) return false;
  if (['review', 'test'].includes(run.task_kind) && !pair) return false;
  const { results } = await db.prepare(
    "SELECT args, result FROM agent_run_effects WHERE run_id = ?1 AND tool = ?2 AND status = 'completed' ORDER BY n DESC, idx DESC LIMIT 32",
  ).bind(run.run_id, tool).all<{ args: string; result: string | null }>();
  for (const row of results ?? []) {
    let args: Record<string, unknown>, receipt: Record<string, unknown>;
    try {
      args = JSON.parse(row.args) as Record<string, unknown>;
      receipt = JSON.parse(row.result ?? '') as Record<string, unknown>;
    } catch { continue; }
    if (!args || !receipt || typeof args !== 'object' || typeof receipt !== 'object'
      || !Number.isSafeInteger(receipt.seq) || Number(receipt.seq) < 1
      || !['applied', 'duplicate'].includes(String(receipt.status))) continue;
    if (run.task_kind === 'answer' && args.ask_seq !== Number(ask![1])) continue;
    if (run.task_kind !== 'answer' && args.task !== run.task_id) continue;
    if (pair && (args.head !== pair[1] || args.base !== pair[2])) continue;
    const event = await db.prepare('SELECT type, participant_id, payload_json FROM events WHERE seq = ?1 AND cycle_id = ?2')
      .bind(receipt.seq, run.cycle_id).first<{ type: string; participant_id: string; payload_json: string }>();
    if (!event || event.participant_id !== run.participant_id || event.type !== receipt.type) continue;
    if (run.task_kind === 'answer' && event.type !== 'clarify.answer') continue;
    if (['review', 'test'].includes(run.task_kind) && event.type !== 'evidence.add') continue;
    if (run.task_kind === 'design' && !['proposal.submit', 'evidence.add'].includes(event.type)) continue;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(event.payload_json) as Record<string, unknown>; }
    catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    if (run.task_kind === 'answer' && payload.ask_seq !== Number(ask![1])) continue;
    if (run.task_kind !== 'answer' && payload.task !== run.task_id) continue;
    if (pair && (payload.head !== pair[1] || payload.base !== pair[2])) continue;
    return true;
  }
  return false;
}

async function runGrants(run:RunRow,deps:EngineDeps):Promise<GitHubCompletionGrant[]> {
  const staticGrants=(deps.githubCompletionGrants??[]).filter(g=>g.cycle===run.cycle_id
    && g.task===run.task_id && g.participant===run.participant_id);
  const dynamic=deps.dynamicGrantFor ? await deps.dynamicGrantFor(run) : null;
  return [...staticGrants,...(dynamic?[dynamic]:[])];
}
async function completionVerified(db: D1Database, run: RunRow, deps: EngineDeps): Promise<boolean> {
  if (['answer', 'review', 'test', 'design'].includes(run.task_kind)) return storeCompletionVerified(db, run);
  if (run.task_kind !== 'implement') return true; // Historical synthetic kinds only.
  const grants = await runGrants(run,deps);
  if (grants.length === 0) return !deps.dynamicGrantFor; // Dynamic mode fail closed without grant.
  if (grants.length !== 1) return false; // Ambiguïté = pas de succès.
  return githubCompletionSatisfied(await runEvidence(db, run.run_id), grants[0].branch);
}

/** Effets D1 de l'exécution dans l'ordre (n, idx) ; les relevés de CI serveur suivent leur effet d'origine. */
async function runEvidence(db: D1Database, runId: string): Promise<GithubCompletionEffect[]> {
  const { results } = await db.prepare(
    'SELECT n, idx, tool, status, result FROM agent_run_effects WHERE run_id = ?1 ORDER BY n, idx',
  ).bind(runId).all<GithubCompletionEffect & { n: number; idx: number }>();
  const polls = await allCiPolls(db, runId);
  const merged: GithubCompletionEffect[] = [];
  for (const effect of results) {
    merged.push({ tool: effect.tool, status: effect.status, result: effect.result });
    for (const poll of polls) {
      if (poll.n === effect.n && poll.idx === effect.idx && effect.tool === CI_POLL_TOOL) {
        merged.push({ tool: CI_POLL_TOOL, status: 'completed', result: poll.result });
      }
    }
  }
  return merged;
}

/** CC8 S7 mode guidé : prochaine étape déduite des effets D1, pour une exécution sous mandat S7 seulement. */
type PreparationStep = { kind: 'prepare' | 'handover'; tools: string[]; instruction: string };
async function guidedStep(db: D1Database, run: RunRow, deps: EngineDeps, n: number): Promise<GuidedStep | PreparationStep | null> {
  if (!deps.guidedS7 || run.task_kind !== 'implement') return null;
  const grants = await runGrants(run,deps);
  if (grants.length !== 1) return deps.dynamicGrantFor ? {kind:'stop',reason:'task_grant_unavailable'} : null;
  // Run guidé : jamais de repli libre. Plafond serveur, outil absent ou état non prévu = arrêt typé.
  const used = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_server_steps WHERE run_id = ?1').bind(run.run_id).first<{ c: number }>();
  if ((used?.c ?? 0) >= GUIDED_SERVER_MAX) return { kind: 'stop', reason: 'server_cap' };
  const entries = (await runEvidence(db, run.run_id)).map(e => ({ tool: e.tool, value: completedPayload(e), failed: e.status === 'failed',
    ...(e.tool === GUIDED_PRECHECK_TOOL ? { detail: precheckCause(e.result) } : {}) }));
  const step = planGuidedS7(entries, grants[0].branch, run.task_id, n, missionOf(grants[0]));
  // Once the server has opened a PR after green CI, let the agent write one
  // durable handover and optionally one proposed/revised C4 memory entry.
  // The C4 lifecycle still requires its normal independent activation review.
  if (deps.guidedPreparation && step.kind==='stop' && step.reason==='pr_already_open') {
    const offered = HANDOVER_WRITE_TOOLS.filter(name=>deps.tools.spec(run.task_kind,name)?.effect==='write');
    if (offered.length !== HANDOVER_WRITE_TOOLS.length) return {kind:'stop',reason:'handover_tools_unavailable'};
    return {kind:'handover',tools:offered,instruction:HANDOVER_INSTRUCTION};
  }
  // The server and branch setup stay mechanical. Before the FIRST content commit,
  // require verifiable read-only preparation for this participant and immutable base.
  if (deps.guidedPreparation && step.kind === 'model' && !step.fill.correction) {
    const required = [...PREPARATION_READ_TOOLS];
    if (required.some(tool => deps.tools.spec(run.task_kind, tool)?.effect !== 'read')) {
      return { kind: 'stop', reason: 'preparation_tools_unavailable' };
    }
    const scope = entries.find(e => e.tool === 'github_write_scope'
      && e.value?.branch === grants[0].branch)?.value;
    const baseSha = typeof scope?.base_sha === 'string' ? scope.base_sha : '';
    if (!/^[a-f0-9]{40}$/.test(baseSha)) return { kind: 'stop', reason: 'preparation_base_unverified' };
    const { results } = await db.prepare(
      "SELECT model_output, results FROM agent_run_steps WHERE run_id = ?1 AND state = 'completed' ORDER BY n",
    ).bind(run.run_id).all<PreparationRecord>();
    const evidence = readPreparationEvidence(results, baseSha, step.fill.paths);
    if (!evidence.prepared) {
      if (evidence.rounds >= PREPARATION_ROUNDS_MAX) return { kind: 'stop', reason: 'preparation_incomplete' };
      // C1: reinject recovery feedback from ledger (cycle,task,branch), not journal-only silence.
      const ledger = await db.prepare(
        "SELECT COUNT(*) AS c FROM agent_run_journal j JOIN agent_runs r ON r.run_id = j.run_id "
        + "WHERE j.kind = 'preparation_recovery' AND r.cycle_id = ?1 AND r.task_id = ?2 "
        + "AND COALESCE(json_extract(j.detail, '$.branch'), '') = ?3",
      ).bind(run.cycle_id, run.task_id, grants[0].branch).first<{ c: number }>();
      const usedLedger = Number(ledger?.c ?? 0);
      const recoveryHint = usedLedger > 0
        ? preparationNoToolCallFeedback(preparationRecoveriesRemaining(usedLedger))
        : undefined;
      return { kind: 'prepare', tools: [...required,
          ...PREPARATION_DISCOVERY_TOOLS.filter(tool => deps.tools.spec(run.task_kind, tool)?.effect === 'read')],
        instruction: preparationInstruction(run.task_id, baseSha, evidence.missing,
          missionOf(grants[0]).acceptance, evidence.rounds, recoveryHint) };
    }
  }
  if (step.kind === 'server' && !deps.tools.spec(run.task_kind, step.call.name)) return { kind: 'stop', reason: 'tool_unavailable:' + step.call.name };
  if (step.kind === 'model' && !deps.tools.spec(run.task_kind, 'github_commit_files')) return { kind: 'stop', reason: 'tool_unavailable:github_commit_files' };
  return step;
}

/** Cause d'un refus de prévalidation persisté (effet guided_precheck). */
function precheckCause(result: string | null): string {
  try {
    const value = JSON.parse(result ?? '') as { cause?: unknown };
    return typeof value?.cause === 'string' ? value.cause.slice(0, 60) : 'unknown';
  } catch { return 'unknown'; }
}

/**
 * Lot A R2 (#281) : refus de prévalidation enregistré comme effet D1 `guided_precheck` en échec,
 * sous la garde LIVE et la réclamation exacte, SANS aucune écriture GitHub. Clé déterministe : une
 * reprise retrouve le même refus. null = refus enregistré (ou déjà présent) ; sinon arrêt / busy.
 */
async function recordPrecheck(db: D1Database, runId: string, claim: Claim, idx: number, call: ToolCall, cause: string,
  now: number): Promise<StepResult | null> {
  const key = await sha256Hex(canonical({ run_id: runId, n: claim.n, idx, tool: GUIDED_PRECHECK_TOOL }));
  const inserted = await db.prepare([
    'INSERT OR IGNORE INTO agent_run_effects (effect_key, run_id, n, idx, tool, args, status, result, updated_at)',
    "SELECT ?2, ?1, ?3, ?4, ?5, ?6, 'failed', ?7, ?8 WHERE " + LIVE + ' AND ' + claimHeld('?3', '?9', '?10'),
  ].join(' ')).bind(runId, key, claim.n, idx, GUIDED_PRECHECK_TOOL, canonical({ name: call.name, args: call.args }),
    JSON.stringify({ error: 'guided_precheck', cause }), now, claim.worker, claim.attempts).run();
  if (inserted.meta.changes === 1) return null;
  const existing = await db.prepare('SELECT 1 AS x FROM agent_run_effects WHERE effect_key = ?1').bind(key).first();
  return existing ? null : settled(db, runId, now);
}

async function enrichGuided(run: RunRow, deps: EngineDeps, n: number, step: Extract<GuidedStep, { kind: 'model' }>): Promise<GuidedStep> {
  // Étape de contenu : le serveur lit chaque fichier autorisé au head (blob SHA et contenu borné).
  // Le SHA du blob est imposé par applyGuidedFill ; le contenu actuel aide une correction.
  const blobs: Record<string, string | null> = {};
  const currentFiles: Record<string, string> = {};
  const shown: string[] = [];
  if (deps.tools.spec(run.task_kind, 'github_read_file')?.effect === 'read') {
    for (const path of step.fill.paths.slice(0, 2)) {
      try {
        const file = await deps.tools.execute({ id: 'srv-read-' + n, name: 'github_read_file', args: { path, ref: step.fill.head } },
          { run_id: run.run_id }) as { sha?: unknown; content?: unknown };
        blobs[path] = typeof file?.sha === 'string' && COMPLETION_SHA.test(file.sha) ? file.sha : null;
        if (typeof file?.content === 'string') {
          if (new TextEncoder().encode(file.content).length <= 100_000) currentFiles[path] = file.content;
          shown.push('Contenu actuel de « ' + path + ' » au SHA ' + step.fill.head + ' (borné) :\n' + file.content.slice(0, GUIDED_FILE_PREVIEW));
        }
      } catch {
        blobs[path] = null; // fichier absent (nouveau) ou illisible : pas d'expected_sha
      }
    }
  }
  return { ...step, fill: { ...step.fill, blobs, currentFiles }, instruction: shown.length ? step.instruction + '\n\n' + shown.join('\n\n') : step.instruction };
}

const GUIDED_FILE_PREVIEW = 8_000;
/** Compaction déterministe et opt-in du seul contexte envoyé au fournisseur.
 * D1 conserve chaque réponse, argument, résultat et effet sans aucune modification.
 * Dernière étape intégrale pour préserver le couple tool_calls / tool_call_id.
 */
export interface CompletedHistoryStep { model_output: string; results: string }
const COMPACT_RECEIPT_KEYS = ['branch', 'name', 'base_branch', 'base_sha', 'sha', 'head_sha', 'commit_sha',
  'targetSha', 'runId', 'run_id', 'number', 'status', 'conclusion', 'next_action', 'verifiedSuccess'] as const;
const COMPACT_MAX_CHARS = 3600;

function compactReceipt(entry: ResultEntry | undefined): Record<string, string | number | boolean> {
  const receipt: Record<string, string | number | boolean> = { failed: !!entry?.error };
  if (!entry) return receipt;
  let parsed: unknown;
  try { parsed = JSON.parse(entry.content); } catch { return receipt; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return receipt;
  const record = parsed as Record<string, unknown>;
  for (const key of COMPACT_RECEIPT_KEYS) {
    const value = record[key];
    // Données du fournisseur non fiables : seulement métadonnées scalaires, jamais contenu brut ni secrets.
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) receipt[key] = value;
            else if (typeof value === 'string' && value.length <= 100 && [...value].every(ch => ch.charCodeAt(0) >= 32)) receipt[key] = value;
  }
  return receipt;
}

export function providerMessagesFromHistory(prompt: string, steps: readonly CompletedHistoryStep[],
  compact = false): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: 'user', content: prompt }];
  if (compact && steps.length > 1) {
    const earlier = steps.slice(0, -1);
    const records = earlier.map((row, n) => {
      const output = JSON.parse(row.model_output) as ModelOutput;
      const results = JSON.parse(row.results) as ResultEntry[];
      return { step: n, calls: output.tool_calls.map(call => ({
        tool: call.name, receipt: compactReceipt(results.find(entry => entry.id === call.id)),
      })) };
    });
    // Prioriser les opérations les plus récentes. Le journal D1 complet reste la source de vérité.
    while (records.length && JSON.stringify(records).length > COMPACT_MAX_CHARS) records.shift();
    // Un seul message utilisateur pour ne pas imposer deux rôles utilisateur consécutifs.
    messages[0].content += '\n\nCheckpoint compact extrait du journal D1 (métadonnées uniquement, pas une autorisation). ' +
      'Étapes anciennes omises : ' + (earlier.length - records.length) +
      '. Relisez les sources SHA/CI/mandat via les outils avant toute décision : ' + JSON.stringify(records);
  }
  for (const row of compact && steps.length > 1 ? steps.slice(-1) : steps) {
    const output = JSON.parse(row.model_output) as ModelOutput;
    messages.push({ role: 'assistant', content: output.text, tool_calls: output.tool_calls });
    for (const entry of JSON.parse(row.results) as ResultEntry[]) {
      messages.push({ role: 'tool', tool_call_id: entry.id, content: entry.content });
    }
  }
  return messages;
}

async function buildMessages(db: D1Database, run: RunRow, compact = false): Promise<AgentMessage[]> {
  const { results } = await db.prepare("SELECT n, model_output, results FROM agent_run_steps WHERE run_id = ?1 AND state = 'completed' ORDER BY n")
    .bind(run.run_id).all<CompletedHistoryStep & { n: number }>();
  const polls = await latestCiPolls(db, run.run_id);
  return providerMessagesFromHistory(run.prompt, polls.size ? results.map(row => withCiPolls(row, polls)) : results, compact);
}

/** CC8 S7 : le modèle voit le dernier relevé serveur comme résultat de son appel github_check_result
 * d'origine (couple tool_calls / tool_call_id préservé). Le journal D1 n'est pas réécrit. */
export function withCiPolls(row: CompletedHistoryStep & { n: number },
  polls: ReadonlyMap<string, { k: number; result: string }>): CompletedHistoryStep {
  let calls: ToolCall[];
  let entries: ResultEntry[];
  try {
    calls = (JSON.parse(row.model_output) as ModelOutput).tool_calls ?? [];
    entries = JSON.parse(row.results) as ResultEntry[];
  } catch {
    return row;
  }
  let changed = false;
  const next = entries.map(entry => {
    const idx = calls.findIndex(call => call.id === entry.id);
    const poll = idx >= 0 && calls[idx].name === CI_POLL_TOOL ? polls.get(row.n + ':' + idx) : undefined;
    if (!poll) return entry;
    changed = true;
    let content = poll.result;
    try {
      const value: unknown = JSON.parse(poll.result);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        content = JSON.stringify({ ...(value as Record<string, unknown>), server_ci_polls: poll.k });
      }
    } catch { /* résultat brut conservé */ }
    return { id: entry.id, content };
  });
  return changed ? { model_output: row.model_output, results: JSON.stringify(next) } : row;
}

/**
 * CC8 S7 : relevé de CI fait par le serveur, sans modèle ni étape. Même outil, mêmes arguments,
 * mêmes gardes que l'appel d'origine. null = pas de relevé possible ici (le flux normal décide).
 */
async function runCiPoll(db: D1Database, run: RunRow, pending: PendingCiPoll, deps: EngineDeps, now: number): Promise<StepResult | null> {
  if (pending.inflight) {
    // Relevé k en vol chez un autre worker : attendre. Périmé (réponse perdue, coupure) : le clore
    // `ambiguous` sans relire ; le relevé suivant prendra k + 1. Jamais deux lectures du même k.
    if (pending.inflight.claimed_at + CI_POLL_CLAIM_S > now) return { outcome: 'busy' };
    await completeCiPoll(db, run.run_id, pending, pending.inflight.k, pending.inflight, 'ambiguous',
      JSON.stringify({ error: 'poll_outcome_unknown', next_action: 'wait', transient: true }), now);
    return { outcome: 'stepped' };
  }
  const k = pending.polls + 1;
  // Réclamation de k AVANT toute lecture externe, sous la garde LIVE et le plancher de deadline.
  const guard = LIVE + ' AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1 AND ?6 + ' + CI_POLL_FLOOR_S + ' < deadline_at)';
  const live = await db.prepare('SELECT 1 AS ok WHERE ' + guard.replaceAll('?6', '?2')).bind(run.run_id, now).first();
  if (!live) return null;
  const claim = { claimed_by: deps.workerId, claimed_at: now };
  if (!await claimCiPoll(db, run.run_id, pending, k, claim.claimed_by, claim.claimed_at, guard)) return { outcome: 'busy' };
  const key = await ciPollKey(run.run_id, pending, k);
  let content: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = Math.max(1, deps.effectTimeoutMs ?? EFFECT_TIMEOUT_S * 1000);
    const value = await Promise.race([
      deps.tools.execute(pending.call, { run_id: run.run_id, effect_key: key }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('effect_timeout')), limit); }),
    ]);
    content = asContent(value);
  } catch (error) {
    // Refus certain (HALT, fence, tâche, head changé...) : rendre la main ; panne de lecture : réessayer.
    content = JSON.stringify(error instanceof ToolRefused
      ? { error: errorText(error), next_action: 'model' }
      : { error: errorText(error), next_action: 'wait', transient: true });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await completeCiPoll(db, run.run_id, pending, k, claim, 'completed', content, deps.now());
  return { outcome: 'stepped' };
}

function normalizeOutput(output: ModelOutput): ModelOutput {
  const calls = Array.isArray(output?.tool_calls) ? output.tool_calls : [];
  return {
    text: typeof output?.text === 'string' ? output.text : '',
    tool_calls: calls.map((call, index) => ({
      id: typeof call?.id === 'string' && call.id ? call.id : 'call-' + index,
      name: typeof call?.name === 'string' ? call.name : '',
      args: call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {},
    })),
  };
}

/** Réclame l'étape n (nouvelle, ou périmée après coupure) ; null = rien à faire pour ce worker. */
async function claimStep(db: D1Database, run: RunRow, deps: EngineDeps, now: number, server = false): Promise<StepRow | StepResult> {
  const n = run.steps_done;
  const fresh = await db.prepare([
    'INSERT OR IGNORE INTO agent_run_steps (run_id, n, state, claimed_by, claimed_at, attempts)',
    "SELECT ?1, ?2, 'claimed', ?3, ?4, 1 WHERE " + LIVE + ' AND ' + withinLimits(server),
    '  AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1 AND steps_done = ?2)',
  ].join(' ')).bind(run.run_id, n, deps.workerId, now).run();
  if (fresh.meta.changes === 1) return { state: 'claimed', claimed_by: deps.workerId, claimed_at: now, attempts: 1, model_output: null };
  const step = await db.prepare('SELECT state, claimed_by, claimed_at, attempts, model_output FROM agent_run_steps WHERE run_id = ?1 AND n = ?2')
    .bind(run.run_id, n).first<StepRow>();
  if (!step) return settled(db, run.run_id, now);
  if (step.state === 'completed' || step.claimed_at + STEP_TIMEOUT_S > now) return { outcome: 'busy' };
  if (step.attempts >= MAX_STEP_ATTEMPTS) {
    // Seulement si la réclamation périmée observée est toujours celle-là (aucune reprise entre-temps).
    await db.prepare([
      "UPDATE agent_runs SET status = 'failed', stop_reason = 'step_attempts_exhausted', updated_at = ?2",
      "WHERE run_id = ?1 AND status = 'running' AND EXISTS (SELECT 1 FROM agent_run_steps",
      "  WHERE run_id = ?1 AND n = ?3 AND claimed_by = ?4 AND claimed_at = ?5 AND attempts = ?6 AND state <> 'completed')",
    ].join(' ')).bind(run.run_id, now, n, step.claimed_by, step.claimed_at, step.attempts).run();
    const status = (await db.prepare('SELECT status FROM agent_runs WHERE run_id = ?1').bind(run.run_id).first<{ status: RunStatus }>())!.status;
    return { outcome: status === 'running' ? 'busy' : status };
  }
  const retaken = await db.prepare([
    'UPDATE agent_run_steps SET claimed_by = ?3, claimed_at = ?4, attempts = attempts + 1',
    "WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?5 AND claimed_at = ?6 AND state <> 'completed'",
    '  AND ' + LIVE + ' AND ' + withinLimits(server),
  ].join(' ')).bind(run.run_id, n, deps.workerId, now, step.claimed_by, step.claimed_at).run();
  if (retaken.meta.changes !== 1) return settled(db, run.run_id, now);
  return { ...step, claimed_by: deps.workerId, claimed_at: now, attempts: step.attempts + 1 };
}

/**
 * Fait une étape de l'exécution. Idempotent : peut être rappelé après une coupure
 * à n'importe quel point ; jamais deux écrivains, jamais un effet réémis à l'aveugle.
 */
export async function runStep(db: D1Database, runId: string, deps: EngineDeps): Promise<StepResult> {
  await ensureAgentRunSchema(db);
  const now = deps.now();
  const run = await getRun(db, runId);
  if (!run) return { outcome: 'unknown_run' };
  if (run.status !== 'running') return { outcome: run.status };
  // CC8 S7 : CI pending → relevé serveur, sans modèle ni étape (au plus CI_POLL_MAX, dans la deadline).
  await ensureCiPollSchema(db);
  const pendingPoll = await pendingCiPoll(db, runId, run.steps_done);
  if (pendingPoll) {
    const polled = await runCiPoll(db, run, pendingPoll, deps, now);
    if (polled) return polled;
  }
  // CC8 S7 mode guidé : prochaine étape décidée sur l'état D1 AVANT la réclamation (même état, même décision).
  // Empreinte de l'état lu (effets + relevés), prise AVANT la lecture du plan (relecture D12 GPT-6, R4).
  const seen = deps.guidedS7 ? (await db.prepare('SELECT ' + GUIDED_STATE + ' AS fp').bind(runId).first<{ fp: string }>())?.fp ?? '' : '';
  const plan = await guidedStep(db, run, deps, run.steps_done);
  if (plan?.kind === 'stop') {
    // Arrêt typé et auditable d'un run guidé (aucun repli vers l'orchestration libre du modèle).
    // Relecture D12 GPT-6 (R4) : l'arrêt n'écrit que si le run est toujours le nôtre (garde LIVE : HALT,
    // fence api, génération), au même steps_done, sans étape n réclamée et vivante, et sur l'état exact lu
    // pour décider (empreinte). Sinon rien n'est écrit et settle donne halted / preempted / busy.
    const stopped = await db.prepare([
      "UPDATE agent_runs SET status = 'failed', stop_reason = ?2, updated_at = ?3 WHERE run_id = ?1 AND status = 'running'",
      '  AND steps_done = ?4 AND ' + LIVE,
      "  AND NOT EXISTS (SELECT 1 FROM agent_run_steps s WHERE s.run_id = ?1 AND s.n = ?4 AND s.state <> 'completed' AND s.claimed_at + ?6 > ?3)",
      '  AND ' + GUIDED_STATE + ' = ?5',
    ].join(' ')).bind(runId, ('guided_stop:' + plan.reason).slice(0, 500), now, run.steps_done, seen, STEP_TIMEOUT_S).run();
    if (stopped.meta.changes !== 1) return settled(db, runId, now);
    return { outcome: 'failed' };
  }
  const claimed = await claimStep(db, run, deps, now, plan?.kind === 'server');
  if ('outcome' in claimed) return claimed;
  const n = run.steps_done;
  const claim: Claim = { n, worker: deps.workerId, attempts: claimed.attempts };

  // CC-8 S1b-2 : budget TOTAL des appels modèle de l'étape — min(480 s, deadline restante
  // − 30 s, marge avant plafond d'étape) ; chaque appel reçoit ce qui reste (la chaîne de
  // repli décompte elle-même entre maillons), arrêt propre transient sous le plancher de
  // 30 s (v2 point 4) : jamais de coupure au milieu d'un appel ni d'un effet.
  const budgetLeftMs = stepModelBudgetMs(run.deadline_at * 1000, now * 1000);
  if (budgetLeftMs < STEP_MODEL_BUDGET_FLOOR_MS) {
    await stopAs(db, runId, 'failed', 'model_transient: budget d’appels modèle de l’étape épuisé ('
      + Math.max(0, Math.trunc(budgetLeftMs)) + ' ms restants, plan S1b-2 v2 point 4) ; relance d’exécution S1b.', now, claim);
    return { outcome: 'failed' };
  }

  // 1. Modèle (sortie persistée avant tout effet : une reprise rejoue la même décision).
  let output: ModelOutput;
  let guidedPrecheckFill: Extract<GuidedStep, { kind: 'model' }>['fill'] | undefined;
  if (claimed.model_output) {
    output = JSON.parse(claimed.model_output) as ModelOutput;
  } else {
    let response: { output: ModelOutput; usage: ModelUsage };
    let normalized: string[] = [];
    // CC8 S7 mode guidé : étape mécanique émise par le serveur (sans modèle ni jeton), ou consigne précise
    // et un seul outil pour l'étape de contenu. Le résultat suit ensuite le chemin commun (gardes, effets).
    const guide = plan?.kind === 'model' ? await enrichGuided(run, deps, n, plan) : plan;
    if (guide?.kind === 'model') guidedPrecheckFill = guide.fill;
    // CC8 S7 vérification guidée : contexte serveur pour review/test (préparé une fois, relu ensuite), outils libres.
    const verify = !guide && deps.guidedVerify ? await verifyContext(db, run, {
      execute: (call, ctx) => deps.tools.execute(call, ctx),
      has: name => deps.tools.spec(run.task_kind, name)?.effect === 'read',
      now: deps.now,
    }) : null;
    try {
      if (guide?.kind === 'server') {
        response = { output: { text: 'Étape mécanique exécutée par le serveur (mode guidé S7) : ' + guide.call.name + '.', tool_calls: [guide.call] },
          usage: { tokens: 0, cost_cents: 0 } };
      } else {
        // CC8 C2a : une seule compaction opt-in, quel que soit le kind ou le mode guidé.
        // L'historique complet et les preuves D1 ne sont jamais condensés en stockage.
        const messages = await buildMessages(db, run, deps.compactHistory === true);
        const tools = deps.tools.list(run.task_kind);
        const extra = guide?.kind === 'model' || guide?.kind === 'prepare' || guide?.kind === 'handover'
          ? guide.instruction : verify ? verify.context + '\n\n' + verify.instruction : null;
        response = await deps.model.complete({
          messages: extra ? [...messages, { role: 'user', content: extra }] : messages,
          tools: guide?.kind === 'model' || guide?.kind === 'prepare' || guide?.kind === 'handover'
            ? guide.tools.filter(name => tools.includes(name)) : tools,
          task_kind: run.task_kind, budget_left_ms: budgetLeftMs,
          budget_left_tokens: Math.max(0, run.max_tokens - run.tokens_used) });
      }
    } catch (error) {
      const usage = error instanceof ModelCallError ? error.usage : null;
      await db.batch([
        db.prepare('UPDATE agent_runs SET tokens_used = tokens_used + ?2, cost_cents = cost_cents + ?3, updated_at = ?4 WHERE run_id = ?1')
          .bind(runId, Math.max(0, usage?.tokens ?? 0), Math.max(0, usage?.cost_cents ?? 0), now),
      ]);
      // Le repli intra-famille est déjà épuisé. Terminer cette tentative avec
      // son motif typé ; seul le planificateur peut en créer une autre après 900 s.
      // Ne pas modifier la réclamation : stopAs vérifie encore son identité exacte.
      await stopAs(db, runId, 'failed', 'model_' + modelFailureKind(error) + ': ' + errorText(error), now, claim);
      return { outcome: 'failed' };
    }
    output = normalizeOutput(response.output);
    if (guide?.kind === 'model' || guide?.kind === 'prepare' || guide?.kind === 'handover') {
      // Phase de consultation : tous les appels doivent être des lectures offertes.
      // Phase de codage : exactement un github_commit_files, sans autre outil.
      const raw = output;
      if (guide.kind === 'model') {
        const canon = canonicalGuidedOutput(output);
        output = canon.output;
        normalized = canon.normalized;
      }
      const violation = guide.kind === 'prepare' ? preparationViolation(output, guide.tools)
        : guide.kind === 'handover' ? handoverViolation(output) : guidedViolation(output);
      if (violation) {
        // Tokens already consumed (D12 R3). C1: recoverable no_tool_call in prepare only.
        const tokens = Math.max(0, Math.floor(response.usage?.tokens ?? 0));
        const cost = Math.max(0, Math.ceil(response.usage?.cost_cents ?? 0));
        if (guide.kind === 'prepare' && isRecoverablePreparationViolation(violation)) {
          const grantsNow = await runGrants(run, deps);
          const branch = grantsNow[0]?.branch ?? '';
          // Ledger across relances: (cycle_id, task_id, branch), not only this run_id.
          const rec = await db.prepare(
            "SELECT COUNT(*) AS c FROM agent_run_journal j JOIN agent_runs r ON r.run_id = j.run_id "
            + "WHERE j.kind = 'preparation_recovery' AND r.cycle_id = ?1 AND r.task_id = ?2 "
            + "AND COALESCE(json_extract(j.detail, '$.branch'), '') = ?3",
          ).bind(run.cycle_id, run.task_id, branch).first<{ c: number }>();
          const used = Number(rec?.c ?? 0);
          if (shouldRecoverPreparation(used, violation)) {
            const remainingAfter = preparationRecoveriesRemaining(used + 1);
            const detail = JSON.stringify({
              n, worker: deps.workerId, attempts: claimed.attempts, violation, used: used + 1,
              remainingAfter, tokens, cost_cents: cost,
              cycle_id: run.cycle_id, task_id: run.task_id, branch,
              feedback: preparationNoToolCallFeedback(remainingAfter).slice(0, 400),
            });
            // Concurrent-safe order:
            // 1) journal under claimHeld (state still claimed)
            // 2) complete step + completed_at
            // 3) CAS advance steps_done so next claimStep uses n+1 (else busy forever)
            // Then return stepped (not settled→busy) so the drive loop continues.
            const [journaled, completed, advanced] = await db.batch([
              db.prepare('INSERT INTO agent_run_journal (at, kind, run_id, detail) SELECT ?2, ?3, ?1, ?4 WHERE '
                + LIVE + ' AND ' + claimHeld('?5', '?6', '?7'))
                .bind(runId, now, 'preparation_recovery', detail, n, deps.workerId, claimed.attempts),
              db.prepare("UPDATE agent_run_steps SET state = 'completed', model_output = ?5, results = '[]', tokens = tokens + ?6, cost_cents = cost_cents + ?7, completed_at = ?8 WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND attempts = ?4 AND state = 'claimed' AND "
                + LIVE).bind(runId, n, deps.workerId, claimed.attempts, JSON.stringify(raw), tokens, cost, now),
              db.prepare([
                'UPDATE agent_runs SET tokens_used = tokens_used + ?3, cost_cents = cost_cents + ?4,',
                '  steps_done = steps_done + 1, updated_at = ?5',
                'WHERE run_id = ?1 AND steps_done = ?2 AND ' + LIVE,
                "  AND EXISTS (SELECT 1 FROM agent_run_steps WHERE run_id = ?1 AND n = ?2 AND state = 'completed'",
                '    AND claimed_by = ?6 AND completed_at = ?5)',
              ].join(' ')).bind(runId, n, tokens, cost, now, deps.workerId),
            ]);
            if (journaled.meta.changes !== 1 || completed.meta.changes !== 1 || advanced.meta.changes !== 1) return settled(db, runId, now);
            return { outcome: 'stepped' };
          }
        }
        const reason = (guide.kind === 'prepare' ? 'guided_preparation_violation:'
          : guide.kind === 'handover' ? 'guided_handover_violation:' : 'guided_violation:') + violation;
        await db.batch([
          db.prepare('UPDATE agent_runs SET tokens_used = tokens_used + ?2, cost_cents = cost_cents + ?3, updated_at = ?4 WHERE run_id = ?1')
            .bind(runId, tokens, cost, now),
          db.prepare("UPDATE agent_run_steps SET tokens = tokens + ?5, cost_cents = cost_cents + ?6 WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND attempts = ?4 AND state = 'claimed'")
            .bind(runId, n, deps.workerId, claimed.attempts, tokens, cost),
          db.prepare('INSERT INTO agent_run_journal (at, kind, run_id, detail) VALUES (?1, ?2, ?3, ?4)')
            .bind(now, 'guided_violation', runId, JSON.stringify({ n, worker: deps.workerId, attempts: claimed.attempts, violation, tokens, cost_cents: cost,
              raw_names: raw.tool_calls.slice(0, 8).map(call => JSON.stringify(call.name).slice(0, 80)),
              output: JSON.stringify(raw).slice(0, GUIDED_TRACE_MAX) })),
          db.prepare("UPDATE agent_runs SET status = 'failed', stop_reason = ?2, updated_at = ?3 WHERE run_id = ?1 AND status = 'running' AND "
            + LIVE + ' AND ' + claimHeld('?4', '?5', '?6')).bind(runId, reason.slice(0, 500), now, n, deps.workerId, claimed.attempts),
        ]);
        return settled(db, runId, now);
      }
      if (guide.kind === 'model') output = applyGuidedFill(output, guide.fill);
    }
    const tokens = Math.max(0, Math.floor(response.usage?.tokens ?? 0));
    const cost = Math.max(0, Math.ceil(response.usage?.cost_cents ?? 0));
    const [, saved] = await db.batch([
      db.prepare('UPDATE agent_runs SET tokens_used = tokens_used + ?2, cost_cents = cost_cents + ?3, updated_at = ?4 WHERE run_id = ?1')
        .bind(runId, tokens, cost, now),
      db.prepare([
        "UPDATE agent_run_steps SET state = 'model_done', model_output = ?4, tokens = ?5, cost_cents = ?6",
        "WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND attempts = ?7 AND state = 'claimed' AND " + LIVE,
      ].join(' ')).bind(runId, n, deps.workerId, JSON.stringify(output), tokens, cost, claimed.attempts),
      // CC8 S7 : marque l'étape serveur (hors max_steps), dans le même lot et seulement si l'étape est bien la nôtre.
      db.prepare([
        'INSERT OR IGNORE INTO agent_run_server_steps (run_id, n) SELECT ?1, ?2 WHERE ?4 = 1 AND EXISTS (SELECT 1 FROM agent_run_steps',
        "  WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND state = 'model_done')",
      ].join(' ')).bind(runId, n, deps.workerId, guide?.kind === 'server' ? 1 : 0),
      // Lot A R1 : trace bornée d'une normalisation de nom d'outil, seulement si l'étape est bien la nôtre.
      db.prepare([
        'INSERT INTO agent_run_journal (at, kind, run_id, detail) SELECT ?1, ?2, ?3, ?4 WHERE ?7 = 1 AND EXISTS (SELECT 1 FROM agent_run_steps',
        "  WHERE run_id = ?3 AND n = ?5 AND claimed_by = ?6 AND state = 'model_done')",
      ].join(' ')).bind(now, 'guided_tool_normalized', runId, JSON.stringify({ n, worker: deps.workerId, raw_names: normalized.slice(0, 8) }),
        n, deps.workerId, normalized.length > 0 ? 1 : 0),
    ]);
    if (saved.meta.changes !== 1) return settled(db, runId, now);
    await deps.probe?.('after_model');
  }

  // 2. Outils.
  const results: ResultEntry[] = [];
  for (const [idx, call] of output.tool_calls.entries()) {
    const refused = (reason: string) => results.push({ id: call.id, content: JSON.stringify({ error: reason }), error: true });
    if (idx >= MAX_TOOL_CALLS_PER_STEP) { refused('too_many_tool_calls'); continue; }
    if ((API_AGENT_FORBIDDEN as readonly string[]).includes(call.name)) { refused('tool_forbidden_on_api_channel'); continue; }
    const spec = deps.tools.spec(run.task_kind, call.name);
    if (!spec || spec.name !== call.name) { refused('tool_not_allowlisted'); continue; }
    if (spec.effect === 'read') {
      try {
        results.push({ id: call.id, content: asContent(await deps.tools.execute(call, { run_id: runId })) });
      } catch (error) {
        refused(errorText(error));
      }
      continue;
    }
    // CC-7 L5b (S10) : store_verdict est la seule écriture à verdict permise au canal
    // API — le serveur re-vérifie tout dans verdict-tools (rôle, identité, couple exact
    // relu, CI au head, preuve de lecture github_diff, idempotence déterministe). Tout
    // autre appel d'écriture reste soumis au refus D12.
    // CC-7 L6b-2 : store_contribute porte un état de conception (AGREE/AMEND/OBJECTION) sans PR ni
    // head/base, re-vérifié serveur contre la phase courante (contribution-tools) : même exception.
    if (call.name !== 'store_verdict' && call.name !== 'store_contribute') {
      try {
        assertNotD12Verdict(call.args);
      } catch {
        refused('d12_verdict_forbidden_on_api_channel');
        continue;
      }
    }
    // CC-8 S1b-2 (relecture D12 #255, bloquant 1) : garde avant chaque effet — l'effet doit
    // pouvoir FINIR avant le plafond d'étape ET la deadline du run : on réserve son timeout
    // maximal (120 s) + le plancher de 30 s (EFFECT_LAUNCH_FLOOR_S), borné par les DEUX.
    // Jamais d'effet coupé au milieu ni ambiguous ; en dessous : arrêt propre transient,
    // la relance d'exécution S1b reprend (v2 point 4).
    // Un ancien worker dont la réclamation a été reprise entre-temps ne décide de rien :
    // réclamation fraîche relue, il rend 'busy' — jamais un faux 'failed' au nom d'un autre.
    if (claimed.claimed_at + STEP_TIMEOUT_S - deps.now() < EFFECT_LAUNCH_FLOOR_S
      || run.deadline_at - deps.now() < EFFECT_LAUNCH_FLOOR_S) {
      const fresh = await db.prepare('SELECT claimed_by, claimed_at, attempts FROM agent_run_steps WHERE run_id = ?1 AND n = ?2')
        .bind(runId, n).first<{ claimed_by: string; claimed_at: number; attempts: number }>();
      if (!fresh || fresh.claimed_by !== deps.workerId || fresh.claimed_at !== claimed.claimed_at
        || fresh.attempts !== claim.attempts) return { outcome: 'busy' };
      await stopAs(db, runId, 'failed', 'model_transient: temps insuffisant avant l’effet ' + call.name
        + ' (il faut ' + EFFECT_LAUNCH_FLOOR_S + ' s devant le plafond d’étape et la deadline, relecture D12 #255) ; relance d’exécution S1b.', deps.now(), claim);
      return { outcome: 'failed' };
    }
    // Lot A R2 (#281) : prévalidation statique de l'étape de contenu guidée, AVANT tout effet GitHub.
    // Le plan est recalculé à chaque passage : une reprise rejoue la même décision (clé déterministe).
    if (plan?.kind === 'model' && call.name === GUIDED_TOOL) {
      const source = guidedPrecheckFill ?? plan.fill;
      // U2 : vérifier les modules externes depuis le manifeste du dépôt à la tête immuable.
      const bare = guidedBareDependencies(call);
      let declaredDependencies: ReadonlySet<string> | undefined;
      if (bare.length && deps.tools.spec(run.task_kind, 'github_read_file')?.effect === 'read') {
        try {
          const file = await deps.tools.execute({ id: 'srv-package-' + n, name: 'github_read_file',
            args: { path: 'package.json', ref: source.head } }, { run_id: runId, prefetch: true }) as { content?: unknown };
          if (typeof file?.content === 'string') {
            const packageJson = JSON.parse(file.content) as Record<string, unknown>;
            declaredDependencies = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
              .flatMap(section => {
                const obj = packageJson[section];
                return obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [];
              }));
          }
        } catch { /* impossible de prouver le module déclaré : refus typé */ }
      }
      // U3 : après CI rouge, refuser une correction bit-à-bit identique à tous les fichiers proposés.
      // En reprise après coupure, relire les sources au SHA de tête, indépendamment de la mémoire.
      const currentFiles: Record<string, string> = { ...(source.currentFiles ?? {}) };
      if (source.correction && Array.isArray(call.args?.files)
        && deps.tools.spec(run.task_kind, 'github_read_file')?.effect === 'read') {
        for (const file of call.args.files as Array<{ path?: unknown }>) {
          if (typeof file?.path !== 'string' || !plan.fill.paths.includes(file.path)
            || Object.prototype.hasOwnProperty.call(currentFiles, file.path)) continue;
          try {
            const result = await deps.tools.execute({ id: 'srv-diff-' + n, name: 'github_read_file',
              args: { path: file.path, ref: source.head } }, { run_id: runId, prefetch: true }) as { content?: unknown };
            if (typeof result?.content === 'string' && new TextEncoder().encode(result.content).length <= 100_000)
              currentFiles[file.path] = result.content;
          } catch { /* lecture impossible : aucune preuve de diff nul */ }
        }
      }
      const cause = guidedPrecheck(call, plan.fill.paths, plan.fill.mission,
        { declaredDependencies, currentFiles, correction: source.correction });
      if (cause) {
        const stopped = await recordPrecheck(db, runId, claim, idx, call, cause, deps.now());
        if (stopped) return stopped;
        refused('guided_precheck:' + cause + ' — ' + (PRECHECK_HINTS[cause] ?? cause));
        continue;
      }
    }
    const effect = await runEffect(db, runId, claim, idx, call, deps);
    if ('outcome' in effect) return effect;
    results.push(effect);
  }

  // 3. Checkpoint : étape terminée et exécution avancée dans le même lot, sous la garde LIVE.
  // Une mission S7 disposant déjà de TOUTES les preuves est complète dès l'effet
  // github_open_pr : 6 étapes dépendantes suffisent, sans 7e appel final au modèle.
  const guarded = run.task_kind === 'implement' && (deps.githubCompletionGrants ?? []).some(g =>
    g.cycle === run.cycle_id && g.task === run.task_id && g.participant === run.participant_id);
  const provenAtPr = guarded && !deps.guidedPreparation && output.tool_calls.some(call => call.name === 'github_open_pr')
    && await completionVerified(db, run, deps);
  // Un effet métier persistant peut terminer le run sans forcer un tour modèle « final » supplémentaire.
  // Si l'outil est refusé, échoué ou n'a rien écrit, le test D1 ci-dessous reste négatif.
  const provenAtHandover = guarded && deps.guidedPreparation
    && output.tool_calls.some(call => call.name === 'store_handover')
    && (await runEvidence(db, run.run_id)).some(e=>e.tool==='store_handover' && e.status==='completed')
    && await completionVerified(db,run,deps);
  const provenAtStore = run.task_kind !== 'implement' && output.tool_calls.some(call =>
    ['store_answer', 'store_verdict', 'store_contribute'].includes(call.name))
    && await completionVerified(db, run, deps);
  const final = output.tool_calls.length === 0 || provenAtPr || provenAtHandover || provenAtStore ? 1 : 0;
  const verified = provenAtPr || provenAtHandover || provenAtStore
    || (output.tool_calls.length === 0 ? await completionVerified(db, run, deps) : true);
  const completionStatus = verified ? 'completed' : 'failed';
  const completionReason = verified ? 'final'
    : run.task_kind === 'implement' ? 'incomplete_final:github_evidence_missing' : 'incomplete_final:store_effect_missing';
  const [done] = await db.batch([
    db.prepare([
      "UPDATE agent_run_steps SET state = 'completed', results = ?4, completed_at = ?5",
      "WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND attempts = ?6 AND state = 'model_done' AND " + LIVE,
    ].join(' ')).bind(runId, n, deps.workerId, JSON.stringify(results), now, claimed.attempts),
    db.prepare([
      'UPDATE agent_runs SET steps_done = steps_done + 1, updated_at = ?3,',
      "  status = CASE WHEN ?4 = 1 THEN ?7 ELSE status END,",
      "  stop_reason = CASE WHEN ?4 = 1 THEN ?8 ELSE stop_reason END,",
      '  summary = CASE WHEN ?4 = 1 THEN ?5 ELSE summary END',
      'WHERE run_id = ?1 AND steps_done = ?2 AND EXISTS (SELECT 1 FROM agent_run_steps',
      "  WHERE run_id = ?1 AND n = ?2 AND state = 'completed' AND claimed_by = ?6 AND completed_at = ?3)",
    ].join(' ')).bind(runId, n, now, final, output.text.slice(0, 4000), deps.workerId, completionStatus, completionReason),
  ]);
  if (done.meta.changes !== 1) return settled(db, runId, now);
  if (final) return { outcome: completionStatus };
  // Mode guidé : la limite d'étapes modèle se juge à la prochaine réclamation (une étape serveur peut suivre).
  const status = await settle(db, runId, now, guarded && deps.guidedS7 === true);
  return { outcome: status === 'running' ? 'stepped' : status };
}

/** Effet externe selon R2. Rend l'entrée de résultat, ou un arrêt. */
async function runEffect(db: D1Database, runId: string, claim: Claim, idx: number, call: ToolCall, deps: EngineDeps):
  Promise<ResultEntry | StepResult> {
  const n = claim.n;
  const now = deps.now();
  const key = await sha256Hex(canonical({ run_id: runId, n, idx, tool: call.name, args: call.args }));
  const ctx = { run_id: runId, effect_key: key };
  const mark = (status: 'completed' | 'failed' | 'ambiguous', result: string) =>
    db.prepare('UPDATE agent_run_effects SET status = ?2, result = ?3, updated_at = ?4 WHERE effect_key = ?1')
      .bind(key, status, result, now).run();
  const effect = await db.prepare('SELECT status, result, updated_at FROM agent_run_effects WHERE effect_key = ?1').bind(key).first<EffectRow>();
  if (effect?.status === 'completed') return { id: call.id, content: effect.result ?? '' };
  if (effect?.status === 'failed') return { id: call.id, content: effect.result ?? '', error: true };
  // Effet lancé il y a moins de EFFECT_TIMEOUT_S : peut-être encore en vol chez un autre worker.
  if (effect?.status === 'pending' && effect.updated_at + EFFECT_TIMEOUT_S > now) return { outcome: 'busy' };
  if (effect && (effect.status === 'pending' || effect.status === 'ambiguous')) {
    // Effet incertain : chercher s'il a eu lieu AVANT tout réessai ; jamais de réémission à l'aveugle.
    let found: LookupResult = null;
    try {
      found = deps.tools.lookup ? await deps.tools.lookup(call, ctx) : null;
    } catch {
      found = null;
    }
    if (found?.found) {
      const content = asContent(found.result);
      await mark('completed', content);
      return { id: call.id, content };
    }
    if (!found) {
      await mark('ambiguous', JSON.stringify({ error: 'effect_outcome_unknown' }));
      await stopAs(db, runId, 'needs_reconcile', 'effect_outcome_unknown: ' + call.name, now, claim);
      return { outcome: 'needs_reconcile' };
    }
    // found === { found: false } : l'effet n'a certainement pas eu lieu, il peut être tenté.
  }
  if (!effect) {
    const intent = await db.prepare([
      'INSERT OR IGNORE INTO agent_run_effects (effect_key, run_id, n, idx, tool, args, status, updated_at)',
      "SELECT ?2, ?1, ?3, ?4, ?5, ?6, 'intent', ?7 WHERE " + LIVE + ' AND ' + claimHeld('?3', '?8', '?9'),
    ].join(' ')).bind(runId, key, n, idx, call.name, canonical(call.args), now, claim.worker, claim.attempts).run();
    if (intent.meta.changes !== 1) return settled(db, runId, now);
  }
  const pending = await db.prepare([
    "UPDATE agent_run_effects SET status = 'pending', updated_at = ?3",
    "WHERE effect_key = ?2 AND status IN ('intent','pending','ambiguous') AND " + LIVE + ' AND ' + claimHeld('?4', '?5', '?6'),
  ].join(' ')).bind(runId, key, now, n, claim.worker, claim.attempts).run();
  if (pending.meta.changes !== 1) return settled(db, runId, now);
  await deps.probe?.('before_effect');
  let result: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = Math.max(1, deps.effectTimeoutMs ?? EFFECT_TIMEOUT_S * 1000);
    result = await Promise.race([
      deps.tools.execute(call, ctx),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('effect_timeout')), limit); }),
    ]);
  } catch (error) {
    if (error instanceof ToolRefused) {
      const content = JSON.stringify({ error: errorText(error) });
      await mark('failed', content);
      return { id: call.id, content, error: true };
    }
    await mark('ambiguous', JSON.stringify({ error: errorText(error) }));
    await stopAs(db, runId, 'needs_reconcile', 'effect_outcome_unknown: ' + call.name, now, claim);
    return { outcome: 'needs_reconcile' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await deps.probe?.('after_effect');
  // Enregistrement du résultat sans garde : c'est la trace de ce qui a réellement eu lieu.
  const content = asContent(result);
  await mark('completed', content);
  await deps.probe?.('after_effect_recorded');
  return { id: call.id, content };
}

/** Résumé d'une exécution pour la session chat suivante (L7-4). */
export async function runSummary(db: D1Database, runId: string): Promise<{
  status: string; stop_reason: string; steps_done: number; tokens_used: number; cost_cents: number; summary: string;
  effects: { tool: string; status: string }[];
} | null> {
  await ensureAgentRunSchema(db);
  const run = await db.prepare('SELECT status, stop_reason, steps_done, tokens_used, cost_cents, summary FROM agent_runs WHERE run_id = ?1')
    .bind(runId).first<{ status: string; stop_reason: string; steps_done: number; tokens_used: number; cost_cents: number; summary: string }>();
  if (!run) return null;
  const { results } = await db.prepare('SELECT tool, status FROM agent_run_effects WHERE run_id = ?1 ORDER BY n, idx')
    .bind(runId).all<{ tool: string; status: string }>();
  return { ...run, effects: results };
}

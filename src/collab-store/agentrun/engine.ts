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
 * - Fencing (L7-4) : chaque écriture de l'exécution revalide dans le même lot D1
 *   que la génération du bail est toujours la sienne, que le chat ne l'a pas
 *   reprise et que HALT n'est pas posé (garde LIVE).
 * - Effets externes (R2) : intent → pending → completed | failed | ambiguous.
 *   Un effet resté pending (crash entre l'effet et son enregistrement) n'est
 *   JAMAIS réémis à l'aveugle : `lookup` cherche s'il a eu lieu ; sans réponse
 *   sûre, l'exécution passe en `needs_reconcile`.
 * - Retries bornés : MAX_STEP_ATTEMPTS réclamations par étape, puis `failed`.
 * - Plafonds (R5) vérifiés à chaque étape : étapes, jetons, coût, échéance.
 * - Le canal API n'émet aucun verdict D12 (L7-6) : outils interdits refusés en
 *   code même si l'hôte les déclare, et `assertNotD12Verdict` sur toute écriture.
 *
 * L'usage d'un appel modèle est toujours comptabilisé, même si l'étape est
 * ensuite refusée (préemption, HALT) ou si l'appel échoue (leçon L0).
 */
import { sha256Hex } from '../store/hash';
import { API_AGENT_FORBIDDEN, assertNotD12Verdict } from '../agents/tools';
import { ensureAgentRunSchema } from './schema';

export const STEP_TIMEOUT_S = 600;
export const MAX_STEP_ATTEMPTS = 2;
export const MAX_TOOL_CALLS_PER_STEP = 8;
export const RESULT_MAX_CHARS = 16 * 1024;

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ModelOutput { text: string; tool_calls: ToolCall[] }
export interface ModelUsage { tokens: number; cost_cents: number }
export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ModelClient {
  complete(input: { messages: AgentMessage[]; tools: string[]; task_kind: string }): Promise<{ output: ModelOutput; usage: ModelUsage }>;
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
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown>;
  /** Après un effet incertain : l'effet a-t-il eu lieu ? null = impossible de savoir. */
  lookup?(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

export interface EngineDeps {
  model: ModelClient;
  tools: ToolHost;
  now: () => number;
  workerId: string;
  /** Points de crash injectables pour les tests (lever une exception = coupure). */
  probe?: (point: 'after_model' | 'before_effect' | 'after_effect' | 'after_effect_recorded') => void | Promise<void>;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'halted' | 'preempted' | 'needs_reconcile'
  | 'step_limit' | 'token_limit' | 'cost_limit' | 'deadline';

export interface StepResult { outcome: RunStatus | 'stepped' | 'busy' | 'retry' | 'unknown_run' }

interface RunRow {
  run_id: string; lease_key: string; generation: number; task_kind: string; status: RunStatus;
  steps_done: number; prompt: string;
}
interface StepRow { state: string; claimed_by: string; claimed_at: number; attempts: number; model_output: string | null }
interface EffectRow { status: string; result: string | null }
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
const WITHIN_LIMITS = [
  'EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1 AND steps_done < max_steps',
  '  AND tokens_used < max_tokens AND cost_cents <= max_cost_cents AND ?4 < deadline_at)',
].join(' ');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as Record<string, unknown>).sort()
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
      "  updated_at = excluded.updated_at WHERE agent_fences.holder <> 'chat' OR agent_fences.held_until <= excluded.updated_at",
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
  return db.prepare('SELECT run_id, lease_key, generation, task_kind, status, steps_done, prompt FROM agent_runs WHERE run_id = ?1')
    .bind(runId).first<RunRow>();
}

/** Arrête l'exécution si une condition d'arrêt est vraie ; rend le statut courant. */
export async function settle(db: D1Database, runId: string, now: number): Promise<RunStatus> {
  const reason = [
    'CASE WHEN ' + HALTED + " THEN 'halted'",
    '  WHEN NOT EXISTS (SELECT 1 FROM agent_fences f WHERE f.lease_key = agent_runs.lease_key',
    "    AND f.generation = agent_runs.generation AND f.holder = 'api') THEN 'preempted'",
    "  WHEN steps_done >= max_steps THEN 'step_limit'",
    "  WHEN tokens_used >= max_tokens THEN 'token_limit'",
    "  WHEN cost_cents > max_cost_cents THEN 'cost_limit'",
    "  WHEN ?2 >= deadline_at THEN 'deadline'",
    "  ELSE 'running' END",
  ].join(' ');
  await db.prepare('UPDATE agent_runs SET status = ' + reason + ', stop_reason = ' + reason
    + ", updated_at = ?2 WHERE run_id = ?1 AND status = 'running'").bind(runId, now).run();
  return (await db.prepare('SELECT status FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ status: RunStatus }>())!.status;
}

async function stopAs(db: D1Database, runId: string, status: 'failed' | 'needs_reconcile', reason: string, now: number): Promise<void> {
  await db.prepare("UPDATE agent_runs SET status = ?2, stop_reason = ?3, updated_at = ?4 WHERE run_id = ?1 AND status = 'running'")
    .bind(runId, status, reason.slice(0, 500), now).run();
}

async function settled(db: D1Database, runId: string, now: number): Promise<StepResult> {
  const status = await settle(db, runId, now);
  return { outcome: status === 'running' ? 'busy' : status };
}

async function buildMessages(db: D1Database, run: RunRow): Promise<AgentMessage[]> {
  const { results } = await db.prepare("SELECT model_output, results FROM agent_run_steps WHERE run_id = ?1 AND state = 'completed' ORDER BY n")
    .bind(run.run_id).all<{ model_output: string; results: string }>();
  const messages: AgentMessage[] = [{ role: 'user', content: run.prompt }];
  for (const row of results) {
    const output = JSON.parse(row.model_output) as ModelOutput;
    messages.push({ role: 'assistant', content: output.text, tool_calls: output.tool_calls });
    for (const entry of JSON.parse(row.results) as ResultEntry[]) {
      messages.push({ role: 'tool', tool_call_id: entry.id, content: entry.content });
    }
  }
  return messages;
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
async function claimStep(db: D1Database, run: RunRow, deps: EngineDeps, now: number): Promise<StepRow | StepResult> {
  const n = run.steps_done;
  const fresh = await db.prepare([
    'INSERT OR IGNORE INTO agent_run_steps (run_id, n, state, claimed_by, claimed_at, attempts)',
    "SELECT ?1, ?2, 'claimed', ?3, ?4, 1 WHERE " + LIVE + ' AND ' + WITHIN_LIMITS,
    '  AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id = ?1 AND steps_done = ?2)',
  ].join(' ')).bind(run.run_id, n, deps.workerId, now).run();
  if (fresh.meta.changes === 1) return { state: 'claimed', claimed_by: deps.workerId, claimed_at: now, attempts: 1, model_output: null };
  const step = await db.prepare('SELECT state, claimed_by, claimed_at, attempts, model_output FROM agent_run_steps WHERE run_id = ?1 AND n = ?2')
    .bind(run.run_id, n).first<StepRow>();
  if (!step) return settled(db, run.run_id, now);
  if (step.state === 'completed' || step.claimed_at + STEP_TIMEOUT_S > now) return { outcome: 'busy' };
  if (step.attempts >= MAX_STEP_ATTEMPTS) {
    await stopAs(db, run.run_id, 'failed', 'step_attempts_exhausted', now);
    return { outcome: 'failed' };
  }
  const retaken = await db.prepare([
    'UPDATE agent_run_steps SET claimed_by = ?3, claimed_at = ?4, attempts = attempts + 1',
    "WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?5 AND claimed_at = ?6 AND state <> 'completed'",
    '  AND ' + LIVE + ' AND ' + WITHIN_LIMITS,
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
  const claimed = await claimStep(db, run, deps, now);
  if ('outcome' in claimed) return claimed;
  const n = run.steps_done;

  // 1. Modèle (sortie persistée avant tout effet : une reprise rejoue la même décision).
  let output: ModelOutput;
  if (claimed.model_output) {
    output = JSON.parse(claimed.model_output) as ModelOutput;
  } else {
    let response: { output: ModelOutput; usage: ModelUsage };
    try {
      response = await deps.model.complete({ messages: await buildMessages(db, run), tools: deps.tools.list(run.task_kind), task_kind: run.task_kind });
    } catch (error) {
      const usage = error instanceof ModelCallError ? error.usage : null;
      await db.batch([
        db.prepare('UPDATE agent_runs SET tokens_used = tokens_used + ?2, cost_cents = cost_cents + ?3, updated_at = ?4 WHERE run_id = ?1')
          .bind(runId, Math.max(0, usage?.tokens ?? 0), Math.max(0, usage?.cost_cents ?? 0), now),
        // Réclamation rendue périmée : la prochaine réveil réessaie, dans la limite de MAX_STEP_ATTEMPTS.
        db.prepare('UPDATE agent_run_steps SET claimed_at = 0 WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3')
          .bind(runId, n, deps.workerId),
      ]);
      if (claimed.attempts >= MAX_STEP_ATTEMPTS) {
        await stopAs(db, runId, 'failed', 'model_error: ' + errorText(error), now);
        return { outcome: 'failed' };
      }
      return { outcome: 'retry' };
    }
    output = normalizeOutput(response.output);
    const tokens = Math.max(0, Math.floor(response.usage?.tokens ?? 0));
    const cost = Math.max(0, Math.ceil(response.usage?.cost_cents ?? 0));
    const [, saved] = await db.batch([
      db.prepare('UPDATE agent_runs SET tokens_used = tokens_used + ?2, cost_cents = cost_cents + ?3, updated_at = ?4 WHERE run_id = ?1')
        .bind(runId, tokens, cost, now),
      db.prepare([
        "UPDATE agent_run_steps SET state = 'model_done', model_output = ?4, tokens = ?5, cost_cents = ?6",
        'WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND ' + LIVE,
      ].join(' ')).bind(runId, n, deps.workerId, JSON.stringify(output), tokens, cost),
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
    try {
      assertNotD12Verdict(call.args);
    } catch {
      refused('d12_verdict_forbidden_on_api_channel');
      continue;
    }
    const effect = await runEffect(db, runId, n, idx, call, deps, now);
    if ('outcome' in effect) return effect;
    results.push(effect);
  }

  // 3. Checkpoint : étape terminée et exécution avancée dans le même lot, sous la garde LIVE.
  const final = output.tool_calls.length === 0 ? 1 : 0;
  const [done] = await db.batch([
    db.prepare([
      "UPDATE agent_run_steps SET state = 'completed', results = ?4, completed_at = ?5",
      "WHERE run_id = ?1 AND n = ?2 AND claimed_by = ?3 AND state = 'model_done' AND " + LIVE,
    ].join(' ')).bind(runId, n, deps.workerId, JSON.stringify(results), now),
    db.prepare([
      'UPDATE agent_runs SET steps_done = steps_done + 1, updated_at = ?3,',
      "  status = CASE WHEN ?4 = 1 THEN 'completed' ELSE status END,",
      "  stop_reason = CASE WHEN ?4 = 1 THEN 'final' ELSE stop_reason END,",
      '  summary = CASE WHEN ?4 = 1 THEN ?5 ELSE summary END',
      'WHERE run_id = ?1 AND steps_done = ?2 AND EXISTS (SELECT 1 FROM agent_run_steps',
      "  WHERE run_id = ?1 AND n = ?2 AND state = 'completed' AND claimed_by = ?6 AND completed_at = ?3)",
    ].join(' ')).bind(runId, n, now, final, output.text.slice(0, 4000), deps.workerId),
  ]);
  if (done.meta.changes !== 1) return settled(db, runId, now);
  if (final) return { outcome: 'completed' };
  const status = await settle(db, runId, now);
  return { outcome: status === 'running' ? 'stepped' : status };
}

/** Effet externe selon R2. Rend l'entrée de résultat, ou un arrêt. */
async function runEffect(db: D1Database, runId: string, n: number, idx: number, call: ToolCall, deps: EngineDeps, now: number):
  Promise<ResultEntry | StepResult> {
  const key = await sha256Hex(canonical({ run_id: runId, n, idx, tool: call.name, args: call.args }));
  const ctx = { run_id: runId, effect_key: key };
  const mark = (status: 'completed' | 'failed' | 'ambiguous', result: string) =>
    db.prepare('UPDATE agent_run_effects SET status = ?2, result = ?3, updated_at = ?4 WHERE effect_key = ?1')
      .bind(key, status, result, now).run();
  const effect = await db.prepare('SELECT status, result FROM agent_run_effects WHERE effect_key = ?1').bind(key).first<EffectRow>();
  if (effect?.status === 'completed') return { id: call.id, content: effect.result ?? '' };
  if (effect?.status === 'failed') return { id: call.id, content: effect.result ?? '', error: true };
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
      await stopAs(db, runId, 'needs_reconcile', 'effect_outcome_unknown: ' + call.name, now);
      return { outcome: 'needs_reconcile' };
    }
    // found === { found: false } : l'effet n'a certainement pas eu lieu, il peut être tenté.
  }
  if (!effect) {
    const intent = await db.prepare([
      'INSERT OR IGNORE INTO agent_run_effects (effect_key, run_id, n, idx, tool, args, status, updated_at)',
      "SELECT ?2, ?1, ?3, ?4, ?5, ?6, 'intent', ?7 WHERE " + LIVE,
    ].join(' ')).bind(runId, key, n, idx, call.name, canonical(call.args), now).run();
    if (intent.meta.changes !== 1) return settled(db, runId, now);
  }
  const pending = await db.prepare([
    "UPDATE agent_run_effects SET status = 'pending', updated_at = ?3",
    "WHERE effect_key = ?2 AND status IN ('intent','pending','ambiguous') AND " + LIVE,
  ].join(' ')).bind(runId, key, now).run();
  if (pending.meta.changes !== 1) return settled(db, runId, now);
  await deps.probe?.('before_effect');
  let result: unknown;
  try {
    result = await deps.tools.execute(call, ctx);
  } catch (error) {
    if (error instanceof ToolRefused) {
      const content = JSON.stringify({ error: errorText(error) });
      await mark('failed', content);
      return { id: call.id, content, error: true };
    }
    await mark('ambiguous', JSON.stringify({ error: errorText(error) }));
    await stopAs(db, runId, 'needs_reconcile', 'effect_outcome_unknown: ' + call.name, now);
    return { outcome: 'needs_reconcile' };
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

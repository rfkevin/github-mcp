/**
 * CC-7 L8 (plan CC-PLAN-7 v0.2 S2, constat de Kevin du 2026-10-27) — chaque agent
 * sur SA propre API : un modèle par participant, et tous les fournisseurs déjà
 * ajoutés au dépôt (Workers AI, Z.ai, xAI, Anthropic, Gemini, Groq, OpenRouter,
 * DeepSeek) sur le moteur des agents API.
 *
 * Aiguillage : AGENT_RUN_MODEL_<PARTICIPANT> (identifiant en majuscules, tout
 * caractère hors [A-Z0-9] remplacé par « _ ») prime sur le réglage global
 * (AGENT_RUN_PAID_MODEL puis AGENT_RUN_MODEL, inchangés). Le participant est
 * relu dans agent_runs depuis le run_id, jamais depuis le modèle ni ses arguments.
 *
 * Gratuit ou payant, décidé par le serveur, jamais par le modèle :
 * - GRATUIT : référence du registre daté API_FREE_MODELS (ou modèle OpenRouter
 *   « :free ») ET conditions du fournisseur (Gemini et Groq : attestation owner
 *   <FOURNISSEUR>_FREE_PROJECT_ATTESTED="true" ET origine cc3-test, précédent
 *   CC-4) ; coût 0, aucune enveloppe ; Workers AI : liste gratuite FREE_MODEL_RATES ;
 * - PAYANT : tarif daté API_MODEL_RATES, derrière l'enveloppe PAR PARTICIPANT
 *   (0 par défaut = refus avant tout appel) ;
 * - sinon refus à la construction (<FOURNISSEUR>_MODEL_UNSUPPORTED), aucun appel.
 * Secrets LLM_KEY_* posés par Kevin seul ; absent = EXECUTOR_UNAVAILABLE avant tout appel.
 */
import { FREE_MODEL_RATES, parseWorkersAiRef, type WorkersAiBinding } from '../executors/adapter';
import { apiModelRate } from '../executors/model-rates';
import { geminiFreeAttestedFromEnv, type GeminiEnv } from '../executors/gemini';
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL, GROQ_CHAT_COMPLETIONS_URL, OPENROUTER_CHAT_COMPLETIONS_URL, XAI_CHAT_COMPLETIONS_URL,
  ZAI_CHAT_COMPLETIONS_URL, groqFreeAttestedFromEnv,
} from '../executors/openai-compatible';
import { ModelCallError, type ModelClient } from './engine';
import { createAnthropicModel } from './anthropic-model';
import { GEMINI_PROTOCOL, geminiGenerateUrl } from './gemini-model';
import { createOpenAiPaidModel } from './openai-paid-model';
import { createPaidWorkersAiModel, parsePaidWorkersAiRef, type ParticipantEnvelope } from './paid-model';
import { createPaidProtocolModel } from './paid-protocol';
// CC-8 S6 (raccordement suite) : comptage bêta des appels réels du maillon suivi.
import { recordBetaExecution } from './beta';

/**
 * CC-8 S6 (raccordement suite) : compte un appel RÉEL du maillon suivi dans son
 * suivi de bêta (une ligne par run, idempotent). Les sondes sont exclues à
 * l'appelant (diagnostic de ré-qualification, jamais une exécution productive —
 * une boucle de sondes ne franchirait pas les paliers d'avance). Best-effort :
 * une panne de ce comptage n'échoue jamais l'appel servi ; il est distinct du
 * cumul global agent_model_calls et du coupe-circuit S1b-2, inchangés.
 */
export async function recordBetaExecutionForCall(db: D1Database, input: {
  readonly participant_id: string;
  readonly ref: string;
  readonly run_id: string;
  readonly at: number;
  readonly ok: boolean;
  readonly latency_ms: number;
}): Promise<void> {
  try {
    await recordBetaExecution(db, {
      participant_id: input.participant_id, ref: input.ref, run_id: input.run_id,
      at: input.at, ok: input.ok, latency_ms: input.latency_ms,
    });
  } catch { /* comptage bêta best-effort : jamais bloquant pour l'appel servi */ }
}
import { createWorkersAiModel, type ToolSchema } from './workers-ai-model';
import { effortMaxTokens, effortOptions, type Effort } from './effort';
import { modelFailureKind } from './model-failure';
// CC-7 F1 : fiche canonique des agents — tampon version + hash (module pur fiche.ts, artefact généré).
import { ficheStamp } from './fiche';
import { FICHE_HASH, FICHE_VERSION } from './generated/agent-fiche.generated';
import { acquireBreakerProbeLease, breakerOpenUntil, budgetState, chooseModel, modelOption, modelPreference, participantEnvelope, recordModelCall, recordModelCallWithBreaker, recordModelChoice, resolveParticipantPolicy, type PolicyEnv } from './model-policy';
// CC-8 S1b-2 : prédicat pur du coupe-circuit (option B).
import { breakerSkipping, BREAKER_PROBE_LEASE_S, STEP_MODEL_BUDGET_FLOOR_MS } from './run-policy';

/** Date (UTC) du registre gratuit ; à revalider avant toute activation. */
export const API_FREE_MODELS_SNAPSHOT_DATE = '2026-10-30';
/** Modèles gratuits vérifiés hors Workers AI (repris du module CC-4 executors), deny-by-default. */
export const API_FREE_MODELS: ReadonlySet<string> = new Set([
  'gemini:gemini-3.5-flash-lite',
  // CC-7 (2026-10-30, page tarifaire officielle) : palier gratuit aussi sur 3.8 Flash et 3.6 Flash.
  // 3.7 Flash est déprécié (redirigé vers 3.8 Flash) : jamais listé.
  'gemini:gemini-3.6-flash',
  'gemini:gemini-3.8-flash',
  'groq:openai/gpt-oss-20b',
  'zai:glm-4.7-flash',
]);
const OPENROUTER_FREE_RE = /^openrouter:[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}:free$/i;

/** Fournisseurs du canal API (préfixe de la référence). */
export const API_PROVIDERS = ['workers-ai', 'zai', 'xai', 'anthropic', 'gemini', 'groq', 'openrouter', 'deepseek'] as const;
export type ApiProvider = typeof API_PROVIDERS[number];

const REF_RE = /^([a-z][a-z-]{1,15}):(\S{1,200})$/;

export interface ProviderEnv extends GeminiEnv {
  LLM_KEY_ZAI?: string;
  LLM_KEY_XAI?: string;
  LLM_KEY_ANTHROPIC?: string;
  LLM_KEY_GEMINI?: string;
  LLM_KEY_GROQ?: string;
  LLM_KEY_OPENROUTER?: string;
  LLM_KEY_DEEPSEEK?: string;
  GROQ_FREE_PROJECT_ATTESTED?: string;
}

/** Ce que l'hôte (engineFor) fournit pour construire un modèle. */
export interface ProviderModelContext {
  env: ProviderEnv;
  db: D1Database;
  runId: string;
  envelope: ParticipantEnvelope;
  schemas: (taskKind: string) => ToolSchema[];
  system: string;
  maxOutputTokens: number;
  maxOutputTokensFor?: (taskKind: string) => number;
  ai?: WorkersAiBinding;
  neuronBudget?: number;
  /** Tests seulement : fetch injecté et horloge. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** CC-7 L9b : niveau de réflexion décidé par le serveur (absent = réglages historiques du fournisseur). */
  effort?: Effort | null;
}

/** Fournisseurs ajoutés en L8 : passent par la fabrique même sans aiguillage par participant. */
export function isL8ProviderRef(ref: string | null): boolean {
  return ref !== null && /^(gemini|groq|openrouter|deepseek):/.test(ref);
}

/** Palier demandé : 'auto' (aiguillage par participant), 'free' (AGENT_RUN_MODEL historique), 'paid' (AGENT_RUN_PAID_MODEL historique). */
export type ModelTier = 'auto' | 'free' | 'paid';

/** Nom de la variable du modèle d'un participant. */
export function participantModelVar(participantId: string): string {
  return 'AGENT_RUN_MODEL_' + participantId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Au moins un aiguillage par participant (L8 : AGENT_RUN_MODEL_<P> ; L9a : AGENT_RUN_MODELS_<P>) est posé sur le Worker. */
export function hasParticipantModels(env: object): boolean {
  return Object.entries(env).some(([key, value]) => /^AGENT_RUN_MODELS?_/.test(key) && typeof value === 'string' && value.trim() !== '');
}

/** Modèle d'un participant : sa variable, sinon le réglage global ; null = aucun modèle. */
export function participantModelRoute(env: object & { AGENT_RUN_MODEL?: string; AGENT_RUN_PAID_MODEL?: string },
  participantId: string): { ref: string; tier: ModelTier } | null {
  const own = (env as Record<string, unknown>)[participantModelVar(participantId)];
  if (typeof own === 'string' && own.trim()) return { ref: own.trim(), tier: 'auto' };
  if (env.AGENT_RUN_PAID_MODEL) return { ref: env.AGENT_RUN_PAID_MODEL, tier: 'paid' };
  if (env.AGENT_RUN_MODEL) return { ref: env.AGENT_RUN_MODEL, tier: 'free' };
  return null;
}

/** Le modèle gratuit est-il permis pour ce fournisseur (attestation owner là où le précédent CC-4 l'exige) ? */
export function freeAllowed(provider: ApiProvider, env: ProviderEnv): boolean {
  if (provider === 'gemini') return geminiFreeAttestedFromEnv(env);
  if (provider === 'groq') return groqFreeAttestedFromEnv(env);
  return provider === 'zai' || provider === 'openrouter';
}

export function isFreeApiModel(ref: string): boolean {
  return API_FREE_MODELS.has(ref) || OPENROUTER_FREE_RE.test(ref);
}

interface ProviderConfig { url: (model: string) => string; secret: (env: ProviderEnv) => string | undefined; options?: (model: string) => Record<string, unknown> | undefined }

const OPENAI_COMPATIBLE: Readonly<Record<'zai' | 'xai' | 'groq' | 'openrouter' | 'deepseek', ProviderConfig>> = {
  // Raisonnement coupé (précédents glm-4.7-flash et L2) : réponses directes du canal API.
  zai: { url: () => ZAI_CHAT_COMPLETIONS_URL, secret: env => env.LLM_KEY_ZAI, options: () => ({ thinking: { type: 'disabled' } }) },
  xai: { url: () => XAI_CHAT_COMPLETIONS_URL, secret: env => env.LLM_KEY_XAI },
  // gpt-oss raisonne par défaut et peut épuiser max_tokens (précédent CC-5 L1) : effort bas.
  groq: { url: () => GROQ_CHAT_COMPLETIONS_URL, secret: env => env.LLM_KEY_GROQ,
    options: model => model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : undefined },
  // Données jamais conservées par les fournisseurs relais (précédent CC-4).
  openrouter: { url: () => OPENROUTER_CHAT_COMPLETIONS_URL, secret: env => env.LLM_KEY_OPENROUTER,
    options: () => ({ provider: { data_collection: 'deny' } }) },
  deepseek: { url: () => DEEPSEEK_CHAT_COMPLETIONS_URL, secret: env => env.LLM_KEY_DEEPSEEK },
};

function unsupported(provider: string, detail: string): Error {
  return new Error(provider.toUpperCase().replace(/-/g, '_') + '_MODEL_UNSUPPORTED : ' + detail);
}

/** Résultat de la résolution pure d'une référence à un palier : canal gratuit ou payant, rien n'est construit. */
export interface ProviderRoute { provider: ApiProvider; model: string; free: boolean }

/**
 * CC-8 S1a — résolution PURE d'une référence à un palier (auto / free / paid) : exactement les règles de la
 * fabrique createProviderModel, qui l'appelle elle-même, avec les mêmes erreurs typées. Sert aussi au
 * planificateur (runCapacity) pour ne jamais créer une exécution que la fabrique refuserait.
 * Workers AI : gratuit si palier free, ou auto et modèle de la liste gratuite ; sinon chemin payant
 * (liste payante vérifiée, deny-by-default). API : gratuit si palier non « paid », modèle du registre
 * gratuit et gratuit permis (attestation) ; « free » refuse tout payant ; payant exige un tarif daté.
 */
export function resolveProviderRoute(ref: string, tier: ModelTier, env: ProviderEnv, hasAi: boolean): ProviderRoute {
  const match = REF_RE.exec(ref);
  const provider = match?.[1] as ApiProvider | undefined;
  if (!match || !provider || !API_PROVIDERS.includes(provider)) {
    throw new Error('MODEL_PROVIDER_UNSUPPORTED : ' + (match?.[1] ?? ref) + ' (fournisseurs : ' + API_PROVIDERS.join(', ') + ').');
  }
  const model = match[2];
  if (provider === 'workers-ai') {
    if (!hasAi) throw unsupported(provider, 'binding AI absent sur ce Worker.');
    const free = tier === 'free' || (tier === 'auto' && FREE_MODEL_RATES[model] !== undefined);
    if (free) parseWorkersAiRef(ref);
    else parsePaidWorkersAiRef(ref);
    return { provider, model, free };
  }
  const free = tier !== 'paid' && isFreeApiModel(ref) && freeAllowed(provider, env);
  // AGENT_RUN_MODEL (palier « free ») ne bascule jamais vers un chemin payant.
  if (tier === 'free' && !free) {
    throw unsupported(provider, model + ' : AGENT_RUN_MODEL n’accepte qu’un modèle gratuit permis (registre gratuit + attestation owner si exigée).');
  }
  if (!free && apiModelRate(ref) === null) {
    throw unsupported(provider, isFreeApiModel(ref)
      ? model + ' est gratuit mais non permis ici (attestation owner du compte gratuit ou origine cc3-test absente) et sans tarif daté.'
      : model + ' hors du registre gratuit et du registre des tarifs daté (deny-by-default).');
  }
  return { provider, model, free };
}

/**
 * Fabrique unique : la référence <fournisseur>:<modèle> décide, aucun repli inter-familles.
 * Lève une erreur typée à la construction (rien n'est appelé) si la référence n'est ni gratuite permise, ni tarifée.
 */
export function createProviderModel(ref: string, tier: ModelTier, ctx: ProviderModelContext): ModelClient {
  const { provider, model, free } = resolveProviderRoute(ref, tier, ctx.env, !!ctx.ai);
  // CC-7 L9b : la réflexion consomme des jetons de sortie — plafond de l'étape relevé (borné à 8192), même pire cas réservé.
  const effort = ctx.effort ?? null;
  const effortOpts = effort ? effortOptions(ref, effort) : null;
  const maxOutputTokensFor = effortOpts
    ? (kind: string) => effortMaxTokens(ctx.maxOutputTokensFor?.(kind) ?? ctx.maxOutputTokens, effort)
    : ctx.maxOutputTokensFor;
  const core = { ref, db: ctx.db, runId: ctx.runId, envelope: ctx.envelope, schemas: ctx.schemas, system: ctx.system,
    maxOutputTokens: ctx.maxOutputTokens, maxOutputTokensFor, fetchImpl: ctx.fetchImpl, now: ctx.now };

  if (provider === 'workers-ai') {
    if (!ctx.ai) throw unsupported(provider, 'binding AI absent sur ce Worker.');
    return free
      ? createWorkersAiModel({ ai: ctx.ai, ref, db: ctx.db, neuronBudget: ctx.neuronBudget ?? 0, schemas: ctx.schemas,
        system: ctx.system, maxOutputTokens: ctx.maxOutputTokens, maxOutputTokensFor: ctx.maxOutputTokensFor })
      : createPaidWorkersAiModel({ ai: ctx.ai, ...core, maxOutputTokensFor: ctx.maxOutputTokensFor });
  }

  if (provider === 'anthropic') return createAnthropicModel({ ...core, env: ctx.env, requestOptions: effortOpts ?? undefined });
  if (provider === 'gemini') {
    return createPaidProtocolModel({ ...core, free, secret: ctx.env.LLM_KEY_GEMINI, url: geminiGenerateUrl(model),
      provider, protocol: GEMINI_PROTOCOL, requestOptions: effortOpts ?? undefined });
  }
  const config = OPENAI_COMPATIBLE[provider];
  const base = config.options?.(model);
  return createOpenAiPaidModel({ ...core, free, secret: config.secret(ctx.env), url: config.url(model), provider,
    requestOptions: base || effortOpts ? { ...(base ?? {}), ...(effortOpts ?? {}) } : undefined });
}

/**
 * CC8 S7 lot B R5 (#282) : trace append-only de chaque essai de maillon d'un appel modèle — maillon choisi,
 * maillon réellement appelé (repli compris), issue, classe d'échec et latence. Aucun prompt, aucune sortie.
 * Best-effort : une trace manquante ne bloque jamais l'appel.
 */
export async function recordRunModelCall(db: D1Database, input: { run_id: string; n: number; chosen_ref: string; ref: string;
  ok: boolean; failure: string; latency_ms: number; at: number;
  input_tokens?: number | null; output_tokens?: number | null; estimated_input_tokens?: number | null }): Promise<void> {
  try {
    // Both rows are inserted in one transaction; no private prompt or output is persisted.
    await db.batch([
      db.prepare([
        'INSERT OR IGNORE INTO agent_run_model_calls (run_id, n, k, chosen_ref, ref, ok, failure, latency_ms, at)',
        'SELECT ?1, ?2, COALESCE((SELECT MAX(k) + 1 FROM agent_run_model_calls WHERE run_id = ?1 AND n = ?2), 0), ?3, ?4, ?5, ?6, ?7, ?8',
      ].join(' ')).bind(input.run_id, input.n, input.chosen_ref, input.ref, input.ok ? 1 : 0, input.failure.slice(0, 40),
        Math.max(0, Math.round(input.latency_ms)), input.at),
      db.prepare([
        'INSERT OR IGNORE INTO agent_run_call_usage (run_id, n, k, input_tokens, output_tokens, estimated_input_tokens)',
        'SELECT run_id, n, k, ?3, ?4, ?5 FROM agent_run_model_calls',
        'WHERE run_id = ?1 AND n = ?2 ORDER BY k DESC LIMIT 1',
      ].join(' ')).bind(input.run_id, input.n, input.input_tokens ?? null, input.output_tokens ?? null,
        input.estimated_input_tokens ?? null),
    ]);
  } catch {
    // Optional telemetry failure never invents measurements or hides the real model outcome.
  }
}

/**
 * Modèle aiguillé à l'exécution : participant relu dans agent_runs à CHAQUE étape. Sans politique
 * (CC-7 L8) : sa référence unique ; avec politique (CC-7 L9a, AGENT_RUN_FAMILY_<P> + AGENT_RUN_MODELS_<P>) :
 * choix serveur par étape dans sa famille et sous son budget, journalisé. Un refus fait échouer l'étape
 * proprement (ModelCallError sans usage), jamais un repli vers un autre fournisseur ou une autre famille.
 * L'enveloppe payante est celle de l'agent (AGENT_RUN_PAID_*_CENTS_<P>, sinon l'enveloppe commune).
 */
export function createRoutedModel(env: ProviderEnv & { AGENT_RUN_MODEL?: string; AGENT_RUN_PAID_MODEL?: string },
  ctx: ProviderModelContext): ModelClient {
  const models = new Map<string, ModelClient>();
  const build = (ref: string, tier: ModelTier, envelope: ProviderModelContext['envelope'], effort: Effort | null = null): ModelClient => {
    const key = tier + '|' + ref + '|' + (effort ?? '');
    let model = models.get(key);
    if (!model) {
      try {
        model = createProviderModel(ref, tier, { ...ctx, envelope, effort });
      } catch (error) {
        throw new ModelCallError('MODEL_ROUTE_REFUSED : ' + (error instanceof Error ? error.message : String(error)), null);
      }
      models.set(key, model);
    }
    return model;
  };
  return {
    async complete(input) {
      const run = await ctx.db.prepare('SELECT participant_id, cycle_id, task_id, task_kind, steps_done FROM agent_runs WHERE run_id = ?1')
        .bind(ctx.runId).first<{ participant_id: string; cycle_id: string; task_id: string; task_kind: string; steps_done: number }>();
      if (!run) throw new ModelCallError('MODEL_ROUTE_UNKNOWN_RUN : exécution ' + ctx.runId + ' introuvable.', null);
      const now = ctx.now?.() ?? new Date();
      let policy;
      try {
        policy = (await resolveParticipantPolicy(ctx.db, env as PolicyEnv, run.participant_id)).policy;
      } catch (error) {
        throw new ModelCallError('MODEL_ROUTE_REFUSED : ' + (error instanceof Error ? error.message : String(error)), null);
      }
      let ref: string;
      let model: ModelClient;
      let fallback: Array<{ ref: string; effort: Effort | null; envelope: ProviderModelContext['envelope'] }> = [];
      if (policy) {
        const kind = input.task_kind || run.task_kind;
        const budget = await budgetState(ctx.db, policy.envelope, run.participant_id, run.cycle_id, now);
        const preference = await modelPreference(ctx.db, run.cycle_id, run.participant_id, run.task_id);
        let choice;
        try {
          choice = chooseModel(env as PolicyEnv, policy, kind, budget, preference);
        } catch (error) {
          throw new ModelCallError(error instanceof Error ? (error as Error & { code?: string }).code + ' : ' + error.message : String(error), null);
        }
        // CC-7 F1 (P3 #1138 §1) : version et hash de la fiche canonique journalisés avec chaque choix serveur.
        await recordModelChoice(ctx.db, ctx.runId, run.steps_done, run.participant_id,
          { ...choice, reason: choice.reason + ficheStamp(FICHE_VERSION, FICHE_HASH) }, Math.floor(now.getTime() / 1000));
        ref = choice.ref;
        model = build(ref, 'auto', policy.envelope, choice.effort);
        fallback = policy.models.slice(policy.models.indexOf(ref) + 1).filter(candidate => {
          const option = modelOption(env as PolicyEnv, candidate, kind, choice.effort);
          return (option.tier === 'free' && option.credential_present) || (option.tier === 'paid' && option.credential_present && option.est_step_cents !== null
            && option.est_step_cents <= budget.day_limit - budget.day_spent
            && option.est_step_cents <= budget.cycle_limit - budget.cycle_spent);
        }).map(candidate => ({ ref: candidate, effort: choice.effort, envelope: policy.envelope }));
      } else {
        const route = participantModelRoute(env, run.participant_id);
        if (!route) {
          throw new ModelCallError('MODEL_ROUTE_NONE : aucun modèle pour ' + run.participant_id + ' (' + participantModelVar(run.participant_id)
            + ' ou AGENT_RUN_MODEL).', null);
        }
        ref = route.ref;
        model = build(ref, route.tier, participantEnvelope(env as PolicyEnv, run.participant_id));
      }
      let lastError: unknown;
      let priorProviderTransient = false;
      // A retry chain is ONE model step. Failed upstream calls already consume its token budget.
      let spentTokens = 0;
      let spentCents = 0;
      let candidates = [{ ref, model: () => model }, ...fallback.map(item => ({
        ref: item.ref, model: () => build(item.ref, 'auto', item.envelope, item.effort),
      }))];
      // CC-8 S1b-2 : coupe-circuit option B (participant × modèle). Les sondes (task_kind
      // probe) sont exemptées : elles re-testent un maillon en pause — c’est le signal S6,
      // jamais une mutation de chaîne. Les refus de budget local ne passent pas ici : ils
      // sont levés avant tout appel, donc jamais comptés par le coupe-circuit.
      const taskKind = input.task_kind || run.task_kind;
      const isProbe = taskKind === 'probe';
      const nowSec = Math.floor(now.getTime() / 1000);
      let openUntil = new Map<string, number>();
      if (!isProbe) {
        openUntil = await breakerOpenUntil(ctx.db, run.participant_id, candidates.map(candidate => candidate.ref));
        const available = candidates.filter(candidate => !breakerSkipping({ circuit_open_until: openUntil.get(candidate.ref) ?? 0 }, nowSec));
        if (!available.length) {
          const resume = Math.max(...candidates.map(candidate => openUntil.get(candidate.ref) ?? 0));
          throw new ModelCallError('CIRCUIT_OPEN : tous les maillons de ' + run.participant_id + ' sont en pause coupe-circuit ('
            + candidates.map(candidate => candidate.ref + ' jusqu’à ' + (openUntil.get(candidate.ref) ?? 0)).join(', ')
            + ') ; reprise au plus tôt à ' + resume + ' (UTC, secondes).', null);
        }
        candidates = available;
      }
      // CC-8 S1b-2 : chaque appel reçoit le budget RESTANT de l'étape, décompté du temps
      // consommé par les maillons précédents ; sous le plancher de 30 s : arrêt propre
      // transient, AUCUN appel supplémentaire (v2 point 4).
      const completeStartedMs = (ctx.now?.() ?? new Date()).getTime();
      // 2e relecture D12 #255 : maillons écartés parce que leur bail de sonde post-pause
      // est détenu par un autre run — si TOUS le sont, AUCUN appel n'a lieu et lastError
      // resterait undefined ; l'échec doit rester TRANSITOIRE (CIRCUIT_OPEN, relance S1b).
      const leaseBlocked: string[] = [];
      for (const candidate of candidates) {
        const budgetLeftMs = typeof input.budget_left_ms === 'number'
          ? input.budget_left_ms - ((ctx.now?.() ?? new Date()).getTime() - completeStartedMs)
          : undefined;
        if (typeof budgetLeftMs === 'number' && budgetLeftMs < STEP_MODEL_BUDGET_FLOOR_MS) {
          throw new ModelCallError('STEP_MODEL_BUDGET_EXHAUSTED : budget d’appels modèle de l’étape épuisé ('
            + Math.max(0, Math.trunc(budgetLeftMs)) + ' ms restants, plan S1b-2 v2 point 4) ; relance d’exécution S1b.', null);
        }
        // Bloquant 2 (D12 #255) : ré-qualification post-pause — UN SEUL essai à la fois par
        // maillon, bail CAS pris juste avant l'appel (un maillon jamais appelé ne bloque
        // personne). L'issue de l'appel libère le bail (recordModelCallWithBreaker).
        // Fencing (2e relecture #255) : sans jeton, le bail ne peut pas être libéré par un
        // appel antérieur — un maillon ré-qualifié n'est appelé que par le preneur du bail
        // (les sondes exemptées écrivent via recordModelCall, jamais le breaker ni le bail),
        // et l'appel du preneur dure au plus 120 s (providerTimeoutMs) < fenêtre 180 s :
        // son issue tombe donc TOUJOURS dans sa propre fenêtre, jamais sur celle d'un autre.
        const open = openUntil.get(candidate.ref) ?? 0;
        if (!isProbe && open > 0 && open <= nowSec
          && !(await acquireBreakerProbeLease(ctx.db, run.participant_id, candidate.ref, nowSec, BREAKER_PROBE_LEASE_S))) {
          leaseBlocked.push(candidate.ref);
          continue;
        }
        const started = Date.now();
        try {
          const tokensRemaining = input.budget_left_tokens === undefined ? undefined
            : Math.max(0, input.budget_left_tokens - spentTokens);
          const result = await candidate.model().complete({ ...input, budget_left_ms: budgetLeftMs,
            budget_left_tokens: tokensRemaining });
          await recordRunModelCall(ctx.db, { run_id: ctx.runId, n: run.steps_done, chosen_ref: ref, ref: candidate.ref, ok: true, failure: '',
            latency_ms: Date.now() - started, at: Math.floor(now.getTime() / 1000),
            input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
            estimated_input_tokens: result.usage.estimated_input_tokens });
          if (isProbe) {
            await recordModelCall(ctx.db, candidate.ref, { ok: true, at: Math.floor(now.getTime() / 1000), latencyMs: Date.now() - started });
          } else {
            await recordModelCallWithBreaker(ctx.db, run.participant_id, candidate.ref,
              { ok: true, at: Math.floor(now.getTime() / 1000), latencyMs: Date.now() - started });
            // CC-8 S6 (suite) : exécution réelle du maillon — comptée pour son suivi de bêta.
            await recordBetaExecutionForCall(ctx.db, { participant_id: run.participant_id, ref: candidate.ref,
              run_id: ctx.runId, at: Math.floor(now.getTime() / 1000), ok: true, latency_ms: Date.now() - started });
          }
          return { ...result, usage: { ...result.usage,
            tokens: result.usage.tokens + spentTokens,
            cost_cents: result.usage.cost_cents + spentCents } };
        } catch (error) {
          if (error instanceof ModelCallError && error.usage) {
            spentTokens += Math.max(0, error.usage.tokens);
            spentCents += Math.max(0, error.usage.cost_cents);
          }
          // A local preflight refusal never reached the provider; it is NOT a provider outage.
          if (error instanceof ModelCallError && error.message.startsWith('token_preflight_refused:')) {
            throw new ModelCallError(error.message, { tokens: spentTokens, cost_cents: spentCents });
          }
          lastError = error;
          const transient = modelFailureKind(error) === 'transient';
          await recordRunModelCall(ctx.db, { run_id: ctx.runId, n: run.steps_done, chosen_ref: ref, ref: candidate.ref, ok: false,
            failure: transient ? 'transient' : 'permanent', latency_ms: Date.now() - started, at: Math.floor(now.getTime() / 1000),
            input_tokens: error instanceof ModelCallError ? error.usage?.input_tokens : null,
            output_tokens: error instanceof ModelCallError ? error.usage?.output_tokens : null });
          const outcome = { ok: false, at: Math.floor(now.getTime() / 1000), latencyMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error) };
          // Échec PERMANENT : cumul seul — le coupe-circuit ne compte que le transitoire.
          if (!transient || isProbe) {
            await recordModelCall(ctx.db, candidate.ref, outcome);
          } else {
            await recordModelCallWithBreaker(ctx.db, run.participant_id, candidate.ref, outcome);
          }
          // CC-8 S6 (suite) : l’échec réel d’un maillon compte AUSSI (taux d’échec du retour
          // arrière) — succès, échec transitoire ET permanent ; jamais pour une sonde, déjà
          // exclue du comptage productif. AVANT le throw permanent (relectures #265 : une
          // bêta en panne ne doit jamais paraître saine) ; best-effort, sans avaler l’erreur.
          if (!isProbe) {
            await recordBetaExecutionForCall(ctx.db, { participant_id: run.participant_id, ref: candidate.ref,
              run_id: ctx.runId, at: outcome.at, ok: false, latency_ms: outcome.latencyMs });
          }
          if (!transient) {
            // An OPTIONAL fallback can reject a valid primary-model conversation
            // (e.g. HTTP 400 on its own tool schema). When the primary just failed
            // transiently, the entire work step is retryable on the primary:
            // do not turn a provider outage into a terminal WorkSession failure.
            // Permanent authorization, budget and routing refusals remain terminal.
            const reason = error instanceof Error ? error.message : String(error);
            if (priorProviderTransient && candidate.ref !== ref
              && !/MODEL_ROUTE_REFUSED|MODEL_BUDGET_EXHAUSTED|PAID_ENVELOPE_NOT_FUNDED|token_preflight_refused|\\b(?:401|403)\\b/i.test(reason)) {
              throw new ModelCallError('FALLBACK_AFTER_TRANSIENT: primary ' + ref
                + ' unavailable, fallback ' + candidate.ref + ' rejected this request; retry primary after backoff.',
                { tokens: spentTokens, cost_cents: spentCents });
            }
            if (error instanceof ModelCallError) throw new ModelCallError(error.message,
              { tokens: spentTokens, cost_cents: spentCents });
            throw error;
          }
          priorProviderTransient = true;
        }
      }
      // 2e relecture D12 #255 : zéro appel parce que chaque bail de sonde était détenu —
      // échec TRANSITOIRE explicite, jamais un throw undefined classé permanent.
      if (lastError === undefined && leaseBlocked.length) {
        throw new ModelCallError('CIRCUIT_OPEN : tous les maillons de ' + run.participant_id
          + ' sont en ré-qualification post-pause, bail de sonde détenu par un autre run ('
          + leaseBlocked.join(', ') + ', fenêtre ' + BREAKER_PROBE_LEASE_S + ' s) ; reprise au plus tôt à '
          + (nowSec + BREAKER_PROBE_LEASE_S) + ' (UTC, secondes), relance d’exécution S1b.', null);
      }
      if (lastError instanceof ModelCallError) throw new ModelCallError(lastError.message,
        { tokens: spentTokens, cost_cents: spentCents });
      throw lastError;
    },
  };
}

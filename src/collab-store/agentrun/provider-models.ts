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
import { FREE_MODEL_RATES, type WorkersAiBinding } from '../executors/adapter';
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
import { createPaidWorkersAiModel, type ParticipantEnvelope } from './paid-model';
import { createPaidProtocolModel } from './paid-protocol';
import { createWorkersAiModel, type ToolSchema } from './workers-ai-model';
import { effortMaxTokens, effortOptions, type Effort } from './effort';
// CC-7 F1 : fiche canonique des agents — tampon version + hash (module pur fiche.ts, artefact généré).
import { ficheStamp } from './fiche';
import { FICHE_HASH, FICHE_VERSION } from './generated/agent-fiche.generated';
import { budgetState, chooseModel, modelPreference, participantEnvelope, participantPolicy, recordModelCall, recordModelChoice, type PolicyEnv } from './model-policy';

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

/**
 * Fabrique unique : la référence <fournisseur>:<modèle> décide, aucun repli inter-familles.
 * Lève une erreur typée à la construction (rien n'est appelé) si la référence n'est ni gratuite permise, ni tarifée.
 */
export function createProviderModel(ref: string, tier: ModelTier, ctx: ProviderModelContext): ModelClient {
  const match = REF_RE.exec(ref);
  const provider = match?.[1] as ApiProvider | undefined;
  if (!match || !provider || !API_PROVIDERS.includes(provider)) {
    throw new Error('MODEL_PROVIDER_UNSUPPORTED : ' + (match?.[1] ?? ref) + ' (fournisseurs : ' + API_PROVIDERS.join(', ') + ').');
  }
  const model = match[2];
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
    const free = tier === 'free' || (tier === 'auto' && FREE_MODEL_RATES[model] !== undefined);
    return free
      ? createWorkersAiModel({ ai: ctx.ai, ref, db: ctx.db, neuronBudget: ctx.neuronBudget ?? 0, schemas: ctx.schemas,
        system: ctx.system, maxOutputTokens: ctx.maxOutputTokens, maxOutputTokensFor: ctx.maxOutputTokensFor })
      : createPaidWorkersAiModel({ ai: ctx.ai, ...core, maxOutputTokensFor: ctx.maxOutputTokensFor });
  }

  const free = tier !== 'paid' && isFreeApiModel(ref) && freeAllowed(provider, ctx.env);
  // AGENT_RUN_MODEL (palier « free ») ne bascule jamais vers un chemin payant.
  if (tier === 'free' && !free) {
    throw unsupported(provider, model + ' : AGENT_RUN_MODEL n’accepte qu’un modèle gratuit permis (registre gratuit + attestation owner si exigée).');
  }
  if (!free && apiModelRate(ref) === null) {
    throw unsupported(provider, isFreeApiModel(ref)
      ? model + ' est gratuit mais non permis ici (attestation owner du compte gratuit ou origine cc3-test absente) et sans tarif daté.'
      : model + ' hors du registre gratuit et du registre des tarifs daté (deny-by-default).');
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
        policy = participantPolicy(env as PolicyEnv, run.participant_id);
      } catch (error) {
        throw new ModelCallError('MODEL_ROUTE_REFUSED : ' + (error instanceof Error ? error.message : String(error)), null);
      }
      let ref: string;
      let model: ModelClient;
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
      } else {
        const route = participantModelRoute(env, run.participant_id);
        if (!route) {
          throw new ModelCallError('MODEL_ROUTE_NONE : aucun modèle pour ' + run.participant_id + ' (' + participantModelVar(run.participant_id)
            + ' ou AGENT_RUN_MODEL).', null);
        }
        ref = route.ref;
        model = build(ref, route.tier, participantEnvelope(env as PolicyEnv, run.participant_id));
      }
      const started = Date.now();
      try {
        const result = await model.complete(input);
        await recordModelCall(ctx.db, ref, { ok: true, at: Math.floor(now.getTime() / 1000), latencyMs: Date.now() - started });
        return result;
      } catch (error) {
        await recordModelCall(ctx.db, ref, { ok: false, at: Math.floor(now.getTime() / 1000), latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
  };
}

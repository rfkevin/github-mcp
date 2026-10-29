/**
 * CC-3 C2 — contexte d'outil du store collab. Fail-closed : sans binding
 * COLLAB_DB, aucune instance n'est créée.
 */
import { CollabStore, CollabStoreError, type StoreOptions } from '../store/collab-store';
import { collabDailyWriteLimit, type CollabStoreEnv } from '../store/config';
import { resolveTokenParticipant, type ParticipantIdentity } from '../identity';
import { parseFallbackState, storeFallback, type StoreFallback } from '../export/fallback';
import {
  parseDailyCap, parseNeuronBudget, providerAdapterFactory,
  type AdapterFactory, type ProviderAdapterEnv,
} from '../executors/run';
import type { PolicyEnv } from '../agentrun/model-policy';

export interface CollabExecutionEnv extends CollabStoreEnv, ProviderAdapterEnv {
  EXECUTOR_DAILY_CAP?: string;
  WORKERS_AI_DAILY_NEURONS?: string;
  /** CC-7 L4 : porte du salon d'équipe (« true » exact seulement). */
  SALON_ENABLED?: string;
  /** CC-7 L9a : porte des exécutions API (catalogue des modèles et choix de modèle). */
  AGENT_RUNS_ENABLED?: string;
  /** CC-7 L11 : porte des chercheurs en tournante (collab_research_assign). */
  AGENT_RUN_RESEARCH?: string;
}

/**
 * CC-7 L9a : vue du Worker utile au catalogue des modèles — variables AGENT_RUN_*, attestations
 * gratuites, origine ; chaque secret LLM_KEY_* réduit à un marqueur de présence (jamais sa valeur),
 * le binding AI à un booléen.
 */
export function modelEnvOf(env: object): PolicyEnv {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(AGENT_RUN_|GEMINI_FREE_PROJECT_ATTESTED$|GROQ_FREE_PROJECT_ATTESTED$|PUBLIC_ORIGIN$)/.test(key) && typeof value === 'string') out[key] = value;
    else if (/^LLM_KEY_[A-Z]+$/.test(key) && typeof value === 'string' && value.trim()) out[key] = 'present';
    else if (key === 'AI' && value) out[key] = true;
  }
  return out as PolicyEnv;
}

export interface CollabToolContext {
  actor: string;
  store: CollabStore;
  scopes: readonly string[];
  /** CC-3 C5 : identité dérivée du client OAuth du jeton (I8), résolue une fois par requête. */
  identity: () => Promise<ParticipantIdentity>;
  /** CC-3 C6 : repli explicite en lecture seule renvoyé avec STORE_UNAVAILABLE (R4). */
  fallback: StoreFallback;
  db: D1Database;
  executor: { factory: AdapterFactory; dailyCap: number; neuronBudget: number; now: () => Date };
  /** CC-7 L4 : variables de porte lues à la construction (salon) ; CC-7 L9a : exécutions API. */
  flags: { salonEnabled: boolean; agentRunsEnabled: boolean; researchEnabled: boolean };
  /** CC-7 L9a : vue réduite du Worker pour le catalogue des modèles (aucune valeur de secret). */
  models: PolicyEnv;
}

export function createCollabToolContext(
  env: CollabExecutionEnv,
  actor: string,
  scopes: readonly string[],
  options: StoreOptions = {},
  clientId = '',
): CollabToolContext {
  if (!env.COLLAB_DB) {
    throw new CollabStoreError('STORE_NOT_CONFIGURED', 'COLLAB_DB non lié : store collab désactivé (fail-closed).');
  }
  const now = options.now ?? (() => new Date());
  const store = new CollabStore(env.COLLAB_DB, {
    dailyWriteLimit: options.dailyWriteLimit ?? collabDailyWriteLimit(env.COLLAB_DAILY_WRITE_LIMIT),
    now,
  });
  const db = env.COLLAB_DB;
  let resolved: Promise<ParticipantIdentity> | undefined;
  return { actor, store, scopes, db, fallback: storeFallback(parseFallbackState(env.COLLAB_FALLBACK_STATE)),
    executor: {
      factory: providerAdapterFactory(env),
      dailyCap: parseDailyCap(env.EXECUTOR_DAILY_CAP),
      neuronBudget: parseNeuronBudget(env.WORKERS_AI_DAILY_NEURONS),
      now,
    },
    flags: { salonEnabled: env.SALON_ENABLED === 'true', agentRunsEnabled: env.AGENT_RUNS_ENABLED === 'true',
      researchEnabled: env.AGENT_RUN_RESEARCH === 'true' },
    models: modelEnvOf(env),
    // clientId vient du jeton validé (handler.ts) : seul chemin qui enregistre un client observé.
    identity: () => (resolved ??= resolveTokenParticipant(db, clientId)) };
}

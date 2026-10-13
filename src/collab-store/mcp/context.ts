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

export interface CollabExecutionEnv extends CollabStoreEnv, ProviderAdapterEnv {
  EXECUTOR_DAILY_CAP?: string;
  WORKERS_AI_DAILY_NEURONS?: string;
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
    // clientId vient du jeton validé (handler.ts) : seul chemin qui enregistre un client observé.
    identity: () => (resolved ??= resolveTokenParticipant(db, clientId)) };
}

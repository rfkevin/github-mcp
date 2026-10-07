/**
 * CC-3 C2 — contexte d'outil du store collab. Fail-closed : sans binding
 * COLLAB_DB, aucune instance n'est créée.
 */
import { CollabStore, CollabStoreError, type StoreOptions } from '../store/collab-store';
import { collabDailyWriteLimit, type CollabStoreEnv } from '../store/config';

export interface CollabToolContext {
  actor: string;
  store: CollabStore;
  scopes: readonly string[];
}

export function createCollabToolContext(
  env: CollabStoreEnv,
  actor: string,
  scopes: readonly string[],
  options: StoreOptions = {},
): CollabToolContext {
  if (!env.COLLAB_DB) {
    throw new CollabStoreError('STORE_NOT_CONFIGURED', 'COLLAB_DB non lié : store collab désactivé (fail-closed).');
  }
  const store = new CollabStore(env.COLLAB_DB, {
    dailyWriteLimit: options.dailyWriteLimit ?? collabDailyWriteLimit(env.COLLAB_DAILY_WRITE_LIMIT),
    now: options.now,
  });
  return { actor, store, scopes };
}

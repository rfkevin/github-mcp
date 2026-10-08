/**
 * CC-3 C2 — contexte d'outil du store collab. Fail-closed : sans binding
 * COLLAB_DB, aucune instance n'est créée.
 */
import { CollabStore, CollabStoreError, type StoreOptions } from '../store/collab-store';
import { collabDailyWriteLimit, type CollabStoreEnv } from '../store/config';
import { resolveParticipant, type ParticipantIdentity } from '../identity';

export interface CollabToolContext {
  actor: string;
  store: CollabStore;
  scopes: readonly string[];
  /** CC-3 C5 : identité dérivée du client OAuth du jeton (I8), résolue une fois par requête. */
  identity: () => Promise<ParticipantIdentity>;
}

export function createCollabToolContext(
  env: CollabStoreEnv,
  actor: string,
  scopes: readonly string[],
  options: StoreOptions = {},
  clientId = '',
): CollabToolContext {
  if (!env.COLLAB_DB) {
    throw new CollabStoreError('STORE_NOT_CONFIGURED', 'COLLAB_DB non lié : store collab désactivé (fail-closed).');
  }
  const store = new CollabStore(env.COLLAB_DB, {
    dailyWriteLimit: options.dailyWriteLimit ?? collabDailyWriteLimit(env.COLLAB_DAILY_WRITE_LIMIT),
    now: options.now,
  });
  const db = env.COLLAB_DB;
  let resolved: Promise<ParticipantIdentity> | undefined;
  return { actor, store, scopes, identity: () => (resolved ??= resolveParticipant(db, clientId)) };
}

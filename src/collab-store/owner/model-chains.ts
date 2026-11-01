/**
 * CC-8 S3 (CC-PLAN-8 §1.6, unanimité, validé par Kevin seq 1280) — chaînes de
 * modèles dans le store.
 *
 * set_agent_models est un ACTE OWNER (demande exécutable approuvée sur /owner,
 * jamais déléguable) : l'agent prépare la chaîne, Kevin l'approuve ou la
 * refuse. La chaîne remplace la liste de modèles de l'agent SANS PR
 * (résolution store d'abord, model-policy.ts) ; les variables wrangler restent
 * les DÉFAUTS et ne sont jamais réécrites, la fiche canonique reste la source
 * des DÉFINITIONS (F1, fail-on-diff : validateModelChain). Chaque acte pose une
 * version :
 * - CAS sur la version attendue (expected_version, relue sur /owner, revérifiée
 *   dans le lot par garde SQL) ;
 * - instantané immuable de chaque version (agent_model_chain_versions,
 *   append-only, jamais réécrit ni supprimé) ;
 * - rollback = restauration de la version précédente ; restaurer la version 0
 *   retire la chaîne : l'agent revient aux défauts wrangler.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureModelChainSchema, loadChainSnapshot, loadModelChain, POLICY_MAX_MODELS, validateModelChain, type ChainEntry } from '../agentrun/model-policy';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import { assertBindingPrecondition, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';

export const CHAIN_KEY_PREFIX = 'owner:model-chain:';
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const RESERVED_PARTICIPANTS = /^(owner|unregistered(:.*)?|system)$/i;

/** seq du dernier acte de chaîne d'un participant (précondition previous_seq d'une demande exécutable). */
export async function latestModelChainActSeq(db: D1Database, participantId: string): Promise<number | null> {
  await ensureModelChainSchema(db);
  const row = await db.prepare(
    "SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2",
  ).bind(REGISTRY_CYCLE, CHAIN_KEY_PREFIX + participantId + ':').first<{ seq: number | null }>();
  return row?.seq ?? null;
}

export interface ChainActResult extends OwnerWriteResult {
  participant_id: string;
  version: number;
  action: 'set' | 'rollback';
  /** Chaîne posée (null : version de retrait, défauts wrangler restaurés). */
  chain: ChainEntry[] | null;
}

/**
 * Pose (ou restaure) la chaîne de modèles d'un agent dans le store. Hors demande
 * liée, `op` nomme l'acte owner direct ; avec `binding`, c'est l'exécution d'une
 * demande approuvée (acte + décision dans le même lot CAS).
 */
export async function setAgentModels(db: D1Database, input: {
  participant_id: string;
  /** Version courante vue par le propriétaire : 0 = première chaîne, sinon la version affichée. */
  expected_version: number;
  /** Maillons {ref, status} — requis sauf rollback. */
  chain?: unknown;
  /** Restaurer la version précédente (version 0 = retour aux défauts wrangler). */
  rollback?: boolean;
  reason?: string;
  proof: OwnerProof;
  op?: string;
  binding?: OwnerRequestBinding;
  now?: () => Date;
}): Promise<ChainActResult> {
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'La chaîne de modèles d’un agent ne se règle que par le propriétaire : jamais déléguée.');
  }
  if (!PARTICIPANT_RE.test(input.participant_id) || RESERVED_PARTICIPANTS.test(input.participant_id)) {
    throw new CollabStoreError('INVALID_PARTICIPANT_ID', 'Identifiant de participant invalide ou réservé.');
  }
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
    throw new CollabStoreError('CHAIN_VERSION_INVALID', 'expected_version : entier >= 0 (version courante de la chaîne, affichée sur /owner).');
  }
  await ensureModelChainSchema(db);
  const current = await loadModelChain(db, input.participant_id);
  const currentVersion = current?.version ?? 0;
  if (input.expected_version !== currentVersion) {
    throw new CollabStoreError('CHAIN_VERSION_STALE',
      'La chaîne de ' + input.participant_id + ' est à la version ' + currentVersion + ', la demande en attendait ' + input.expected_version
      + ' : rien n’est écrit, redéposez à jour.');
  }
  const action: 'set' | 'rollback' = input.rollback === true ? 'rollback' : 'set';
  let chain: ChainEntry[] | null;
  let restoredVersion: number | null = null;
  if (action === 'rollback') {
    if (currentVersion === 0) {
      throw new CollabStoreError('CHAIN_NOTHING_TO_RESTORE', 'Aucune chaîne à restaurer pour ' + input.participant_id + '.');
    }
    restoredVersion = currentVersion - 1;
    chain = restoredVersion === 0 ? null : await loadChainSnapshot(db, input.participant_id, restoredVersion);
    if (restoredVersion !== 0 && !chain) {
      throw new CollabStoreError('CHAIN_SNAPSHOT_MISSING', 'Instantané v' + restoredVersion + ' de ' + input.participant_id + ' introuvable : restauration refusée.');
    }
  } else {
    if (input.chain === undefined || input.chain === null) {
      throw new CollabStoreError('CHAIN_INVALID', 'chain requis (1 à ' + POLICY_MAX_MODELS + ' maillons {ref, status}), ou rollback = true.');
    }
    chain = validateModelChain(input.participant_id, input.chain).entries;
  }
  if (input.binding) assertBindingPrecondition(input.binding, await latestModelChainActSeq(db, input.participant_id));
  if (!input.binding && !input.op) throw new CollabStoreError('INVALID_OWNER_OP', 'op requis hors demande liée.');
  const newVersion = currentVersion + 1;
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const reason = (input.reason ?? '').slice(0, 500);
  const chainJson = JSON.stringify(chain);
  const prefix = CHAIN_KEY_PREFIX + input.participant_id;
  const key = input.binding ? bindingKey(prefix, input.binding) : prefix + ':' + input.op;
  try {
    const result = await ownerAppend(db, {
      cycleId: REGISTRY_CYCLE,
      key,
      payload: {
        action: 'set_agent_models', participant_id: input.participant_id, version: newVersion, expected_version: input.expected_version,
        ...(action === 'rollback' ? { rollback: true, restored_version: restoredVersion } : { chain: chain ?? [] }),
        reason, ...(input.binding ? bindingPayload(input.binding) : {}),
      },
      proof: input.proof,
      // CAS : la version ne doit pas avoir bougé entre la lecture et le lot (course fermée en SQL).
      extraGuard: {
        sql: 'COALESCE((SELECT version FROM agent_model_chains WHERE participant_id = ?4), 0) = ?5',
        binds: [input.participant_id, currentVersion],
      },
      sideEffects: eventKey => [
        ...(input.binding ? bindingStatements(db, input.binding, input.proof, eventKey, input.now) : []),
        ...(chain === null
          ? [db.prepare('DELETE FROM agent_model_chains WHERE participant_id = ?1').bind(input.participant_id)]
          : [db.prepare([
              'INSERT INTO agent_model_chains (participant_id, version, chain_json, updated_at, event_seq)',
              'VALUES (?1, ?2, ?3, ?4, (SELECT seq FROM events WHERE idempotency_key = ?5))',
              'ON CONFLICT(participant_id) DO UPDATE SET version = excluded.version, chain_json = excluded.chain_json,',
              '  updated_at = excluded.updated_at, event_seq = excluded.event_seq',
            ].join(' ')).bind(input.participant_id, newVersion, chainJson, at, eventKey)]),
        db.prepare([
          'INSERT INTO agent_model_chain_versions (participant_id, version, chain_json, set_by, action, reason, event_seq, at)',
          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT seq FROM events WHERE idempotency_key = ?7), ?8)',
        ].join(' ')).bind(input.participant_id, newVersion, chainJson, input.proof.kind + ':' + input.proof.subject, action, reason, eventKey, at),
      ],
      now: input.now,
    });
    return { ...result, participant_id: input.participant_id, version: newVersion, action, chain };
  } catch (error) {
    if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
      const nowVersion = (await loadModelChain(db, input.participant_id))?.version ?? 0;
      if (nowVersion !== currentVersion) {
        throw new CollabStoreError('CHAIN_VERSION_STALE',
          'La chaîne de ' + input.participant_id + ' a changé entre-temps (version ' + nowVersion + ') : rien n’est écrit, redéposez à jour.');
      }
    }
    throw error;
  }
}

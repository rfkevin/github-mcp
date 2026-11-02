/**
 * CC-8 S8a (CC-PLAN-8, consultation S8a — AGREE seq 1402/1403, AMEND seq 1404,
 * GO de Kevin) — pause serveur RÉVERSIBLE d'un participant (canal API).
 *
 * Constat (2026-11-02, cc8-systeme-unique) : la pause mémoire (C4) ne couvre pas
 * les réveils du planificateur ; un agent que Kevin veut mettre de côté reçoit
 * pourtant des exécutions au passage suivant. `set_agent_run_status` est un
 * ACTE OWNER (demande exécutable approuvée sur /owner, jamais déléguable) :
 * - params exacts {participant_id, status : paused|resumed, expected_version} ;
 * - CAS sur la version attendue (lue, puis revérifiée dans le lot par garde SQL) ;
 * - précondition previous_seq du dernier acte de statut du participant ;
 * - fail-closed : sans ligne dans agent_run_status, le participant est ACTIF —
 *   une lecture défaillante ne met jamais un agent en pause ;
 * - réversibilité : l'acte opposé (paused → resumed) rend le service, le
 *   compteur de version reste monotone ;
 * - l'audit = les événements owner.decision du registre (aucun instantané).
 *
 * La garde de lecture (`agentRunPaused`) est consommée par runCapacity
 * (agentrun/capacity.ts) AVANT toute politique, route ou sonde : un participant
 * en pause ne reçoit AUCUN réveil et aucune exécution n'est créée pour lui.
 */
import { CollabStoreError } from '../store/collab-store';
import { ownerAppend, REGISTRY_CYCLE, type OwnerWriteResult } from './decisions';
import { assertBindingPrecondition, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';

/** Statuts du canal API d'un participant ; l'acte opposé inverse le précédent. */
export const RUN_STATUSES = ['paused', 'resumed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_KEY_PREFIX = 'owner:agent-run-status:';
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const RESERVED_PARTICIPANTS = /^(owner|unregistered(:.*)?|system)$/i;
const ensuredSchemas = new WeakSet<D1Database>();

/** Crée la table si besoin (idempotent, D1 sans migration — même pratique que le reste du store). */
async function ensureRunStatusSchema(db: D1Database): Promise<void> {
  if (ensuredSchemas.has(db)) return;
  await db.batch([db.prepare([
    'CREATE TABLE IF NOT EXISTS agent_run_status (',
    '  participant_id TEXT PRIMARY KEY,',
    '  version INTEGER NOT NULL,',
    "  status TEXT NOT NULL CHECK (status IN ('paused','resumed')),",
    "  reason TEXT NOT NULL DEFAULT '',",
    '  updated_at INTEGER NOT NULL,',
    '  event_seq INTEGER NOT NULL',
    ')',
  ].join(' '))]);
  ensuredSchemas.add(db);
}

/** Ligne de statut courante d'un participant (null : aucune ligne, participant actif). */
export async function loadAgentRunStatus(db: D1Database, participantId: string): Promise<{ version: number; status: RunStatus } | null> {
  await ensureRunStatusSchema(db);
  const row = await db.prepare('SELECT version, status FROM agent_run_status WHERE participant_id = ?1')
    .bind(participantId).first<{ version: number; status: RunStatus }>();
  return row ?? null;
}

/**
 * Le participant est-il en pause serveur ? Fail-closed : sans ligne, ou sur une
 * lecture défaillante, JAMAIS en pause — la pause est un acte owner explicite,
 * rien d'implicite. Lecture seule, un point d'accès par runCapacity.
 */
export async function agentRunPaused(db: D1Database, participantId: string): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT status FROM agent_run_status WHERE participant_id = ?1')
      .bind(participantId).first<{ status: string }>();
    return row?.status === 'paused';
  } catch {
    return false;
  }
}

/** seq du dernier acte de statut d'un participant (précondition previous_seq d'une demande exécutable). */
export async function latestRunStatusActSeq(db: D1Database, participantId: string): Promise<number | null> {
  const row = await db.prepare(
    "SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2",
  ).bind(REGISTRY_CYCLE, RUN_STATUS_KEY_PREFIX + participantId + ':').first<{ seq: number | null }>();
  return row?.seq ?? null;
}

export interface RunStatusActResult extends OwnerWriteResult {
  participant_id: string;
  run_status: RunStatus;
  version: number;
}

/**
 * Pose (ou lève) la pause serveur d'un participant dans le store. Hors demande
 * liée, `op` nomme l'acte owner direct ; avec `binding`, c'est l'exécution d'une
 * demande approuvée (acte + décision dans le même lot CAS).
 */
export async function setAgentRunStatus(db: D1Database, input: {
  participant_id: string;
  status: RunStatus;
  expected_version: number;
  reason?: string;
  proof: OwnerProof;
  op?: string;
  binding?: OwnerRequestBinding;
  now?: () => Date;
}): Promise<RunStatusActResult> {
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'La pause serveur d’un agent ne se règle que par le propriétaire : jamais déléguée.');
  }
  if (!PARTICIPANT_RE.test(input.participant_id) || RESERVED_PARTICIPANTS.test(input.participant_id)) {
    throw new CollabStoreError('INVALID_PARTICIPANT_ID', 'Identifiant de participant invalide ou réservé.');
  }
  if (!RUN_STATUSES.includes(input.status)) {
    throw new CollabStoreError('RUN_STATUS_INVALID', 'status : paused ou resumed.');
  }
  if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 0) {
    throw new CollabStoreError('RUN_STATUS_VERSION_INVALID', 'expected_version : entier >= 0 (version courante du statut de réveil du participant).');
  }
  await ensureRunStatusSchema(db);
  const current = await loadAgentRunStatus(db, input.participant_id);
  const currentVersion = current?.version ?? 0;
  if (input.expected_version !== currentVersion) {
    throw new CollabStoreError('RUN_STATUS_VERSION_STALE',
      'Le statut de ' + input.participant_id + ' est à la version ' + currentVersion + ', la demande en attendait ' + input.expected_version
      + ' : rien n’est écrit, redéposez à jour.');
  }
  if (input.binding) assertBindingPrecondition(input.binding, await latestRunStatusActSeq(db, input.participant_id));
  if (!input.binding && !input.op) throw new CollabStoreError('INVALID_OWNER_OP', 'op requis hors demande liée.');
  const newVersion = currentVersion + 1;
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const reason = (input.reason ?? '').slice(0, 500);
  const prefix = RUN_STATUS_KEY_PREFIX + input.participant_id;
  const key = input.binding ? bindingKey(prefix, input.binding) : prefix + ':' + input.op;
  try {
    const result = await ownerAppend(db, {
      cycleId: REGISTRY_CYCLE,
      key,
      payload: {
        action: 'set_agent_run_status', participant_id: input.participant_id, status: input.status, version: newVersion,
        expected_version: input.expected_version, reason, ...(input.binding ? bindingPayload(input.binding) : {}),
      },
      proof: input.proof,
      // CAS : la version ne doit pas avoir bougé entre la lecture et le lot (course fermée en SQL).
      extraGuard: {
        sql: 'COALESCE((SELECT version FROM agent_run_status WHERE participant_id = ?4), 0) = ?5',
        binds: [input.participant_id, currentVersion],
      },
      sideEffects: eventKey => [
        ...(input.binding ? bindingStatements(db, input.binding, input.proof, eventKey, input.now) : []),
        // Upsert idempotent : la ligne unique du participant suit le dernier acte appliqué.
        db.prepare([
          'INSERT INTO agent_run_status (participant_id, version, status, reason, updated_at, event_seq)',
          'VALUES (?1, ?2, ?3, ?4, ?5, (SELECT seq FROM events WHERE idempotency_key = ?6))',
          'ON CONFLICT(participant_id) DO UPDATE SET version = excluded.version, status = excluded.status,',
          '  reason = excluded.reason, updated_at = excluded.updated_at, event_seq = excluded.event_seq',
        ].join(' ')).bind(input.participant_id, newVersion, input.status, reason, at, eventKey),
      ],
      now: input.now,
    });
    return { ...result, participant_id: input.participant_id, run_status: input.status, version: newVersion };
  } catch (error) {
    if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
      const nowVersion = (await loadAgentRunStatus(db, input.participant_id))?.version ?? 0;
      if (nowVersion !== currentVersion) {
        throw new CollabStoreError('RUN_STATUS_VERSION_STALE',
          'Le statut de ' + input.participant_id + ' a changé entre-temps (version ' + nowVersion + ') : rien n’est écrit, redéposez à jour.');
      }
    }
    throw error;
  }
}

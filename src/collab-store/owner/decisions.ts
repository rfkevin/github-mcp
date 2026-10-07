/**
 * CC-3 C5 — owner decisions and participant registry (I7, I8).
 *
 * This module is the ONLY writer of `owner.decision` events, of the
 * `owner_decisions` table and of the participant registry. It is reachable
 * from the /owner route only, after verifyOwnerProof. Every write is an
 * append to the event log under the same CAS rule as the store (guard row,
 * expected revision, unique idempotency key, one D1 batch), so decisions and
 * registry changes are auditable and replayable.
 *
 * Owner writes do not consume the agents' daily quota: the owner must always
 * be able to act, including when agents exhausted it.
 */
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import type { OwnerProof } from './proof';

export const OWNER_PARTICIPANT = 'owner';
export const REGISTRY_CYCLE = 'owner-registry';
export const REQUEST_TYPES = ['owner.request', 'phase.request'] as const;
export const DECISIONS = ['approve', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

const REQUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const RESERVED_PARTICIPANTS = /^(owner|unregistered(:.*)?|system)$/i;
const MAX_ATTEMPTS = 3;

export interface PendingRequest {
  request_id: string;
  cycle_id: string;
  type: string;
  participant_id: string;
  summary: string;
  seq: number;
  at: number;
}

export interface OwnerWriteResult {
  status: 'applied' | 'duplicate';
  event: StoredStoreEvent;
}

function requestIdOf(payloadJson: string): { request_id: string; summary: string } | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
    if (!REQUEST_ID_RE.test(requestId)) return null;
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 600) : '';
    return { request_id: requestId, summary };
  } catch {
    return null;
  }
}

/** Requests filed by agents (owner.request / phase.request) without a recorded decision. */
export async function listPendingRequests(db: D1Database, limit = 100): Promise<PendingRequest[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT seq, cycle_id, at, type, participant_id, payload_json FROM events',
    "WHERE type IN ('owner.request', 'phase.request') ORDER BY seq DESC LIMIT ?1",
  ].join(' ')).bind(Math.min(Math.max(limit, 1), 500)).all<StoredStoreEvent>();
  const decided = new Set((await db.prepare('SELECT request_id FROM owner_decisions')
    .all<{ request_id: string }>()).results.map(row => row.request_id));
  const pending: PendingRequest[] = [];
  const seen = new Set<string>();
  for (const row of results) {
    const parsed = requestIdOf(row.payload_json);
    if (!parsed || decided.has(parsed.request_id) || seen.has(parsed.request_id)) continue;
    seen.add(parsed.request_id);
    pending.push({ ...parsed, cycle_id: row.cycle_id, type: row.type, participant_id: row.participant_id, seq: row.seq, at: row.at });
  }
  return pending;
}

async function eventByKey(db: D1Database, key: string): Promise<StoredStoreEvent | null> {
  return db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<StoredStoreEvent>();
}

/**
 * Append one owner.decision event plus its side statements in a single CAS
 * batch. `extraGuard` is an SQL boolean expression evaluated inside the guard.
 */
async function ownerAppend(db: D1Database, input: {
  cycleId: string;
  key: string;
  payload: Record<string, unknown>;
  proof: OwnerProof;
  extraGuard?: { sql: string; binds: unknown[] };
  sideEffects: (keyBind: string) => D1PreparedStatement[];
  now?: () => Date;
}): Promise<OwnerWriteResult> {
  await ensureSchema(db);
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const payloadJson = JSON.stringify({ ...input.payload, proof_kind: input.proof.kind });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const existing = await eventByKey(db, input.key);
    if (existing) return { status: 'duplicate', event: existing };
    const revision = (await db.prepare(
      'SELECT COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?1), 0) AS revision'
    ).bind(input.cycleId).first<{ revision: number }>())?.revision ?? 0;
    const extra = input.extraGuard ? ' AND (' + input.extraGuard.sql + ')' : '';
    const guardBinds = [input.key, input.cycleId, revision, ...(input.extraGuard?.binds ?? [])];
    try {
      await db.batch([
        db.prepare([
          'INSERT INTO collab_store_guard (ok)',
          'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?1)',
          '             AND COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?2), 0) = ?3' + extra,
          '       THEN 1 ELSE 0 END',
        ].join(' ')).bind(...guardBinds),
        db.prepare('INSERT INTO cycles (cycle_id) VALUES (?1) ON CONFLICT(cycle_id) DO NOTHING').bind(input.cycleId),
        db.prepare([
          'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json,',
          '                   expected_rev, idempotency_key, evidence_ref)',
          "VALUES (?1, ?2, 'owner.decision', ?3, '', 'owner', ?4, ?5, ?6, ?7)",
        ].join(' ')).bind(input.cycleId, at, OWNER_PARTICIPANT, payloadJson, revision, input.key, 'owner-proof:' + input.proof.kind),
        db.prepare('UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3')
          .bind(input.cycleId, revision + 1, revision),
        ...input.sideEffects(input.key),
        db.prepare('DELETE FROM collab_store_guard'),
      ]);
      const stored = await eventByKey(db, input.key);
      return { status: 'applied', event: stored! };
    } catch (error) {
      const winner = await eventByKey(db, input.key);
      if (winner) return { status: 'duplicate', event: winner };
      const current = (await db.prepare(
        'SELECT COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?1), 0) AS revision'
      ).bind(input.cycleId).first<{ revision: number }>())?.revision ?? 0;
      if (current !== revision) continue; // concurrent agent append: retry at the new revision
      if (input.extraGuard) throw new CollabStoreError('OWNER_PRECONDITION_FAILED', 'Condition de la décision non remplie.');
      throw error;
    }
  }
  throw new CollabStoreError('STALE', 'Le cycle change trop vite ; réessayez la décision.');
}

/** Approve or deny a pending owner.request / phase.request. One decision per request. */
export async function recordOwnerDecision(db: D1Database, input: {
  request_id: string;
  decision: string;
  proof: OwnerProof;
  now?: () => Date;
}): Promise<OwnerWriteResult & { decision: Decision }> {
  if (!REQUEST_ID_RE.test(input.request_id)) throw new CollabStoreError('INVALID_REQUEST_ID', 'Identifiant de demande invalide.');
  if (!DECISIONS.includes(input.decision as Decision)) throw new CollabStoreError('INVALID_DECISION', 'Décision : approve ou deny.');
  const decision = input.decision as Decision;
  const request = (await listPendingRequests(db, 500)).find(item => item.request_id === input.request_id);
  if (!request) {
    const prior = await db.prepare('SELECT decision FROM owner_decisions WHERE request_id = ?1')
      .bind(input.request_id).first<{ decision: string }>();
    if (prior) throw new CollabStoreError('ALREADY_DECIDED', 'Demande déjà tranchée : ' + prior.decision + '.');
    throw new CollabStoreError('UNKNOWN_REQUEST', 'Aucune demande en attente avec cet identifiant.');
  }
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  const result = await ownerAppend(db, {
    cycleId: request.cycle_id,
    key: 'owner-decision:' + input.request_id,
    payload: { action: 'decide', request_id: input.request_id, decision, request_seq: request.seq },
    proof: input.proof,
    extraGuard: { sql: 'NOT EXISTS (SELECT 1 FROM owner_decisions WHERE request_id = ?4)', binds: [input.request_id] },
    sideEffects: key => [db.prepare([
      'INSERT INTO owner_decisions (request_id, decision, access_subject, at, event_seq)',
      'VALUES (?1, ?2, ?3, ?4, (SELECT seq FROM events WHERE idempotency_key = ?5))',
    ].join(' ')).bind(input.request_id, decision, input.proof.kind + ':' + input.proof.subject, at, key)],
    now: input.now,
  });
  if (result.status === 'duplicate') {
    const prior = await db.prepare('SELECT decision FROM owner_decisions WHERE request_id = ?1')
      .bind(input.request_id).first<{ decision: string }>();
    return { ...result, decision: (prior?.decision as Decision) ?? decision };
  }
  return { ...result, decision };
}

function assertParticipantId(participantId: string): void {
  if (!PARTICIPANT_RE.test(participantId) || RESERVED_PARTICIPANTS.test(participantId)) {
    throw new CollabStoreError('INVALID_PARTICIPANT_ID', 'Identifiant de participant invalide ou réservé.');
  }
}

/** Register (or reactivate and relabel) a participant. The label is display-only (I8). */
export async function registerParticipant(db: D1Database, input: {
  participant_id: string; display_label: string; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult> {
  assertParticipantId(input.participant_id);
  const label = input.display_label.trim().slice(0, 80);
  if (!label) throw new CollabStoreError('INVALID_LABEL', 'Libellé requis (affichage seulement).');
  return ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: 'owner-registry:register:' + input.op,
    payload: { action: 'register_participant', participant_id: input.participant_id, display_label: label },
    proof: input.proof,
    sideEffects: () => [db.prepare([
      "INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?2, 'active')",
      "ON CONFLICT(participant_id) DO UPDATE SET display_label = excluded.display_label, status = 'active'",
    ].join(' ')).bind(input.participant_id, label)],
    now: input.now,
  });
}

/** Map an OAuth client id to a registered participant (one participant per client). */
export async function mapClient(db: D1Database, input: {
  oauth_client_id: string; participant_id: string; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult> {
  assertParticipantId(input.participant_id);
  const clientId = input.oauth_client_id.trim();
  if (!clientId || clientId.length > 512) throw new CollabStoreError('INVALID_CLIENT_ID', 'Identifiant de client OAuth invalide.');
  return ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: 'owner-registry:map:' + input.op,
    payload: { action: 'map_client', oauth_client_id: clientId, participant_id: input.participant_id },
    proof: input.proof,
    extraGuard: {
      sql: "EXISTS (SELECT 1 FROM participants WHERE participant_id = ?4 AND status = 'active')",
      binds: [input.participant_id],
    },
    sideEffects: key => [db.prepare([
      'INSERT INTO participant_clients (oauth_client_id, participant_id, approved_event_seq)',
      'VALUES (?1, ?2, (SELECT seq FROM events WHERE idempotency_key = ?3))',
      'ON CONFLICT(oauth_client_id) DO UPDATE SET participant_id = excluded.participant_id,',
      '  approved_event_seq = excluded.approved_event_seq',
    ].join(' ')).bind(clientId, input.participant_id, key)],
    now: input.now,
  });
}

/** Remove a client mapping: the client falls back to unregistered on its next call. */
export async function unmapClient(db: D1Database, input: {
  oauth_client_id: string; proof: OwnerProof; op: string; now?: () => Date;
}): Promise<OwnerWriteResult> {
  const clientId = input.oauth_client_id.trim();
  if (!clientId || clientId.length > 512) throw new CollabStoreError('INVALID_CLIENT_ID', 'Identifiant de client OAuth invalide.');
  return ownerAppend(db, {
    cycleId: REGISTRY_CYCLE,
    key: 'owner-registry:unmap:' + input.op,
    payload: { action: 'unmap_client', oauth_client_id: clientId },
    proof: input.proof,
    sideEffects: () => [db.prepare('DELETE FROM participant_clients WHERE oauth_client_id = ?1').bind(clientId)],
    now: input.now,
  });
}

export async function listRegistry(db: D1Database): Promise<{
  participants: Array<{ participant_id: string; display_label: string; status: string }>;
  clients: Array<{ oauth_client_id: string; participant_id: string; approved_event_seq: number | null }>;
}> {
  await ensureSchema(db);
  const participants = (await db.prepare('SELECT participant_id, display_label, status FROM participants ORDER BY participant_id')
    .all<{ participant_id: string; display_label: string; status: string }>()).results;
  const clients = (await db.prepare('SELECT oauth_client_id, participant_id, approved_event_seq FROM participant_clients ORDER BY participant_id')
    .all<{ oauth_client_id: string; participant_id: string; approved_event_seq: number | null }>()).results;
  return { participants, clients };
}

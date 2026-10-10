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
import { currentPauseOf, isPauseRequestId, resumeGuard, resumeStatements, type PauseOccurrence } from '../memory/pause-resume';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';

export const OWNER_PARTICIPANT = 'owner';
export const REGISTRY_CYCLE = 'owner-registry';
export const REQUEST_TYPES = ['owner.request', 'phase.request'] as const;
export const DECISIONS = ['approve', 'deny'] as const;
export type Decision = (typeof DECISIONS)[number];

const REQUEST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const RESERVED_PARTICIPANTS = /^(owner|unregistered(:.*)?|system)$/i;
const MAX_ATTEMPTS = 3;

/**
 * A request event without a decision bound to its own seq (F2/A02, A06).
 * The immutable identity of a request is its event `seq`; `request_id` is
 * the agent-chosen name consumers (C4) bind to. `state`:
 * - `pending`: decidable;
 * - `blocked`: another event with the same request_id was already decided
 *   (`decided_seq`) — one decision per request_id, so this one can never be
 *   decided; the agent must file again under a new request_id;
 * - `invalid`: the payload has no valid request_id — never decidable.
 * Blocked and invalid requests are listed, never hidden.
 */
export interface PendingRequest {
  request_id: string;
  cycle_id: string;
  type: string;
  participant_id: string;
  summary: string;
  seq: number;
  at: number;
  state: 'pending' | 'blocked' | 'invalid';
  decided_seq?: number | null;
}

export interface PendingPage {
  items: PendingRequest[];
  /** Request events still awaiting a decision of their own (all states), across all pages. */
  total: number;
  /** Pass as `before` to read the next (older) page; null when this is the last page. */
  next_before: number | null;
}

export interface OwnerWriteResult {
  status: 'applied' | 'duplicate';
  event: StoredStoreEvent;
}

function requestIdOf(payloadJson: string): { request_id: string; summary: string; valid: boolean } {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : '';
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 600) : '';
    return { request_id: requestId.slice(0, 80), summary, valid: REQUEST_ID_RE.test(requestId) };
  } catch {
    return { request_id: '', summary: '', valid: false };
  }
}

/** request_id of a request event, read in SQL (invalid JSON never raises). */
const SQL_REQUEST_ID = "json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END, '$.request_id')";
/**
 * Request events with no decision bound to their own seq. Filtering happens
 * in SQL, before any LIMIT, so a page never hides older undecided requests
 * behind newer decided ones (A06). The decision of a request_id is bound to a
 * request seq through its owner.decision event (payload.request_seq).
 */
const UNDECIDED_FROM = [
  'FROM events e',
  'LEFT JOIN owner_decisions d ON d.request_id = ' + SQL_REQUEST_ID,
  'LEFT JOIN events de ON de.seq = d.event_seq',
  "WHERE e.type IN ('owner.request', 'phase.request')",
  "  AND (d.request_id IS NULL OR json_extract(de.payload_json, '$.request_seq') IS NOT e.seq)",
].join(' ');
const MAX_PAGE = 500;

/** One page of request events awaiting a decision, newest first, with a cursor to older pages. */
export async function listPendingPage(db: D1Database, options: { limit?: number; before?: number } = {}): Promise<PendingPage> {
  await ensureSchema(db);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), MAX_PAGE);
  const before = Number.isSafeInteger(options.before) && (options.before as number) > 0 ? options.before as number : Number.MAX_SAFE_INTEGER;
  const { results } = await db.prepare([
    'SELECT e.seq, e.cycle_id, e.at, e.type, e.participant_id, e.payload_json,',
    "  d.request_id AS decided_id, json_extract(de.payload_json, '$.request_seq') AS decided_seq",
    UNDECIDED_FROM, 'AND e.seq < ?1 ORDER BY e.seq DESC LIMIT ?2',
  ].join(' ')).bind(before, limit + 1)
    .all<StoredStoreEvent & { decided_id: string | null; decided_seq: number | null }>();
  const total = (await db.prepare('SELECT COUNT(*) AS n ' + UNDECIDED_FROM).first<{ n: number }>())?.n ?? 0;
  const items = results.slice(0, limit).map((row): PendingRequest => {
    const parsed = requestIdOf(row.payload_json);
    const state = !parsed.valid ? 'invalid' : row.decided_id !== null ? 'blocked' : 'pending';
    return {
      request_id: parsed.request_id, summary: parsed.summary, cycle_id: row.cycle_id, type: row.type,
      participant_id: row.participant_id, seq: row.seq, at: row.at, state,
      ...(state === 'blocked' ? { decided_seq: row.decided_seq ?? null } : {}),
    };
  });
  return { items, total, next_before: results.length > limit ? items[items.length - 1].seq : null };
}

/** Requests awaiting a decision (first page, newest first). See listPendingPage for paging. */
export async function listPendingRequests(db: D1Database, limit = 100): Promise<PendingRequest[]> {
  return (await listPendingPage(db, { limit })).items;
}

/** The request event of `seq`, if it is a request type. */
async function requestEvent(db: D1Database, seq: number): Promise<StoredStoreEvent | null> {
  return db.prepare("SELECT * FROM events WHERE seq = ?1 AND type IN ('owner.request', 'phase.request')")
    .bind(seq).first<StoredStoreEvent>();
}

/** The request seq a recorded decision of `requestId` is bound to (null: decided without a bound event). */
async function decidedSeqOf(db: D1Database, requestId: string): Promise<{ decision: string; request_seq: number | null } | null> {
  const row = await db.prepare([
    "SELECT d.decision, json_extract(de.payload_json, '$.request_seq') AS request_seq",
    'FROM owner_decisions d LEFT JOIN events de ON de.seq = d.event_seq WHERE d.request_id = ?1',
  ].join(' ')).bind(requestId).first<{ decision: string; request_seq: number | null }>();
  return row ?? null;
}

/**
 * Resolve the exact request a decision targets (A02).
 * - With `request_seq` (the /owner form): that event, which must still carry
 *   the displayed request_id (and cycle when given), else REQUEST_MISMATCH.
 * - Without (programmatic callers): the single undecided request event with
 *   this request_id across the whole log (no recent window, A06); several →
 *   AMBIGUOUS_REQUEST, the caller must name the seq.
 */
async function resolveRequestTarget(db: D1Database, input: { request_id: string; request_seq?: number; cycle_id?: string }): Promise<StoredStoreEvent> {
  if (input.request_seq !== undefined) {
    if (!Number.isSafeInteger(input.request_seq) || input.request_seq <= 0) {
      throw new CollabStoreError('INVALID_REQUEST_ID', 'Numéro de demande (seq) invalide.');
    }
    const event = await requestEvent(db, input.request_seq);
    if (!event) throw new CollabStoreError('UNKNOWN_REQUEST', 'Aucune demande avec ce numéro (seq ' + input.request_seq + ').');
    const parsed = requestIdOf(event.payload_json);
    if (!parsed.valid || parsed.request_id !== input.request_id || (input.cycle_id && input.cycle_id !== event.cycle_id)) {
      throw new CollabStoreError('REQUEST_MISMATCH',
        'La demande seq ' + input.request_seq + ' ne correspond pas à celle affichée ; rien n’est décidé. Relisez /owner.');
    }
    return event;
  }
  const { results } = await db.prepare([
    'SELECT e.* ' + UNDECIDED_FROM, 'AND ' + SQL_REQUEST_ID + ' = ?1 ORDER BY e.seq LIMIT 2',
  ].join(' ')).bind(input.request_id).all<StoredStoreEvent>();
  if (results.length > 1) {
    throw new CollabStoreError('AMBIGUOUS_REQUEST',
      'Plusieurs demandes portent cet identifiant (seq ' + results.map(row => row.seq).join(', ') + ') : précisez request_seq.');
  }
  if (results.length === 0) {
    const prior = await decidedSeqOf(db, input.request_id);
    if (prior) throw new CollabStoreError('ALREADY_DECIDED', 'Demande déjà tranchée : ' + prior.decision + '.');
    throw new CollabStoreError('UNKNOWN_REQUEST', 'Aucune demande en attente avec cet identifiant.');
  }
  return results[0];
}

async function eventByKey(db: D1Database, key: string): Promise<StoredStoreEvent | null> {
  return db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<StoredStoreEvent>();
}

/**
 * Append one owner.decision event plus its side statements in a single CAS
 * batch. `extraGuard` is an SQL boolean expression evaluated inside the guard.
 * Exported for the other owner-only writers of this directory (C6 state import).
 */
export async function ownerAppend(db: D1Database, input: {
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
        // CR-F04 (#96) : une décision owner avance la révision, donc les échéances du cycle.
        expireDueHypotheses(db, input.cycleId),
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

/**
 * Approve or deny one owner.request / phase.request. One decision per
 * request_id, bound to the exact request event (`request_seq`) the owner saw
 * (A02): a homonym filed later, in any cycle, never receives it. Replaying the
 * same form (same seq) is idempotent; a decision already bound to another seq
 * of this request_id is refused with ALREADY_DECIDED.
 *
 * CR-F02 (#93) : approuver une demande de reprise de pause mémoire
 * (`mem-pause-…`) lève exactement cette pause DANS la transaction de la
 * décision. L'identifiant doit désigner la pause courante d'un scope
 * (recalculé côté serveur, jamais lu dans la demande) ; sinon
 * MEMORY_PAUSE_NOT_CURRENT, rien n'est écrit. Un refus reste toujours possible
 * et maintient la pause.
 */
export async function recordOwnerDecision(db: D1Database, input: {
  request_id: string;
  decision: string;
  proof: OwnerProof;
  /** Immutable target shown on /owner. Optional for programmatic callers (see resolveRequestTarget). */
  request_seq?: number;
  cycle_id?: string;
  now?: () => Date;
}): Promise<OwnerWriteResult & { decision: Decision; memory_resume?: PauseOccurrence }> {
  if (!REQUEST_ID_RE.test(input.request_id)) throw new CollabStoreError('INVALID_REQUEST_ID', 'Identifiant de demande invalide.');
  if (!DECISIONS.includes(input.decision as Decision)) throw new CollabStoreError('INVALID_DECISION', 'Décision : approve ou deny.');
  const decision = input.decision as Decision;
  await ensureSchema(db);
  const request = await resolveRequestTarget(db, input);
  const prior = await decidedSeqOf(db, input.request_id);
  if (prior && prior.request_seq !== request.seq) {
    throw new CollabStoreError('ALREADY_DECIDED', 'Identifiant déjà tranché (' + prior.decision + ') pour une autre demande'
      + (prior.request_seq ? ' (seq ' + prior.request_seq + ')' : '') + ' : rien n’est décidé pour la seq ' + request.seq + '.');
  }
  // CR-F02 : la pause courante que cette approbation lève (null : pas une demande de pause).
  // Un rejeu de la même décision (prior lié à cette seq) reste idempotent sans re-vérifier.
  const resume = decision === 'approve' && !prior ? await pauseToResume(db, input.request_id) : null;
  const decisionGuard = { sql: 'NOT EXISTS (SELECT 1 FROM owner_decisions WHERE request_id = ?4)', binds: [input.request_id] as unknown[] };
  const pauseGuard = resume ? resumeGuard(resume, 5) : null;
  const at = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
  let result: OwnerWriteResult;
  try {
    result = await ownerAppend(db, {
      cycleId: request.cycle_id,
      key: 'owner-decision:' + input.request_id,
      payload: { action: 'decide', request_id: input.request_id, decision, request_seq: request.seq,
        ...(resume ? { memory_resume: resume } : {}) },
      proof: input.proof,
      extraGuard: pauseGuard
        ? { sql: decisionGuard.sql + ' AND ' + pauseGuard.sql, binds: [...decisionGuard.binds, ...pauseGuard.binds] }
        : decisionGuard,
      sideEffects: key => [db.prepare([
        'INSERT INTO owner_decisions (request_id, decision, access_subject, at, event_seq)',
        'VALUES (?1, ?2, ?3, ?4, (SELECT seq FROM events WHERE idempotency_key = ?5))',
      ].join(' ')).bind(input.request_id, decision, input.proof.kind + ':' + input.proof.subject, at, key),
      ...(resume ? resumeStatements(db, resume) : [])],
      now: input.now,
    });
  } catch (error) {
    // La pause a changé entre la lecture et la transaction (nouvelle occurrence,
    // reprise concurrente) : la garde a tout annulé ; diagnostic typé.
    if (resume && error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
      await pauseToResume(db, input.request_id);
    }
    throw error;
  }
  if (result.status === 'duplicate') {
    // The stored decision must be bound to this very request; otherwise a
    // concurrent decision of a homonym won and this one is refused.
    const boundSeq = (JSON.parse(result.event.payload_json) as { request_seq?: unknown }).request_seq;
    if (boundSeq !== request.seq) {
      throw new CollabStoreError('ALREADY_DECIDED', 'Identifiant tranché entre-temps pour une autre demande'
        + (typeof boundSeq === 'number' ? ' (seq ' + boundSeq + ')' : '') + ' : rien n’est décidé pour la seq ' + request.seq + '.');
    }
    const stored = await decidedSeqOf(db, input.request_id);
    return { ...result, decision: (stored?.decision as Decision) ?? decision };
  }
  return { ...result, decision, ...(resume ? { memory_resume: resume } : {}) };
}

/**
 * CR-F02 : la pause courante désignée par une demande de reprise approuvée, ou
 * null pour toute autre demande. Une demande `mem-pause-…` qui ne désigne
 * aucune pause courante (autre scope, occurrence ancienne ou future, pause
 * déjà levée) est refusée : MEMORY_PAUSE_NOT_CURRENT, rien n'est écrit.
 */
async function pauseToResume(db: D1Database, requestId: string): Promise<PauseOccurrence | null> {
  if (!isPauseRequestId(requestId)) return null;
  const pause = await currentPauseOf(db, requestId);
  if (!pause) {
    throw new CollabStoreError('MEMORY_PAUSE_NOT_CURRENT',
      'Cette demande ne correspond à aucune pause mémoire en cours (autre scope, occurrence ancienne ou pause déjà levée) : '
      + 'rien n’est décidé. Tranchez la demande de l’occurrence courante (cycle memory-alarms) ou refusez celle-ci.');
  }
  return pause;
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

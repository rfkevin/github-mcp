/**
 * CC-3 C2 — CollabStore: D1 adapter over the canonical C1 schema
 * (src/collab-store/schema/0001_init.sql). The append-only event log is the
 * source of truth; cycles.revision counts applied events (F3: stored rows
 * start at 1, expected_rev 0 = creation).
 *
 * CAS is fail-closed: one D1 batch (a single SQL transaction). The first
 * statement inserts a guard row whose CHECK fails — and therefore rolls back
 * the whole batch — unless (1) the idempotency key is new, (2) the cycle is
 * exactly at expected_rev and (3) the daily quota is open. Never
 * last-write-wins: a stale writer changes nothing.
 */
import { opIdToIdempotencyKey, validateAgentEvent, validateTaskAssignment, type StoreEvent, type StoreEventType } from '../contracts';
import { createSealedEnvelope, parseSealedEnvelope } from '../phases/sealed-envelope';
import { ensureSchema } from './schema';
import { sha256Hex } from './hash';
import { DEFAULT_DAILY_WRITE_LIMIT } from './config';

export class CollabStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CollabStoreError';
  }
}

export const TASK_STATUSES = ['proposed', 'accepted', 'in_progress', 'review', 'verified', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface AppendEventInput {
  cycle_id: string;
  type: StoreEventType;
  participant_id: string;
  /** Expected revision. 0 = row creation (F3: stored rows start at 1). */
  expected_rev: number;
  payload_json: string;
  /** op_id policy (C1): {client}:{cycle}:{op}:{n}. */
  op_id: string;
  session_id?: string;
  role?: string;
  evidence_ref?: string;
}

export interface StoredStoreEvent {
  seq: number;
  cycle_id: string;
  at: number;
  type: string;
  participant_id: string;
  session_id: string;
  role: string;
  payload_json: string;
  expected_rev: number;
  idempotency_key: string;
  evidence_ref: string;
}

export type AppendOutcome =
  | { status: 'applied'; revision: number; event: StoredStoreEvent }
  | { status: 'duplicate'; event: StoredStoreEvent }
  | { status: 'stale'; currentRevision: number; delta: StoredStoreEvent[] }
  | { status: 'quota_exhausted'; day: string; limit: number };

export interface StoreContextTask {
  task_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  status: string;
  owned_paths: string;
  next_action: string;
  revision: number;
}

export interface StoreOptions {
  dailyWriteLimit?: number;
  now?: () => Date;
}

export class CollabStore {
  private readonly now: () => Date;
  private readonly dailyWriteLimit: number;

  constructor(private readonly db: D1Database, options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.dailyWriteLimit = options.dailyWriteLimit ?? DEFAULT_DAILY_WRITE_LIMIT;
  }

  async currentRevision(cycleId: string): Promise<number> {
    await ensureSchema(this.db);
    const row = await this.db.prepare(
      'SELECT COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?1), 0) AS revision'
    ).bind(cycleId).first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  async appendEvent(input: AppendEventInput): Promise<AppendOutcome> {
    const key = opIdToIdempotencyKey(input.op_id);
    // A05 (F1): the op_id cycle segment must be the target cycle. The client
    // segment may contain ':' but the cycle never does: parse from the right.
    const segments = input.op_id.split(':');
    const opCycle = segments[segments.length - 3] || '';
    if (opCycle !== input.cycle_id) {
      throw new CollabStoreError(
        'INVALID_OP_ID',
        'op_id doit porter le segment cycle de la requête ({client}:{cycle}:{op}:{n}) : attendu « ' + input.cycle_id + ' », reçu « ' + opCycle + ' »',
      );
    }
    const event: StoreEvent = {
      cycle_id: input.cycle_id,
      type: input.type,
      participant_id: input.participant_id,
      session_id: input.session_id ?? '',
      role: input.role ?? '',
      expected_rev: input.expected_rev,
      payload_json: input.payload_json,
      idempotency_key: key,
      evidence_ref: input.evidence_ref ?? '',
    };
    validateAgentEvent(event);
    await ensureSchema(this.db);
    // A05 (F1): fingerprint the incoming intent BEFORE P1 sealing rewrites
    // the payload, so a replay compares the raw intent to the stored one.
    const intentFingerprint = await this.intentFingerprint(event);

    // A05 (F1, review Claude): judge an existing key BEFORE the P1 sealing
    // and the task permission statements. Otherwise a lost-response replay
    // of task.handoff or of a task.claim reassignment would be judged on the
    // state its own first write produced (TASK_FORBIDDEN) instead of
    // returning duplicate with the original event.
    const replayed = await this.replayOutcome(key, intentFingerprint);
    if (replayed) return replayed;

    let sealedInsert: D1PreparedStatement | null = null;
    if (event.type === 'proposal.submit') {
      const cycle = await this.db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1')
        .bind(event.cycle_id).first<{ phase: string }>();
      const phase = cycle?.phase ?? (event.expected_rev === 0 ? 'P1' : '');
      if (phase === 'P1') {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        } catch {
          throw new CollabStoreError('INVALID_PROPOSAL_PAYLOAD', 'proposal.submit payload_json must be an object.');
        }
        if (typeof payload.content !== 'string' || !payload.content) {
          throw new CollabStoreError('INVALID_PROPOSAL_PAYLOAD', 'proposal.submit requires payload_json.content in P1.');
        }
        // A01 (F1): hash the full key + cycle instead of truncating the
        // key: long op_ids sharing a 48-char prefix collided on sealed ids.
        const sealedId = 'sealed-' + (await sha256Hex(key + '|' + event.cycle_id));
        const envelope = await createSealedEnvelope(payload.content);
        event.payload_json = JSON.stringify({ sealed_id: sealedId, content_hash: envelope.content_hash });
        sealedInsert = this.db.prepare([
          'INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at)',
          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)',
        ].join(' ')).bind(
          sealedId,
          event.cycle_id,
          phase,
          event.participant_id,
          envelope.content_hash,
          envelope.serialized,
        );
      }
    }

    const now = this.now();
    const at = Math.floor(now.getTime() / 1000);
    const day = now.toISOString().slice(0, 10);
    const nextRevision = event.expected_rev + 1;
    const taskStatements = await this.taskStatements(event, nextRevision);
    const statements: D1PreparedStatement[] = [
      // Transactional CAS guard: the whole batch rolls back unless the key is
      // new AND the cycle is exactly at expected_rev AND the quota is open.
      this.db.prepare([
        'INSERT INTO collab_store_guard (ok)',
        'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?1)',
        '             AND COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?2), 0) = ?3',
        '             AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?4), 0) < ?5',
        '       THEN 1 ELSE 0 END',
      ].join(' ')).bind(key, event.cycle_id, event.expected_rev, day, this.dailyWriteLimit),
      this.db.prepare(
        'INSERT INTO quota_counters (day, writes) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET writes = writes + 1'
      ).bind(day),
      this.db.prepare(
        'INSERT INTO cycles (cycle_id) VALUES (?1) ON CONFLICT(cycle_id) DO NOTHING'
      ).bind(event.cycle_id),
      ...(sealedInsert ? [sealedInsert] : []),
      this.db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json,',
        '                   expected_rev, idempotency_key, evidence_ref)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
      ].join(' ')).bind(event.cycle_id, at, event.type, event.participant_id, event.session_id,
        event.role, event.payload_json, event.expected_rev, key, event.evidence_ref),
      this.db.prepare(
        'UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3'
      ).bind(event.cycle_id, nextRevision, event.expected_rev),
      ...taskStatements,
      this.db.prepare('DELETE FROM collab_store_guard'),
    ];
    try {
      await this.db.batch(statements);
    } catch (error) {
      // Fail-closed: diagnose from the durable state, never guess. F1: a
      // duplicate idempotency key wins over STALE.
      const replay = await this.replayOutcome(key, intentFingerprint);
      if (replay) return replay;
      const quota = await this.db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
        .bind(day).first<{ writes: number }>();
      if ((quota?.writes ?? 0) >= this.dailyWriteLimit) {
        return { status: 'quota_exhausted', day, limit: this.dailyWriteLimit };
      }
      const currentRevision = await this.currentRevision(event.cycle_id);
      if (currentRevision !== event.expected_rev) {
        return { status: 'stale', currentRevision, delta: await this.deltaSinceRevision(event.cycle_id, event.expected_rev) };
      }
      throw error;
    }
    const stored = await this.eventByKey(key);
    return { status: 'applied', revision: nextRevision, event: stored! };
  }

  async getDelta(cycleId: string, sinceSeq: number, limit = 200): Promise<{ events: StoredStoreEvent[]; hasMore: boolean }> {
    await ensureSchema(this.db);
    const { results } = await this.db.prepare(
      'SELECT * FROM events WHERE cycle_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3'
    ).bind(cycleId, sinceSeq, limit + 1).all<StoredStoreEvent>();
    const events = await Promise.all(results.slice(0, limit).map(event => this.revealProposalPayload(event)));
    return { events, hasMore: results.length > limit };
  }

  private async revealProposalPayload(event: StoredStoreEvent): Promise<StoredStoreEvent> {
    if (event.type !== 'proposal.submit') return event;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      return event;
    }
    if (typeof metadata.sealed_id !== 'string') return event;
    const row = await this.db.prepare(
      'SELECT content, revealed_at FROM sealed_items WHERE id = ?1 AND cycle_id = ?2'
    ).bind(metadata.sealed_id, event.cycle_id).first<{ content: string; revealed_at: number | null }>();
    if (!row || row.revealed_at === null) return event;
    const envelope = parseSealedEnvelope(row.content);
    return {
      ...event,
      payload_json: JSON.stringify({
        ...metadata,
        content: envelope.content,
        nonce: envelope.nonce,
        revealed: true,
      }),
    };
  }

  async getContext(cycleId: string, participantId?: string): Promise<{
    cycle_id: string;
    phase: string;
    status: string;
    revision: number;
    tasks: StoreContextTask[];
  }> {
    await ensureSchema(this.db);
    const cycle = await this.db.prepare(
      'SELECT cycle_id, phase, status, revision FROM cycles WHERE cycle_id = ?1'
    ).bind(cycleId).first<{ cycle_id: string; phase: string; status: string; revision: number }>();
    if (!cycle) {
      throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);
    }
    const sql = [
      'SELECT task_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, next_action, revision ',
      'FROM tasks WHERE cycle_id = ?1',
      participantId ? ' AND (owner_pid = ?2 OR reviewer_pid = ?2 OR tester_pid = ?2)' : '',
      ' ORDER BY task_id',
    ].join('');
    const query = participantId
      ? this.db.prepare(sql).bind(cycleId, participantId)
      : this.db.prepare(sql).bind(cycleId);
    const { results } = await query.all<StoreContextTask>();
    return { cycle_id: cycle.cycle_id, phase: cycle.phase, status: cycle.status, revision: cycle.revision, tasks: results };
  }

  /** Events applied after revision `sinceRevision` (revision k = k-th event by seq). */
  private async deltaSinceRevision(cycleId: string, sinceRevision: number): Promise<StoredStoreEvent[]> {
    // Events applied after revision R = events excluding the first R by seq:
    // the anchor is the R-th event (OFFSET R - 1); R = 0 means the whole journal.
    const { results } = await this.db.prepare([
      'SELECT * FROM events WHERE cycle_id = ?1 AND (',
      '  ?2 = 0 OR seq > COALESCE(',
      '    (SELECT seq FROM events WHERE cycle_id = ?1 ORDER BY seq LIMIT 1 OFFSET (?2 - 1)), 0))',
      ' ORDER BY seq',
    ].join(' ')).bind(cycleId, sinceRevision).all<StoredStoreEvent>();
    return results;
  }

  private async eventByKey(key: string): Promise<StoredStoreEvent | null> {
    return this.db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<StoredStoreEvent>();
  }

  /**
   * A05 (F1): a reused op_id is only idempotent for the same intent; a
   * different intent under the same key is a conflict, never a silent
   * overwrite of the stored event. Returns null for a new key, the duplicate
   * outcome otherwise (IDEMPOTENCY_CONFLICT on intent mismatch). The message
   * stays neutral: it never echoes the stored seq/type.
   */
  private async replayOutcome(key: string, intentFingerprint: string): Promise<AppendOutcome | null> {
    const existing = await this.eventByKey(key);
    if (!existing) return null;
    const storedFingerprint = await this.intentFingerprint(existing);
    if (storedFingerprint !== intentFingerprint) {
      throw new CollabStoreError(
        'IDEMPOTENCY_CONFLICT',
        'op_id déjà utilisé pour une intention différente. Incrémentez le compteur n de l\'op_id.',
      );
    }
    return { status: 'duplicate', event: existing };
  }

  /**
   * Materialized task statements, validated BEFORE the batch (fail-closed).
   *
   * TOCTOU (accepted, review C2) : the existence check for task.status/handoff
   * reads before the batch runs; a concurrent delete in between makes the UPDATE
   * a no-op. Deletes are not part of the C2 tool surface (append-only journal),
   * so the window is not reachable through this API.
   */
  private async taskStatements(event: StoreEvent, nextRevision: number): Promise<D1PreparedStatement[]> {
    if (event.type !== 'task.claim' && event.type !== 'task.status' && event.type !== 'task.handoff') return [];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      throw new CollabStoreError('INVALID_TASK_PAYLOAD', 'payload_json must be an object for ' + event.type);
    }
    const task = payload.task;
    if (typeof task !== 'object' || task === null) {
      throw new CollabStoreError('INVALID_TASK_PAYLOAD', 'payload_json.task is required for ' + event.type);
    }
    const record = task as Record<string, unknown>;
    const taskId = typeof record.task_id === 'string' ? record.task_id : '';
    if (!TASK_ID_RE.test(taskId)) {
      throw new CollabStoreError('INVALID_TASK_ID', 'task_id must match [a-z0-9][a-z0-9_-]{0,63}');
    }
    if (event.type === 'task.claim') {
      // D12 enforced at write time: author, reviewer and tester are distinct.
      const assignment = validateTaskAssignment({
        task_id: taskId,
        cycle_id: event.cycle_id,
        owner_pid: typeof record.owner_pid === 'string' ? record.owner_pid : '',
        reviewer_pid: typeof record.reviewer_pid === 'string' ? record.reviewer_pid : '',
        tester_pid: typeof record.tester_pid === 'string' ? record.tester_pid : '',
      });
      // A08 (F1): a first claim is filed by the owner themselves; an
      // existing task can only be reassigned by its current owner.
      const current = await this.db.prepare(
        'SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
      ).bind(event.cycle_id, taskId).first<{ owner_pid: string }>();
      const allowedOwner = current ? current.owner_pid : assignment.owner_pid;
      if (allowedOwner !== event.participant_id) {
        throw new CollabStoreError(
          'TASK_FORBIDDEN',
          current
            ? 'task.claim sur une tâche existante est réservé à son owner courant (' + current.owner_pid + '), pas à ' + event.participant_id
            : 'task.claim initial doit être fait par l\'owner de la tâche (' + assignment.owner_pid + '), pas par ' + event.participant_id,
        );
      }
      await this.requireRegisteredParticipants([assignment.owner_pid, assignment.reviewer_pid, assignment.tester_pid]);
      return [this.db.prepare([
        'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status,',
        '                  owned_paths, target_ref, next_action, revision)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, \'\', ?8, ?9)',
        'ON CONFLICT(cycle_id, task_id) DO UPDATE SET owner_pid = excluded.owner_pid,',
        '  reviewer_pid = excluded.reviewer_pid, tester_pid = excluded.tester_pid,',
        '  status = excluded.status, owned_paths = excluded.owned_paths,',
        '  next_action = excluded.next_action, revision = excluded.revision',
      ].join(' ')).bind(assignment.task_id, event.cycle_id, assignment.owner_pid, assignment.reviewer_pid,
        assignment.tester_pid, 'in_progress',
        JSON.stringify(Array.isArray(record.owned_paths) ? record.owned_paths : []),
        typeof record.next_action === 'string' ? record.next_action : '', nextRevision)];
    }
    const existing = await this.db.prepare(
      'SELECT owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
    ).bind(event.cycle_id, taskId).first<{ owner_pid: string; reviewer_pid: string; tester_pid: string }>();
    if (!existing) {
      throw new CollabStoreError('TASK_UNKNOWN', 'Tâche inconnue dans le cycle ' + event.cycle_id + ' : ' + taskId);
    }
    if (event.type === 'task.status') {
      // A08 (F1): only the task roles may move the status.
      const roles = [existing.owner_pid, existing.reviewer_pid, existing.tester_pid];
      if (!roles.includes(event.participant_id)) {
        throw new CollabStoreError(
          'TASK_FORBIDDEN',
          'task.status réservé aux rôles de la tâche ' + taskId + ' (' + roles.join(', ') + '), pas à ' + event.participant_id,
        );
      }
      const status = typeof record.status === 'string' ? record.status : '';
      if (!TASK_STATUSES.includes(status as TaskStatus)) {
        throw new CollabStoreError('INVALID_TASK_STATUS', 'Statut de tâche non supporté : ' + status);
      }
      return [this.db.prepare(
        'UPDATE tasks SET status = ?2, revision = ?3 WHERE cycle_id = ?1 AND task_id = ?4'
      ).bind(event.cycle_id, status, nextRevision, taskId)];
    }
    // task.handoff: transfer the task to a new owner with a new next action.
    // A08 (F1): only the current owner may hand the task over.
    if (existing.owner_pid !== event.participant_id) {
      throw new CollabStoreError(
        'TASK_FORBIDDEN',
        'task.handoff réservé à l\'owner courant de la tâche ' + taskId + ' (' + existing.owner_pid + '), pas à ' + event.participant_id,
      );
    }
    // D12 stays enforced at write time: the (possibly new) owner must remain
    // distinct from the reviewer and the tester.
    const ownerPid = typeof record.owner_pid === 'string' && record.owner_pid ? record.owner_pid : existing.owner_pid;
    const pids = [ownerPid, existing.reviewer_pid, existing.tester_pid];
    if (pids.some(pid => !pid) || new Set(pids).size !== pids.length) {
      throw new CollabStoreError('DUPLICATE_TASK_ROLE', 'D12 : auteur, reviewer et testeur doivent etre distincts.');
    }
    // A08 (F1): the (possibly new) owner must be a participant registered as
    // active on /owner (K6).
    await this.requireRegisteredParticipants([ownerPid]);
    return [this.db.prepare(
      'UPDATE tasks SET next_action = ?2, owner_pid = ?3, revision = ?4 WHERE cycle_id = ?1 AND task_id = ?5'
    ).bind(event.cycle_id,
      typeof record.next_action === 'string' ? record.next_action : '',
      ownerPid,
      nextRevision, taskId)];
  }

  /**
   * A08 (F1): every task role must be a participant registered as active on
   * /owner (K6). Unregistered identities cannot own store work.
   */
  private async requireRegisteredParticipants(pids: string[]): Promise<void> {
    for (const pid of pids) {
      const row = await this.db.prepare(
        'SELECT status FROM participants WHERE participant_id = ?1'
      ).bind(pid).first<{ status: string }>();
      if (!row || row.status !== 'active') {
        throw new CollabStoreError(
          'UNREGISTERED_PARTICIPANT',
          'participant non enregistré (actif) pour ce rôle : ' + pid + '. Enregistrement par le propriétaire sur /owner (K6).',
        );
      }
    }
  }

  /**
   * A05 (F1): canonical intent fingerprint of an append. expected_rev is
   * excluded on purpose: a retry after STALE replays the same intent at a
   * new revision and must stay idempotent.
   */
  private async intentFingerprint(source: {
    cycle_id: string;
    type: string;
    participant_id: string;
    session_id?: string;
    role?: string;
    payload_json: string;
    evidence_ref?: string;
  }): Promise<string> {
    const payloadIntent = source.type === 'proposal.submit'
      ? await this.proposalIntent(source.payload_json, source.cycle_id)
      : source.payload_json;
    return JSON.stringify({
      cycle_id: source.cycle_id,
      type: source.type,
      participant_id: source.participant_id,
      session_id: source.session_id ?? '',
      role: source.role ?? '',
      payload_intent: payloadIntent,
      evidence_ref: source.evidence_ref ?? '',
    });
  }

  /**
   * A05 (F1): content-level intent of a proposal — raw content before P1
   * sealing, sealed envelope content once stored — so a raw replay of a P1
   * proposal compares equal to its sealed event.
   */
  private async proposalIntent(payloadJson: string, cycleId: string): Promise<unknown> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadJson) as Record<string, unknown>;
    } catch {
      return { invalid: payloadJson };
    }
    if (typeof payload.content === 'string' && payload.content) {
      return { proposal_content: await sha256Hex(payload.content) };
    }
    if (typeof payload.sealed_id === 'string' && payload.sealed_id) {
      const row = await this.db.prepare(
        'SELECT content, content_hash FROM sealed_items WHERE id = ?1 AND cycle_id = ?2'
      ).bind(payload.sealed_id, cycleId).first<{ content: string; content_hash: string }>();
      if (row) {
        try {
          return { proposal_content: await sha256Hex(parseSealedEnvelope(row.content).content) };
        } catch {
          return { proposal_content: 'sealed:' + row.content_hash };
        }
      }
      return { sealed_id: payload.sealed_id, content_hash: typeof payload.content_hash === 'string' ? payload.content_hash : '' };
    }
    return { raw: payloadJson };
  }
}

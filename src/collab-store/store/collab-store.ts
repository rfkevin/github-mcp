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
import { ensureSchema } from './schema';
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
      const existing = await this.eventByKey(key);
      if (existing) return { status: 'duplicate', event: existing };
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
    const events = results.slice(0, limit);
    return { events, hasMore: results.length > limit };
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
    const { results } = await this.db.prepare([
      'SELECT * FROM events WHERE cycle_id = ?1 AND seq > COALESCE(',
      '  (SELECT seq FROM events WHERE cycle_id = ?1 ORDER BY seq LIMIT 1 OFFSET ?2), 0)',
      ' ORDER BY seq',
    ].join(' ')).bind(cycleId, sinceRevision).all<StoredStoreEvent>();
    return results;
  }

  private async eventByKey(key: string): Promise<StoredStoreEvent | null> {
    return this.db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<StoredStoreEvent>();
  }

  /** Materialized task statements, validated BEFORE the batch (fail-closed). */
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
      'SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
    ).bind(event.cycle_id, taskId).first<{ owner_pid: string }>();
    if (!existing) {
      throw new CollabStoreError('TASK_UNKNOWN', 'Tâche inconnue dans le cycle ' + event.cycle_id + ' : ' + taskId);
    }
    if (event.type === 'task.status') {
      const status = typeof record.status === 'string' ? record.status : '';
      if (!TASK_STATUSES.includes(status as TaskStatus)) {
        throw new CollabStoreError('INVALID_TASK_STATUS', 'Statut de tâche non supporté : ' + status);
      }
      return [this.db.prepare(
        'UPDATE tasks SET status = ?2, revision = ?3 WHERE cycle_id = ?1 AND task_id = ?4'
      ).bind(event.cycle_id, status, nextRevision, taskId)];
    }
    // task.handoff: transfer the task to a new owner with a new next action.
    return [this.db.prepare(
      'UPDATE tasks SET next_action = ?2, owner_pid = ?3, revision = ?4 WHERE cycle_id = ?1 AND task_id = ?5'
    ).bind(event.cycle_id,
      typeof record.next_action === 'string' ? record.next_action : '',
      typeof record.owner_pid === 'string' ? record.owner_pid : existing.owner_pid,
      nextRevision, taskId)];
  }
}

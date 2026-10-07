/**
 * C0 prototype store on D1 (CC-PLAN-3/v1.1 §5 C0). Purpose: prove or refute the
 * guarantees the plan needs before C2 builds the real store. Not wired to any
 * MCP tool and not exported by the Worker.
 *
 * CAS design: one D1 batch (= one SQL transaction, rolled back as a whole on any
 * failing statement). The first statement inserts the event only when the cycle
 * is still at `expectedRev` and the daily quota is not exhausted; every later
 * statement is conditioned on that event existing. A stale writer therefore
 * changes nothing, and a failure in any later statement rolls back the event too.
 */

export type TaskStatus = 'proposed' | 'accepted' | 'in_progress' | 'review' | 'verified' | 'done' | 'blocked';
export interface TaskPatch { taskId: string; status: TaskStatus; ownerPid: string; nextAction: string }
export interface AppendInput {
  cycleId: string;
  expectedRev: number;
  participantId: string;
  opId: string;
  type: 'task.upsert' | 'checkpoint' | 'note';
  payload: Record<string, unknown>;
  task?: TaskPatch;
}
export interface StoredEvent {
  seq: number; cycle_id: string; rev: number; type: string; participant_id: string;
  idempotency_key: string; payload: string; at: string;
}
export type AppendResult =
  | { status: 'applied'; rev: number; event: StoredEvent }
  | { status: 'duplicate'; event: StoredEvent }
  | { status: 'stale'; currentRev: number; delta: StoredEvent[] }
  | { status: 'quota_exhausted'; day: string; limit: number };

export interface StoreOptions { dailyWriteLimit: number; now?: () => Date }

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function idempotencyKey(participantId: string, cycleId: string, type: string, opId: string): Promise<string> {
  return sha256Hex([participantId, cycleId, type, opId].join('|'));
}

export class ProtoStore {
  private readonly now: () => Date;
  constructor(private readonly db: D1Database, private readonly options: StoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async createCycle(cycleId: string): Promise<void> {
    await this.db.prepare('INSERT INTO cycles (cycle_id, revision) VALUES (?1, 0)').bind(cycleId).run();
  }

  async currentRev(cycleId: string): Promise<number> {
    const row = await this.db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycleId).first<{ revision: number }>();
    if (!row) throw new Error('UNKNOWN_CYCLE');
    return row.revision;
  }

  async append(input: AppendInput): Promise<AppendResult> {
    if (!input.opId) throw new Error('OP_ID_REQUIRED');
    const key = await idempotencyKey(input.participantId, input.cycleId, input.type, input.opId);
    const at = this.now().toISOString();
    const day = at.slice(0, 10);
    const nextRev = input.expectedRev + 1;
    const inserted = 'EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?1)';
    const statements = [
      this.db.prepare(
        `INSERT INTO events (cycle_id, rev, type, participant_id, idempotency_key, payload, at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT revision FROM cycles WHERE cycle_id = ?1) = ?8
           AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?9), 0) < ?10`,
      ).bind(input.cycleId, nextRev, input.type, input.participantId, key, JSON.stringify(input.task ? { ...input.payload, task: input.task } : input.payload), at,
        input.expectedRev, day, this.options.dailyWriteLimit),
      this.db.prepare(`UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3 AND ${inserted.replace('?1', '?4')}`)
        .bind(input.cycleId, nextRev, input.expectedRev, key),
      this.db.prepare(
        `INSERT INTO quota_counters (day, writes) SELECT ?1, 1 WHERE ${inserted.replace('?1', '?2')}
         ON CONFLICT (day) DO UPDATE SET writes = writes + 1`,
      ).bind(day, key),
    ];
    if (input.task) {
      const task = input.task;
      statements.push(this.db.prepare(
        `INSERT INTO tasks (cycle_id, task_id, status, owner_pid, next_action, rev)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${inserted.replace('?1', '?7')}
         ON CONFLICT (cycle_id, task_id) DO UPDATE SET status = excluded.status,
           owner_pid = excluded.owner_pid, next_action = excluded.next_action, rev = excluded.rev`,
      ).bind(input.cycleId, task.taskId, task.status, task.ownerPid, task.nextAction, nextRev, key));
    }

    let results: D1Result[];
    try {
      results = await this.db.batch(statements);
    } catch (error) {
      const existing = await this.eventByKey(key);
      if (existing) return { status: 'duplicate', event: existing };
      throw error; // the whole batch was rolled back
    }
    if (results[0].meta.changes === 1) {
      const event = await this.eventByKey(key);
      return { status: 'applied', rev: nextRev, event: event! };
    }
    // Nothing inserted: either this op_id was already applied (retry after a lost
    // response, possibly at an older revision), the quota is exhausted, or the writer is stale.
    const existing = await this.eventByKey(key);
    if (existing) return { status: 'duplicate', event: existing };
    const quota = await this.db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(day).first<{ writes: number }>();
    if ((quota?.writes ?? 0) >= this.options.dailyWriteLimit) {
      return { status: 'quota_exhausted', day, limit: this.options.dailyWriteLimit };
    }
    const currentRev = await this.currentRev(input.cycleId);
    return { status: 'stale', currentRev, delta: await this.delta(input.cycleId, input.expectedRev) };
  }

  async delta(cycleId: string, sinceRev: number): Promise<StoredEvent[]> {
    const { results } = await this.db.prepare('SELECT * FROM events WHERE cycle_id = ?1 AND rev > ?2 ORDER BY rev')
      .bind(cycleId, sinceRev).all<StoredEvent>();
    return results;
  }

  private eventByKey(key: string): Promise<StoredEvent | null> {
    return this.db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key).first<StoredEvent>();
  }

  /** Hash of the materialized state (cycle revision + tasks). */
  async stateHash(cycleId: string): Promise<string> {
    const rev = await this.currentRev(cycleId);
    const { results } = await this.db.prepare(
      'SELECT task_id, status, owner_pid, next_action, rev FROM tasks WHERE cycle_id = ?1 ORDER BY task_id',
    ).bind(cycleId).all();
    return sha256Hex(JSON.stringify({ cycleId, rev, tasks: results }));
  }

  /** Hash of the state recomputed purely from the event log (replay). */
  async replayHash(cycleId: string): Promise<string> {
    const events = await this.delta(cycleId, 0);
    const tasks = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      const payload = JSON.parse(event.payload) as { task?: TaskPatch };
      if (event.type === 'task.upsert' && payload.task) {
        const task = payload.task;
        tasks.set(task.taskId, { task_id: task.taskId, status: task.status, owner_pid: task.ownerPid, next_action: task.nextAction, rev: event.rev });
      }
    }
    const rows = [...tasks.values()].sort((a, b) => String(a.task_id).localeCompare(String(b.task_id)));
    const rev = events.at(-1)?.rev ?? 0;
    return sha256Hex(JSON.stringify({ cycleId, rev, tasks: rows }));
  }

  async exportCycle(cycleId: string): Promise<{ cycleId: string; events: StoredEvent[] }> {
    return { cycleId, events: await this.delta(cycleId, 0) };
  }

  /** Re-import an exported log into an empty database, then rebuild the materialized view. */
  static async importCycle(db: D1Database, exported: { cycleId: string; events: StoredEvent[] }): Promise<void> {
    exported.events.forEach((event, index) => {
      if (event.rev !== index + 1) throw new Error('EXPORT_GAP');
    });
    const statements = [db.prepare('INSERT INTO cycles (cycle_id, revision) VALUES (?1, ?2)')
      .bind(exported.cycleId, exported.events.length)];
    for (const event of exported.events) {
      statements.push(db.prepare(
        'INSERT INTO events (cycle_id, rev, type, participant_id, idempotency_key, payload, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      ).bind(exported.cycleId, event.rev, event.type, event.participant_id, event.idempotency_key, event.payload, event.at));
      const payload = JSON.parse(event.payload) as { task?: TaskPatch };
      if (event.type === 'task.upsert' && payload.task) {
        const task = payload.task;
        statements.push(db.prepare(
          `INSERT INTO tasks (cycle_id, task_id, status, owner_pid, next_action, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (cycle_id, task_id) DO UPDATE SET status = excluded.status, owner_pid = excluded.owner_pid,
             next_action = excluded.next_action, rev = excluded.rev`,
        ).bind(exported.cycleId, task.taskId, task.status, task.ownerPid, task.nextAction, event.rev));
      }
    }
    await db.batch(statements);
  }
}

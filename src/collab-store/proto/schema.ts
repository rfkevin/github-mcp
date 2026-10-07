/**
 * C0 prototype schema (CC-PLAN-3/v1.1 §3.2, subset needed by the gate scenarios).
 * Portable SQLite: no D1-only pragma, so the same statements run on stock SQLite.
 * The final schema is owned by C1 (`src/collab-store/schema/0001_init.sql`).
 */
export const PROTO_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS cycles (
    cycle_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
  )`,
  // events: append-only source of truth. UNIQUE(cycle_id, rev) is the CAS guard,
  // UNIQUE(idempotency_key) makes a retried operation a no-op.
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),
    rev INTEGER NOT NULL,
    type TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    at TEXT NOT NULL,
    UNIQUE (cycle_id, rev)
  )`,
  // tasks: materialized view, rebuilt from events by replay.
  `CREATE TABLE IF NOT EXISTS tasks (
    cycle_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','accepted','in_progress','review','verified','done','blocked')),
    owner_pid TEXT NOT NULL,
    next_action TEXT NOT NULL,
    rev INTEGER NOT NULL,
    PRIMARY KEY (cycle_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(text) <= 600),
    confidence TEXT NOT NULL,
    status TEXT NOT NULL,
    origin_cycle TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS memory_scope_status ON memory_entries (scope, status)`,
  `CREATE TABLE IF NOT EXISTS quota_counters (
    day TEXT PRIMARY KEY,
    writes INTEGER NOT NULL DEFAULT 0
  )`,
];

export async function applyProtoSchema(db: D1Database): Promise<void> {
  await db.batch(PROTO_SCHEMA.map((sql) => db.prepare(sql)));
}

/**
 * CC-3 C2 — store-owned schema management.
 *
 * CANONICAL_SCHEMA_SQL is a byte-for-byte copy of the C1 reference
 * (src/collab-store/schema/0001_init.sql): C1 owns the schema, C2 never edits
 * it. A CI test asserts equality after whitespace normalization, so the two
 * can never drift silently.
 *
 * The C0 prototype (src/collab-store/proto) is a frozen artifact and is NOT
 * consumed here (C1 review reco #3).
 */

import { estimateTokens } from '../contracts/memory';

export const CANONICAL_SCHEMA_SQL = [
  '-- CC-3 C1 — 0001_init.sql : portable standard SQL (D1 + stock SQLite).',
  '-- No engine-specific options. Revisions start at 1 (F3); expected_rev 0 = creation.',
  '-- All timestamps: INTEGER unix seconds (no date functions).',
  '',
  'CREATE TABLE IF NOT EXISTS participants (',
  '  participant_id TEXT PRIMARY KEY,',
  '  display_label TEXT NOT NULL,',
  '  status TEXT NOT NULL DEFAULT \'active\'',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS participant_clients (',
  '  oauth_client_id TEXT PRIMARY KEY,',
  '  participant_id TEXT NOT NULL REFERENCES participants(participant_id),',
  '  approved_event_seq INTEGER',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS cycles (',
  '  cycle_id TEXT PRIMARY KEY,',
  '  project TEXT NOT NULL DEFAULT \'\',',
  '  phase TEXT NOT NULL DEFAULT \'P1\',',
  '  revision INTEGER NOT NULL DEFAULT 1,',
  '  status TEXT NOT NULL DEFAULT \'open\'',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS phase_definitions (',
  '  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
  '  phase TEXT NOT NULL,',
  '  entry_conditions TEXT NOT NULL DEFAULT \'[]\',',
  '  expected_outputs TEXT NOT NULL DEFAULT \'[]\',',
  '  exit_conditions TEXT NOT NULL DEFAULT \'[]\',',
  '  auto_advance TEXT NOT NULL DEFAULT \'none\',',
  '  PRIMARY KEY (cycle_id, phase)',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS tasks (',
  '  task_id TEXT NOT NULL,',
  '  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
  '  owner_pid TEXT NOT NULL,',
  '  reviewer_pid TEXT NOT NULL,',
  '  tester_pid TEXT NOT NULL,',
  '  status TEXT NOT NULL DEFAULT \'proposed\',',
  '  owned_paths TEXT NOT NULL DEFAULT \'[]\',',
  '  target_ref TEXT NOT NULL DEFAULT \'\',',
  '  next_action TEXT NOT NULL DEFAULT \'\',',
  '  revision INTEGER NOT NULL DEFAULT 1,',
  '  PRIMARY KEY (cycle_id, task_id)',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS events (',
  '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
  '  at INTEGER NOT NULL,',
  '  type TEXT NOT NULL,',
  '  participant_id TEXT NOT NULL,',
  '  session_id TEXT NOT NULL DEFAULT \'\',',
  '  role TEXT NOT NULL DEFAULT \'\',',
  '  payload_json TEXT NOT NULL,',
  '  expected_rev INTEGER NOT NULL DEFAULT 0,',
  '  idempotency_key TEXT NOT NULL UNIQUE,',
  '  evidence_ref TEXT NOT NULL DEFAULT \'\'',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_events_cycle_seq ON events(cycle_id, seq);',
  'CREATE INDEX IF NOT EXISTS idx_events_cycle_type ON events(cycle_id, type);',
  '',
  'CREATE TABLE IF NOT EXISTS sealed_items (',
  '  id TEXT PRIMARY KEY,',
  '  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
  '  phase TEXT NOT NULL,',
  '  participant_id TEXT NOT NULL,',
  '  content_hash TEXT NOT NULL,',
  '  content TEXT NOT NULL,',
  '  revealed_at INTEGER',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS memory_entries (',
  '  id TEXT NOT NULL,',
  '  version INTEGER NOT NULL DEFAULT 1,',
  '  scope TEXT NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  text TEXT NOT NULL,',
  '  evidence_refs TEXT NOT NULL DEFAULT \'[]\',',
  '  confidence TEXT NOT NULL DEFAULT \'hypothesis\',',
  '  status TEXT NOT NULL DEFAULT \'candidate\',',
  '  author_pid TEXT NOT NULL,',
  '  reviewer_pid TEXT NOT NULL DEFAULT \'\',',
  '  supersedes TEXT,',
  '  uses INTEGER NOT NULL DEFAULT 0,',
  '  last_used_rev INTEGER,',
  '  expires_rev INTEGER,',
  '  PRIMARY KEY (id, version)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_memory_scope_status ON memory_entries(scope, status);',
  '',
  'CREATE TABLE IF NOT EXISTS evidence_ledger (',
  '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  subject_pid TEXT NOT NULL,',
  '  producer TEXT NOT NULL,',
  '  kind TEXT NOT NULL,',
  '  payload_json TEXT NOT NULL,',
  '  evidence_ref TEXT NOT NULL DEFAULT \'\',',
  '  at INTEGER NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_ledger_subject ON evidence_ledger(subject_pid, seq);',
  '',
  'CREATE TABLE IF NOT EXISTS owner_decisions (',
  '  request_id TEXT PRIMARY KEY,',
  '  decision TEXT NOT NULL,',
  '  access_subject TEXT NOT NULL,',
  '  at INTEGER NOT NULL,',
  '  event_seq INTEGER REFERENCES events(seq)',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS checkpoints (',
  '  participant_id TEXT NOT NULL,',
  '  cycle_id TEXT NOT NULL REFERENCES cycles(cycle_id),',
  '  last_seen_seq INTEGER NOT NULL DEFAULT 0,',
  '  PRIMARY KEY (participant_id, cycle_id)',
  ');',
  '',
  'CREATE TABLE IF NOT EXISTS quota_counters (',
  '  day TEXT PRIMARY KEY,',
  '  writes INTEGER NOT NULL DEFAULT 0',
  ');',
  ''
].join('\n');

/**
 * Store-internal table (never part of the canonical schema): the transactional
 * CAS guard row. CHECK(ok = 1) makes a failing guard abort the whole D1 batch.
 */
export const STORE_INTERNAL_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS collab_store_guard (ok INTEGER NOT NULL CHECK (ok = 1))',
];

/**
 * Store-owned migration 0002 (C1 review reco #2): events.model_meta is listed in
 * plan CC-PLAN-3/v1.1 §3.2 but was absent from the frozen C1 schema.
 */
export const STORE_MIGRATION_0002 =
  "ALTER TABLE events ADD COLUMN model_meta TEXT NOT NULL DEFAULT ''";

/**
 * Store-owned migration 0003 (A03 / F3 review): memory_entries.token_cost.
 * estimateTokens() counts UTF-16 units (JS string length) while SQLite
 * length() counts code points, so the transactional budget guard
 * under-counted non-BMP text (emoji) and could let two concurrent
 * activations exceed a scope budget. Every row now persists its exact
 * estimateTokens cost at INSERT; the in-batch guard sums token_cost.
 * Pre-0003 rows are backfilled from JS with the exact canonical cost
 * (same estimateTokens function, non-BMP included); the backfill is
 * replayed at every cold bootstrap, so a crash between the ALTER and the
 * backfill is repaired on the next start (review Sol, F3).
 */
export const STORE_MIGRATION_0003_ALTER =
  'ALTER TABLE memory_entries ADD COLUMN token_cost INTEGER';

/**
 * Store-owned migration 0004 (CR-F04, github-mcp#96): memory_entries.expires_cycle.
 * expires_rev is a revision of ONE cycle — the cycle whose append proposed (or
 * renewed) the hypothesis — and means nothing against another cycle's
 * revision. The origin cycle is persisted next to it so that expiry is only
 * ever evaluated against that cycle. ALTER and index ship in one batch
 * (atomic); the partial index serves the per-cycle expiry statement
 * (expires_cycle = ?). Pre-0004 rows keep expires_cycle NULL: their origin
 * cycle is unknown, so they are never expired automatically (no cross-cycle guess).
 */
export const STORE_MIGRATION_0004 = [
  'ALTER TABLE memory_entries ADD COLUMN expires_cycle TEXT',
  'CREATE INDEX IF NOT EXISTS idx_memory_hypothesis_expiry ON memory_entries(expires_cycle, expires_rev) WHERE expires_cycle IS NOT NULL',
];

const ENSURED = new WeakSet<object>();

function runnableStatements(sql: string): string[] {
  // Comment lines are removed BEFORE splitting: the canonical header contains
  // a ';' inside a comment (Revisions start at 1 (F3); expected_rev 0 =
  // creation.), which the previous split-on-';' turned into a bogus statement
  // (expected_rev 0 = creation.) and made every ensureSchema() throw.
  const noCommentLines = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return noCommentLines.split(';').map(part => part.trim()).filter(Boolean);
}

export async function ensureSchema(db: D1Database, force = false): Promise<void> {
  // Test pools can reuse the same D1 binding object while resetting the
  // underlying database between isolated cases. `force` bypasses the
  // process-local cache for those explicit fixture setup calls.
  if (!force && ENSURED.has(db as unknown as object)) return;
  await db.batch([
    ...runnableStatements(CANONICAL_SCHEMA_SQL).map(statement => db.prepare(statement)),
    ...STORE_INTERNAL_SCHEMA.map(statement => db.prepare(statement)),
  ]);
  // Structural idempotence: avoid depending on the exact wording of a
  // duplicate-column error, which differs between D1 and Miniflare.
  const columns = await db.prepare('PRAGMA table_info(events)').all<{ name: string }>();
  if (!columns.results.some(column => column.name === 'model_meta')) {
    await db.prepare(STORE_MIGRATION_0002).run();
  }
  const memColumns = await db.prepare('PRAGMA table_info(memory_entries)').all<{ name: string }>();
  if (!memColumns.results.some(column => column.name === 'token_cost')) {
    await db.batch([db.prepare(STORE_MIGRATION_0003_ALTER)]);
  }
  if (!memColumns.results.some(column => column.name === 'expires_cycle')) {
    await db.batch(STORE_MIGRATION_0004.map(statement => db.prepare(statement)));
  }
  // Exact backfill for pre-0003 rows (review Sol, F3): idempotent, only
  // NULL costs are touched. It is replayed at EVERY cold bootstrap, not
  // only when migration 0003 just applied: a process can die between the
  // ALTER and the backfill, and the next start sees the column but must
  // still repair the NULL rows, or those rows would keep falling back to
  // the SQLite code-point approximation forever. The cost is one probe
  // SELECT per cold bootstrap; once ENSURED caches the binding, normal
  // operations add no further database call. The JS metric counts UTF-16
  // units, so non-BMP rows get the canonical estimateTokens cost, never
  // the code-point approximation.
  const staleCosts = await db
    .prepare('SELECT id, version, text FROM memory_entries WHERE token_cost IS NULL')
    .all<{ id: string; version: number; text: string }>();
  for (const row of staleCosts.results ?? []) {
    await db
      .prepare('UPDATE memory_entries SET token_cost = ?1 WHERE id = ?2 AND version = ?3 AND token_cost IS NULL')
      .bind(estimateTokens(row.text), row.id, row.version)
      .run();
  }
  ENSURED.add(db as unknown as object);
}

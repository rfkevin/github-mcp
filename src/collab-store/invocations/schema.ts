/**
 * CC-4 A1 — store-internal invocation/outbox schema (migration 0006).
 * It stays outside the frozen canonical CC-3 schema.
 */
export const INVOCATION_SCHEMA_0006 = [
  [
    'CREATE TABLE IF NOT EXISTS invocations (',
    '  invocation_id TEXT PRIMARY KEY,',
    '  wake_key TEXT NOT NULL UNIQUE,',
    '  cycle_id TEXT NOT NULL,',
    '  task_id TEXT NOT NULL,',
    '  role TEXT NOT NULL,',
    '  principal_id TEXT NOT NULL,',
    '  endpoint_id TEXT NOT NULL,',
    '  reason TEXT NOT NULL,',
    '  source_revision INTEGER NOT NULL,',
    '  source_event_seq INTEGER NOT NULL REFERENCES events(seq),',
    '  source_event_hash TEXT NOT NULL,',
    '  input_hash TEXT NOT NULL,',
    '  payload_hash TEXT NOT NULL,',
    "  target_repository TEXT NOT NULL DEFAULT '',",
    "  target_head TEXT NOT NULL DEFAULT '',",
    "  target_base TEXT NOT NULL DEFAULT '',",
    "  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','leased','running','succeeded','failed','expired')),",
    '  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),',
    '  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),',
    '  queued_at INTEGER NOT NULL,',
    '  leased_at INTEGER,',
    '  running_at INTEGER,',
    '  finished_at INTEGER,',
    "  lease_owner TEXT NOT NULL DEFAULT '',",
    '  lease_expires_at INTEGER,',
    "  output_hash TEXT NOT NULL DEFAULT '',",
    "  output_text TEXT NOT NULL DEFAULT '',",
    "  last_error TEXT NOT NULL DEFAULT '',",
    '  usage_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_input_tokens >= 0),',
    '  usage_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_output_tokens >= 0),',
    '  usage_operations INTEGER NOT NULL DEFAULT 0 CHECK (usage_operations >= 0),',
    '  cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),',
    "  evidence_refs TEXT NOT NULL DEFAULT '[]'",
    ')',
  ].join(' '),
  'CREATE INDEX IF NOT EXISTS idx_invocations_state_lease ON invocations(state, lease_expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_invocations_cycle_task ON invocations(cycle_id, task_id)',
  [
    'CREATE TABLE IF NOT EXISTS invocation_attempts (',
    '  invocation_id TEXT NOT NULL REFERENCES invocations(invocation_id),',
    '  attempt_no INTEGER NOT NULL,',
    '  endpoint_id TEXT NOT NULL,',
    "  state TEXT NOT NULL CHECK (state IN ('leased','running','succeeded','failed','expired')),",
    '  leased_at INTEGER NOT NULL,',
    '  running_at INTEGER,',
    '  finished_at INTEGER,',
    '  input_hash TEXT NOT NULL,',
    "  output_hash TEXT NOT NULL DEFAULT '',",
    "  error TEXT NOT NULL DEFAULT '',",
    '  usage_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_input_tokens >= 0),',
    '  usage_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (usage_output_tokens >= 0),',
    '  usage_operations INTEGER NOT NULL DEFAULT 0 CHECK (usage_operations >= 0),',
    '  cost_microunits INTEGER NOT NULL DEFAULT 0 CHECK (cost_microunits >= 0),',
    "  evidence_refs TEXT NOT NULL DEFAULT '[]',",
    '  PRIMARY KEY (invocation_id, attempt_no)',
    ')',
  ].join(' '),
  'CREATE TABLE IF NOT EXISTS invocation_guard (ok INTEGER NOT NULL CHECK (ok = 1))',
] as const;


/**
 * CC-5 L0 (dette X14) : sortie conservée bornée pour le rejeu. Colonne ajoutée
 * aux D1 existants par ALTER idempotent, câblé côté store/schema.ts (0010).
 */
export const INVOCATION_MIGRATION_0010 = "ALTER TABLE invocations ADD COLUMN output_text TEXT NOT NULL DEFAULT ''";
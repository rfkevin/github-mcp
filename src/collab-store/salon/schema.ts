/**
 * CC-7 L4 — schéma interne du salon d’équipe (S6/S7).
 * Tables store-owned (jamais dans 0001_init.sql gelé). CREATE IF NOT EXISTS portable.
 */

export const SALON_CYCLE_ID = 'team-salon';

/** Migration 0012 : messages append-only + wakes + compteurs anti-bruit. */
export const STORE_MIGRATION_0012_SALON = [
  [
    'CREATE TABLE IF NOT EXISTS salon_messages (',
    '  msg_id TEXT PRIMARY KEY,',
    '  at INTEGER NOT NULL,',
    '  author_pid TEXT NOT NULL,',
    "  level TEXT NOT NULL CHECK (level IN ('info', 'decision', 'blocking')),",
    '  body TEXT NOT NULL,',
    "  task_id TEXT NOT NULL DEFAULT '',",
    "  incident_key TEXT NOT NULL DEFAULT '',",
    '  new_fact INTEGER NOT NULL DEFAULT 0,',
    '  over_quota INTEGER NOT NULL DEFAULT 0,',
    "  masked INTEGER NOT NULL DEFAULT 0",
    ')',
  ].join(' '),
  'CREATE INDEX IF NOT EXISTS idx_salon_messages_at ON salon_messages(at)',
  'CREATE INDEX IF NOT EXISTS idx_salon_messages_author_day ON salon_messages(author_pid, at)',
  [
    'CREATE TABLE IF NOT EXISTS salon_wakes (',
    '  msg_id TEXT NOT NULL,',
    '  participant_id TEXT NOT NULL,',
    '  delivered_at INTEGER,',
    '  PRIMARY KEY (msg_id, participant_id)',
    ')',
  ].join(' '),
  [
    'CREATE TABLE IF NOT EXISTS salon_day_counts (',
    '  author_pid TEXT NOT NULL,',
    '  day TEXT NOT NULL,',
    '  decision_or_blocking INTEGER NOT NULL DEFAULT 0,',
    '  PRIMARY KEY (author_pid, day)',
    ')',
  ].join(' '),
  // Garde transactionnelle (RAISE hors trigger interdit en SQLite) : ok doit rester 1.
  [
    'CREATE TABLE IF NOT EXISTS collab_store_guard (',
    '  token TEXT PRIMARY KEY,',
    '  ok INTEGER NOT NULL CHECK (ok = 1)',
    ')',
  ].join(' '),
];

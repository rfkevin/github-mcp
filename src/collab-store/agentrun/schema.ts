/**
 * CC-5 l7 (incrément 7a) — tables de l'exécution autonome des agents API.
 *
 * D1 est la source de vérité (note L7-1 v1.1, store seq 462) : l'orchestrateur
 * (Durable Object en 7b) ne garde qu'une copie de travail ; une exécution perdue
 * reprend uniquement depuis ces tables et les clés d'idempotence.
 *
 * - agent_fences : jeton de génération par clé de bail (cycle, participant, tâche),
 *   partagé par le chat et l'API (L7-4). Chaque écriture d'une exécution API
 *   revalide sa génération dans le même lot D1.
 * - agent_runs : une exécution API bornée (étapes, jetons, coût, échéance).
 * - agent_run_steps : une ligne par étape, réclamée par CAS (double réveil).
 * - agent_run_effects : effets externes intent → pending → completed | failed | ambiguous (R2).
 *
 * 7d (amendement A5 du plan de clôture v1.1) : agent_paid_steps — une ligne par étape payante,
 *   réservée au pire cas puis réglée au réel ; jamais deux réservations pour la même étape,
 *   un rejeu d’une étape réglée est refusé fail-closed.
 * 7b (plan v1.1 seq 478) :
 * - agent_run_wakeups : outbox de réveil écrite dans le même lot que createRun,
 *   livrée par CAS avec expiration, ACK après wake accepté, tentatives bornées.
 * - agent_run_alarms : prochaine alarme annoncée par l'orchestrateur ; le scan de
 *   secours s'y fie (pas à updated_at, rafraîchi par l'audit).
 * - agent_run_quota : compteurs journaliers UTC des quotas Durable Objects Free.
 * - agent_run_journal : journal append-only des décisions de l'orchestrateur et du passage.
 *
 * CC-7 L5b (S10) : agent_run_reads — journal append-only des lectures GitHub
 * réussies d'une exécution (preuve de lecture au SHA exact pour store_verdict).
 *
 * Aucune suppression : un trigger refuse DELETE sur toutes ces tables.
 */
const TABLES = [
  ['CREATE TABLE IF NOT EXISTS agent_fences (',
    '  lease_key TEXT PRIMARY KEY,',
    '  generation INTEGER NOT NULL,',
    "  holder TEXT NOT NULL CHECK (holder IN ('api','chat','none')),",
    '  held_until INTEGER NOT NULL DEFAULT 0,',
    '  updated_at INTEGER NOT NULL',
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_runs (',
    '  run_id TEXT PRIMARY KEY,',
    '  cycle_id TEXT NOT NULL,',
    '  participant_id TEXT NOT NULL,',
    "  task_id TEXT NOT NULL DEFAULT '',",
    '  lease_key TEXT NOT NULL,',
    '  generation INTEGER NOT NULL,',
    '  task_kind TEXT NOT NULL,',
    '  status TEXT NOT NULL,',
    '  steps_done INTEGER NOT NULL DEFAULT 0,',
    '  max_steps INTEGER NOT NULL,',
    '  tokens_used INTEGER NOT NULL DEFAULT 0,',
    '  max_tokens INTEGER NOT NULL,',
    '  cost_cents INTEGER NOT NULL DEFAULT 0,',
    '  max_cost_cents INTEGER NOT NULL,',
    '  deadline_at INTEGER NOT NULL,',
    '  prompt TEXT NOT NULL,',
    "  summary TEXT NOT NULL DEFAULT '',",
    "  stop_reason TEXT NOT NULL DEFAULT '',",
    '  created_at INTEGER NOT NULL,',
    '  updated_at INTEGER NOT NULL',
    ')'].join(' '),
  'CREATE INDEX IF NOT EXISTS agent_runs_lease ON agent_runs (lease_key, status)',
  ['CREATE TABLE IF NOT EXISTS agent_run_steps (',
    '  run_id TEXT NOT NULL,',
    '  n INTEGER NOT NULL,',
    '  state TEXT NOT NULL,',
    '  claimed_by TEXT NOT NULL,',
    '  claimed_at INTEGER NOT NULL,',
    '  attempts INTEGER NOT NULL,',
    '  model_output TEXT,',
    '  results TEXT,',
    '  tokens INTEGER NOT NULL DEFAULT 0,',
    '  cost_cents INTEGER NOT NULL DEFAULT 0,',
    '  completed_at INTEGER,',
    '  PRIMARY KEY (run_id, n)',
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_run_effects (',
    '  effect_key TEXT PRIMARY KEY,',
    '  run_id TEXT NOT NULL,',
    '  n INTEGER NOT NULL,',
    '  idx INTEGER NOT NULL,',
    '  tool TEXT NOT NULL,',
    '  args TEXT NOT NULL,',
    "  status TEXT NOT NULL CHECK (status IN ('intent','pending','completed','failed','ambiguous')),",
    '  result TEXT,',
    '  updated_at INTEGER NOT NULL',
    ')'].join(' '),
  'CREATE INDEX IF NOT EXISTS agent_run_effects_run ON agent_run_effects (run_id, n, idx)',
  ['CREATE TABLE IF NOT EXISTS agent_run_wakeups (',
    '  run_id TEXT PRIMARY KEY,',
    '  lease_key TEXT NOT NULL,',
    '  requested_at INTEGER NOT NULL,',
    "  status TEXT NOT NULL CHECK (status IN ('pending','delivered','failed')),",
    "  claimed_by TEXT NOT NULL DEFAULT '',",
    '  claimed_until INTEGER NOT NULL DEFAULT 0,',
    '  attempts INTEGER NOT NULL DEFAULT 0,',
    '  delivered_at INTEGER,',
    "  last_error TEXT NOT NULL DEFAULT ''",
    ')'].join(' '),
  'CREATE INDEX IF NOT EXISTS agent_run_wakeups_pending ON agent_run_wakeups (status, claimed_until)',
  ['CREATE TABLE IF NOT EXISTS agent_run_alarms (',
    '  run_id TEXT PRIMARY KEY,',
    '  lease_key TEXT NOT NULL,',
    '  next_alarm_at INTEGER,',
    '  updated_at INTEGER NOT NULL',
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_run_quota (',
    '  day TEXT NOT NULL,',
    '  kind TEXT NOT NULL,',
    '  used INTEGER NOT NULL,',
    '  PRIMARY KEY (day, kind)',
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_paid_steps (',
    '  run_id TEXT NOT NULL,',
    '  n INTEGER NOT NULL,',
    '  reserved_cents INTEGER NOT NULL,',
    '  actual_cents INTEGER NOT NULL DEFAULT 0,',
    '  settled INTEGER NOT NULL DEFAULT 0,',
    '  updated_at INTEGER NOT NULL,',
    '  PRIMARY KEY (run_id, n)',
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_run_journal (',
    '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  at INTEGER NOT NULL,',
    '  kind TEXT NOT NULL,',
    "  run_id TEXT NOT NULL DEFAULT '',",
    "  detail TEXT NOT NULL DEFAULT ''",
    ')'].join(' '),
  ['CREATE TABLE IF NOT EXISTS agent_run_reads (',
    '  effect_key TEXT PRIMARY KEY,',
    '  run_id TEXT NOT NULL,',
    '  tool TEXT NOT NULL,',
    "  ref_sha TEXT NOT NULL DEFAULT '',",
    "  status TEXT NOT NULL CHECK (status IN ('completed','failed')),",
    '  at INTEGER NOT NULL',
    ')'].join(' '),
  'CREATE INDEX IF NOT EXISTS agent_run_reads_run ON agent_run_reads (run_id)',
  // CC-8 S8a : bail anti-rafale du passage événementiel — singleton mutable (jamais dans
  // NO_DELETE) : au plus un passage événementiel par PASS_LEASE_TTL_S (wake-trigger.ts).
  ['CREATE TABLE IF NOT EXISTS agent_run_pass_lease (',
    '  id INTEGER PRIMARY KEY CHECK (id = 1),',
    '  holder TEXT NOT NULL,',
    '  expires_at INTEGER NOT NULL',
    ')'].join(' '),
  // CC8 S7 mode guidé : étapes émises par le serveur (sans modèle). Elles ne comptent pas dans max_steps.
  ['CREATE TABLE IF NOT EXISTS agent_run_server_steps (',
    '  run_id TEXT NOT NULL,',
    '  n INTEGER NOT NULL,',
    '  PRIMARY KEY (run_id, n)',
    ')'].join(' '),
  // CC8 S7 lot B R4 (#282) : publication de la preuve serveur `run.proof` d'un run terminé (reprise bornée).
  ['CREATE TABLE IF NOT EXISTS agent_run_proofs (',
    '  run_id TEXT PRIMARY KEY,',
    "  status TEXT NOT NULL CHECK (status IN ('pending','published','refused')),",
    '  attempts INTEGER NOT NULL DEFAULT 0,',
    "  reason TEXT NOT NULL DEFAULT '',",
    '  event_seq INTEGER,',
    '  updated_at INTEGER NOT NULL',
    ')'].join(' '),
  // CC8 : mandats dynamiques créés UNIQUEMENT par le coordinateur owner-approved
  // dans un périmètre owner déployé. Lignes immuables, jamais d'UPDATE/DELETE.
  ['CREATE TABLE IF NOT EXISTS api_dynamic_grants (',
    'cycle TEXT NOT NULL, task TEXT NOT NULL, participant TEXT NOT NULL,',
    'branch TEXT NOT NULL UNIQUE, paths_json TEXT NOT NULL, acceptance_json TEXT NOT NULL,',
    'created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,',
    'PRIMARY KEY(cycle,task,participant)',
    ')'].join(' '),
  // CC8 S7 lot B R5 (#282) : chaque essai de maillon d'un appel modèle — maillon choisi, maillon servi, repli.
  ['CREATE TABLE IF NOT EXISTS agent_run_model_calls (',
    '  run_id TEXT NOT NULL,',
    '  n INTEGER NOT NULL,',
    '  k INTEGER NOT NULL,',
    '  chosen_ref TEXT NOT NULL,',
    '  ref TEXT NOT NULL,',
    '  ok INTEGER NOT NULL,',
    "  failure TEXT NOT NULL DEFAULT '',",
    '  latency_ms INTEGER NOT NULL,',
    '  at INTEGER NOT NULL,',
    '  PRIMARY KEY (run_id, n, k)',
    ')'].join(' '),
];

const NO_DELETE = ['agent_fences', 'agent_runs', 'agent_run_steps', 'agent_run_effects', 'agent_run_wakeups',
  'agent_run_alarms', 'agent_run_quota', 'agent_paid_steps', 'agent_run_journal', 'agent_run_reads', 'agent_run_server_steps',
  'agent_run_proofs', 'agent_run_model_calls', 'api_dynamic_grants'].map(table =>
  'CREATE TRIGGER IF NOT EXISTS ' + table + '_no_delete BEFORE DELETE ON ' + table
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END");

const DYNAMIC_GRANTS_APPEND_ONLY = "CREATE TRIGGER IF NOT EXISTS api_dynamic_grants_no_update BEFORE UPDATE ON api_dynamic_grants BEGIN SELECT RAISE(ABORT, 'append-only'); END";

const JOURNAL_APPEND_ONLY = "CREATE TRIGGER IF NOT EXISTS agent_run_journal_no_update BEFORE UPDATE ON agent_run_journal"
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END";

const SERVER_STEPS_APPEND_ONLY = "CREATE TRIGGER IF NOT EXISTS agent_run_server_steps_no_update BEFORE UPDATE ON agent_run_server_steps"
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END";

const MODEL_CALLS_APPEND_ONLY = "CREATE TRIGGER IF NOT EXISTS agent_run_model_calls_no_update BEFORE UPDATE ON agent_run_model_calls"
  + " BEGIN SELECT RAISE(ABORT, 'append-only'); END";

// Une preuve publiée ou refusée est définitive ; seule une ligne `pending` évolue.
const PROOFS_FINAL = "CREATE TRIGGER IF NOT EXISTS agent_run_proofs_final BEFORE UPDATE ON agent_run_proofs"
  + " WHEN OLD.status <> 'pending' OR NEW.run_id <> OLD.run_id BEGIN SELECT RAISE(ABORT, 'append-only'); END";

export async function ensureAgentRunSchema(db: D1Database): Promise<void> {
  await db.batch([...TABLES, ...NO_DELETE, DYNAMIC_GRANTS_APPEND_ONLY, JOURNAL_APPEND_ONLY, SERVER_STEPS_APPEND_ONLY, MODEL_CALLS_APPEND_ONLY, PROOFS_FINAL].map(sql => db.prepare(sql)));
}

/**
 * CC-5 L3b — bail d'agent API (fencing lease).
 *
 * Un seul passage agent par (cycle, participant, task) à la fois.
 * Table interne hors schéma canonique (comme controller_decisions).
 * UPDATE/DELETE refusés : fin de bail = nouvelle ligne expired, jamais mutée.
 */
import { AgentDenied } from './persona';

const INIT = [
  'CREATE TABLE IF NOT EXISTS agent_leases (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  cycle_id TEXT NOT NULL,',
  '  participant_id TEXT NOT NULL,',
  '  task_id TEXT NOT NULL DEFAULT \'\',',
  '  lease_key TEXT NOT NULL UNIQUE,',
  '  worker_id TEXT NOT NULL,',
  '  expires_at INTEGER NOT NULL,',
  '  status TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ')',
].join(' ');

const NO_UPDATE = [
  'CREATE TRIGGER IF NOT EXISTS agent_leases_append_only_u',
  "BEFORE UPDATE ON agent_leases BEGIN SELECT RAISE(ABORT, 'append-only'); END",
].join(' ');

const NO_DELETE = [
  'CREATE TRIGGER IF NOT EXISTS agent_leases_append_only_d',
  "BEFORE DELETE ON agent_leases BEGIN SELECT RAISE(ABORT, 'append-only'); END",
].join(' ');

export async function ensureAgentLeaseSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(INIT),
    db.prepare(NO_UPDATE),
    db.prepare(NO_DELETE),
    db.prepare('CREATE INDEX IF NOT EXISTS agent_leases_cycle ON agent_leases (cycle_id, participant_id, id)'),
  ]);
}

function leaseKey(cycleId: string, participantId: string, taskId: string): string {
  return [cycleId, participantId, taskId || '~'].join('\u001f');
}

export interface AgentLease {
  lease_key: string;
  worker_id: string;
  expires_at: number;
}

/**
 * Acquiert un bail actif. Si un bail non expiré existe déjà pour la clé,
 * refuse (AGENT_LEASE_HELD). Sinon insère une ligne status=active.
 */
export async function acquireAgentLease(db: D1Database, input: {
  cycleId: string;
  participantId: string;
  taskId?: string;
  workerId: string;
  ttlSeconds?: number;
  now?: number;
}): Promise<AgentLease> {
  await ensureAgentLeaseSchema(db);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? 120, 30), 600);
  const key = leaseKey(input.cycleId, input.participantId, input.taskId ?? '');
  const held = await db.prepare([
    "SELECT lease_key, worker_id, expires_at FROM agent_leases",
    "WHERE lease_key = ?1 AND status = 'active' AND expires_at > ?2",
    'ORDER BY id DESC LIMIT 1',
  ].join(' ')).bind(key, now).first<{ lease_key: string; worker_id: string; expires_at: number }>();
  if (held) throw new AgentDenied('agent_lease_held');
  const expiresAt = now + ttl;
  await db.prepare([
    'INSERT INTO agent_leases (cycle_id, participant_id, task_id, lease_key, worker_id, expires_at, status, created_at)',
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)",
  ].join(' ')).bind(
    input.cycleId, input.participantId, input.taskId ?? '', key,
    input.workerId, expiresAt, now,
  ).run();
  return { lease_key: key, worker_id: input.workerId, expires_at: expiresAt };
}

/** Marque le bail expiré par une nouvelle ligne (append-only) — le dernier status gagne. */
export async function releaseAgentLease(db: D1Database, input: {
  cycleId: string;
  participantId: string;
  taskId?: string;
  workerId: string;
  now?: number;
}): Promise<void> {
  await ensureAgentLeaseSchema(db);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const key = leaseKey(input.cycleId, input.participantId, input.taskId ?? '');
  await db.prepare([
    'INSERT INTO agent_leases (cycle_id, participant_id, task_id, lease_key, worker_id, expires_at, status, created_at)',
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'released', ?7)",
  ].join(' ')).bind(
    input.cycleId, input.participantId, input.taskId ?? '', key,
    input.workerId, now, now,
  ).run();
}

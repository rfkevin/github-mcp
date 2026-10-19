/**
 * CC-5 L3b — bail d'agent API (fencing lease).
 *
 * Un seul passage agent actif par (cycle, participant, task).
 * Table interne hors schéma canonique (comme controller_decisions).
 * DELETE refusé. UPDATE limité à la transition terminale active→released
 * (nécessaire pour un index unique partiel réutilisable ; revue Vibe B1).
 * Preview non déployée : CREATE TABLE sans UNIQUE colonne ; index partiel
 * WHERE status = 'active' garantit l'unicité du bail actif et ferme la
 * course SELECT→INSERT entre acquires concurrents.
 */
import { AgentDenied } from './persona';

const INIT = [
  'CREATE TABLE IF NOT EXISTS agent_leases (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  cycle_id TEXT NOT NULL,',
  '  participant_id TEXT NOT NULL,',
  '  task_id TEXT NOT NULL DEFAULT \'\',',
  '  lease_key TEXT NOT NULL,',
  '  worker_id TEXT NOT NULL,',
  '  expires_at INTEGER NOT NULL,',
  '  status TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ')',
].join(' ');

/** Seule mutation autorisée : active → released (mêmes clés métier). */
const TERMINAL_UPDATE = [
  'CREATE TRIGGER IF NOT EXISTS agent_leases_terminal_u BEFORE UPDATE ON agent_leases BEGIN',
  "  SELECT RAISE(ABORT, 'append-only') WHERE NOT (",
  "    OLD.status = 'active' AND NEW.status = 'released'",
  '    AND OLD.lease_key = NEW.lease_key',
  '    AND OLD.cycle_id = NEW.cycle_id',
  '    AND OLD.participant_id = NEW.participant_id',
  '    AND OLD.task_id = NEW.task_id',
  '    AND OLD.worker_id = NEW.worker_id',
  '    AND OLD.created_at = NEW.created_at',
  '  );',
  'END',
].join(' ');

const NO_DELETE = [
  'CREATE TRIGGER IF NOT EXISTS agent_leases_append_only_d',
  "BEFORE DELETE ON agent_leases BEGIN SELECT RAISE(ABORT, 'append-only'); END",
].join(' ');

const ACTIVE_UNIQUE = [
  'CREATE UNIQUE INDEX IF NOT EXISTS agent_leases_active',
  "ON agent_leases (lease_key) WHERE status = 'active'",
].join(' ');

export async function ensureAgentLeaseSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(INIT),
    db.prepare(TERMINAL_UPDATE),
    db.prepare(NO_DELETE),
    db.prepare(ACTIVE_UNIQUE),
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
 * refuse (agent_lease_held). Sinon INSERT status=active — l'index unique
 * partiel refuse un second actif concurrent (course SELECT→INSERT).
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
  // Bail actif expiré : libérer la place avant INSERT (index unique partiel).
  await db.prepare([
    "UPDATE agent_leases SET status = 'released', expires_at = ?2",
    "WHERE lease_key = ?1 AND status = 'active' AND expires_at <= ?2",
  ].join(' ')).bind(key, now).run();
  const expiresAt = now + ttl;
  try {
    await db.prepare([
      'INSERT INTO agent_leases (cycle_id, participant_id, task_id, lease_key, worker_id, expires_at, status, created_at)',
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7)",
    ].join(' ')).bind(
      input.cycleId, input.participantId, input.taskId ?? '', key,
      input.workerId, expiresAt, now,
    ).run();
  } catch (error) {
    // Uniquement la course sur l'index unique partiel → held ; le reste remonte.
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE|constraint/i.test(message)) throw new AgentDenied('agent_lease_held');
    throw error;
  }
  return { lease_key: key, worker_id: input.workerId, expires_at: expiresAt };
}

/**
 * Libère le bail actif du worker : transition terminale active→released
 * (seule UPDATE autorisée par trigger). Ré-acquisition ensuite possible.
 */
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
  const result = await db.prepare([
    "UPDATE agent_leases SET status = 'released', expires_at = ?3",
    "WHERE lease_key = ?1 AND status = 'active' AND worker_id = ?2",
  ].join(' ')).bind(key, input.workerId, now).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new AgentDenied('agent_lease_not_held');
  }
}

/**
 * CC-7 L4 — salon d’équipe (plan CC-PLAN-7 v0.2, S6/S7).
 *
 * Cycle permanent team-salon append-only. Niveaux info | decision | blocking.
 * Anti-bruit : ≤3 decision/blocking par participant et par jour UTC ; un seul
 * par incident_key sans fait nouveau. Exception de sûreté : blocking + new_fact
 * jamais refusé ; au-delà du quota → accepté, over_quota=1 (digest Kevin).
 * Réveil unique par (msg_id, participant). HALT coupe les écritures.
 * Porte SALON_ENABLED === 'true' exact ; sinon refus SALON_DISABLED.
 */
import { ensureSchema } from '../store/schema';
import { STORE_MIGRATION_0012_SALON, SALON_CYCLE_ID } from './schema';

export { SALON_CYCLE_ID } from './schema';

export const SALON_DAILY_LIMIT = 3;
export const SALON_BODY_MAX = 2000;
export type SalonLevel = 'info' | 'decision' | 'blocking';

export class SalonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SalonError';
  }
}

export function salonEnabled(env: { SALON_ENABLED?: string } | undefined): boolean {
  return env?.SALON_ENABLED === 'true';
}

function dayKey(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

function msgIdOf(authorPid: string, now: number, body: string): string {
  // Deterministic-ish id without crypto import; uniqueness by author+now+prefix.
  const prefix = body.slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '_');
  return 'sm:' + authorPid + ':' + now + ':' + prefix.slice(0, 16);
}

async function ensureSalonSchema(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch(STORE_MIGRATION_0012_SALON.map(s => db.prepare(s)));
}

async function haltActive(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(
      "SELECT 1 AS ok FROM halt_state WHERE active = 1 LIMIT 1",
    ).first<{ ok: number }>();
    return !!row;
  } catch {
    // Table absente sur bases minimales de test : pas de HALT.
    return false;
  }
}

export interface PostSalonInput {
  authorPid: string;
  level: SalonLevel;
  body: string;
  taskId?: string;
  incidentKey?: string;
  newFact?: boolean;
  now: number;
  /** Liste des participants à réveiller (hors auteur). */
  wakeParticipants?: string[];
}

export interface PostSalonResult {
  msg_id: string;
  at: number;
  over_quota: boolean;
}

export async function postSalonMessage(
  db: D1Database,
  env: { SALON_ENABLED?: string } | undefined,
  input: PostSalonInput,
): Promise<PostSalonResult> {
  if (!salonEnabled(env)) {
    throw new SalonError('SALON_DISABLED', 'Salon éteint (SALON_ENABLED !== true).');
  }
  if (!input.authorPid || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.authorPid)) {
    throw new SalonError('SALON_AUTHOR_INVALID', 'Auteur invalide.');
  }
  if (input.level !== 'info' && input.level !== 'decision' && input.level !== 'blocking') {
    throw new SalonError('SALON_LEVEL_INVALID', 'level : info, decision ou blocking.');
  }
  const body = (input.body ?? '').trim();
  if (!body || body.length > SALON_BODY_MAX) {
    throw new SalonError('SALON_BODY_INVALID', 'Corps 1–' + SALON_BODY_MAX + ' caractères.');
  }
  if (input.level === 'blocking' && !(input.taskId && input.taskId.trim())) {
    throw new SalonError('SALON_TASK_REQUIRED', 'blocking exige task_id.');
  }
  await ensureSalonSchema(db);
  if (await haltActive(db)) {
    throw new SalonError('SALON_HALT', 'HALT actif : aucune écriture salon.');
  }

  const day = dayKey(input.now);
  const countsAsQuota = input.level === 'decision' || input.level === 'blocking';
  const newFact = input.newFact === true;
  const incidentKey = (input.incidentKey ?? '').trim().slice(0, 128);

  // Un seul message par incident sans fait nouveau (decision/blocking).
  if (countsAsQuota && incidentKey && !newFact) {
    const prior = await db.prepare(
      'SELECT msg_id FROM salon_messages WHERE author_pid = ?1 AND incident_key = ?2 AND new_fact = 0 LIMIT 1',
    ).bind(input.authorPid, incidentKey).first<{ msg_id: string }>();
    if (prior) {
      throw new SalonError('SALON_INCIDENT_DUP', 'Un message sans fait nouveau existe déjà pour cet incident.');
    }
  }

  let overQuota = false;
  if (countsAsQuota) {
    const row = await db.prepare(
      'SELECT decision_or_blocking AS n FROM salon_day_counts WHERE author_pid = ?1 AND day = ?2',
    ).bind(input.authorPid, day).first<{ n: number }>();
    const n = row?.n ?? 0;
    if (n >= SALON_DAILY_LIMIT) {
      // Exception de sûreté S7 : blocking + new_fact jamais refusé.
      if (input.level === 'blocking' && newFact) {
        overQuota = true;
      } else {
        throw new SalonError('SALON_DAILY_LIMIT', 'Quota journalier de ' + SALON_DAILY_LIMIT + ' decision/blocking atteint.');
      }
    }
  }

  const msgId = msgIdOf(input.authorPid, input.now, body);
  const taskId = (input.taskId ?? '').trim().slice(0, 64);

  // Lot unique : message + compteur + wakes.
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      'INSERT INTO salon_messages (msg_id, at, author_pid, level, body, task_id, incident_key, new_fact, over_quota, masked) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0)',
    ).bind(msgId, input.now, input.authorPid, input.level, body, taskId, incidentKey, newFact ? 1 : 0, overQuota ? 1 : 0),
  ];
  if (countsAsQuota) {
    stmts.push(
      db.prepare(
        'INSERT INTO salon_day_counts (author_pid, day, decision_or_blocking) VALUES (?1,?2,1) ON CONFLICT(author_pid, day) DO UPDATE SET decision_or_blocking = decision_or_blocking + 1',
      ).bind(input.authorPid, day),
    );
  }
  const wakes = (input.wakeParticipants ?? []).filter(p => p && p !== input.authorPid);
  for (const pid of wakes) {
    stmts.push(
      db.prepare(
        'INSERT OR IGNORE INTO salon_wakes (msg_id, participant_id, delivered_at) VALUES (?1,?2,NULL)',
      ).bind(msgId, pid),
    );
  }
  await db.batch(stmts);
  return { msg_id: msgId, at: input.now, over_quota: overQuota };
}

export interface SalonMessageRow {
  msg_id: string;
  at: number;
  author_pid: string;
  level: SalonLevel;
  body: string;
  task_id: string;
  incident_key: string;
  new_fact: number;
  over_quota: number;
  masked: number;
}

export async function listSalonMessages(
  db: D1Database,
  opts: { sinceAt?: number; limit?: number } = {},
): Promise<SalonMessageRow[]> {
  await ensureSalonSchema(db);
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const since = opts.sinceAt ?? 0;
  const rows = await db.prepare(
    'SELECT msg_id, at, author_pid, level, body, task_id, incident_key, new_fact, over_quota, masked FROM salon_messages WHERE at > ?1 AND masked = 0 ORDER BY at ASC LIMIT ?2',
  ).bind(since, limit).all<SalonMessageRow>();
  return rows.results ?? [];
}

/** Marque le réveil livré (idempotent). Un seul par (msg, participant). */
export async function ackSalonWake(
  db: D1Database,
  msgId: string,
  participantId: string,
  now: number,
): Promise<{ ok: true; already: boolean } | { ok: false; reason: string }> {
  await ensureSalonSchema(db);
  const row = await db.prepare(
    'SELECT delivered_at FROM salon_wakes WHERE msg_id = ?1 AND participant_id = ?2',
  ).bind(msgId, participantId).first<{ delivered_at: number | null }>();
  if (!row) return { ok: false, reason: 'unknown_wake' };
  if (row.delivered_at != null) return { ok: true, already: true };
  await db.prepare(
    'UPDATE salon_wakes SET delivered_at = ?1 WHERE msg_id = ?2 AND participant_id = ?3 AND delivered_at IS NULL',
  ).bind(now, msgId, participantId).run();
  return { ok: true, already: false };
}

export async function pendingSalonWakes(
  db: D1Database,
  participantId: string,
  limit = 20,
): Promise<Array<{ msg_id: string; at: number; level: string; body: string; author_pid: string }>> {
  await ensureSalonSchema(db);
  const rows = await db.prepare(
    `SELECT w.msg_id, m.at, m.level, m.body, m.author_pid
     FROM salon_wakes w JOIN salon_messages m ON m.msg_id = w.msg_id
     WHERE w.participant_id = ?1 AND w.delivered_at IS NULL AND m.masked = 0
     ORDER BY m.at ASC LIMIT ?2`,
  ).bind(participantId, Math.min(limit, 40)).all<{ msg_id: string; at: number; level: string; body: string; author_pid: string }>();
  return rows.results ?? [];
}

/** Masquage soft (modération) — n’efface jamais. */
export async function maskSalonMessage(db: D1Database, msgId: string): Promise<boolean> {
  await ensureSalonSchema(db);
  const r = await db.prepare('UPDATE salon_messages SET masked = 1 WHERE msg_id = ?1 AND masked = 0').bind(msgId).run();
  return (r.meta?.changes ?? 0) > 0;
}

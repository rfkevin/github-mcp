/**
 * CC-7 L12 (demande de Kevin du 2026-10-30) — un seul travailleur actif par agent, chat ou API.
 *
 * Constats du jour : (1) le planificateur créait une exécution API « answer » pour une question
 * adressée même quand le chat du même agent traitait déjà cette question (le bail chat est par
 * tâche, une réponse n'a pas de tâche) ; (2) une session chat interrompue a laissé des commits sans
 * trace et la session suivante ne savait pas qu'un travail était en cours.
 *
 * Trois lectures, toutes en lecture seule, bornées et limitées au participant (identités
 * équivalentes #126 comprises, jamais un autre participant — CR-C) :
 * - chatActiveWithin : le chat de l'agent a-t-il écrit (rôle ≠ api-agent) dans la fenêtre, sur le
 *   cycle ou sur une tâche donnée ? Fenêtre GLISSANTE : un chat planté ne bloque jamais l'API
 *   au-delà de CHAT_ACTIVE_SECONDS ;
 * - concurrentSession : un autre session_id du même agent a-t-il écrit sur la même tâche il y a
 *   moins de CONCURRENT_SESSION_SECONDS ? Avertissement non bloquant (session_id reste facultatif) ;
 * - loadActiveWork : dernière écriture chat, exécutions API ouvertes et derniers checkpoints par tâche,
 *   pour qu'une nouvelle session reprenne au lieu de recommencer.
 */
import { ensureSchema } from '../store/schema';

/** Fenêtre d'activité du chat : même durée que le bail chat par défaut (CHAT_HOLD_SECONDS_DEFAULT, l7e). */
export const CHAT_ACTIVE_SECONDS = 900;
/** Fenêtre de détection de deux sessions chat du même agent sur la même tâche. */
export const CONCURRENT_SESSION_SECONDS = 1800;
export const ACTIVE_WORK_MAX_CHECKPOINTS = 5;
export const ACTIVE_WORK_MAX_RUNS = 5;
export const ACTIVE_WORK_SUMMARY_CHARS = 600;

/** Événements écrits par le serveur ou le propriétaire : jamais une trace d'activité du chat. */
const NON_CHAT_TYPES = "('owner.decision', 'phase.advance')";

/** Tâche portée par un payload : `task` texte ou `task.task_id` (task.status, task.claim…) ; sinon null. */
export function taskOfPayload(payloadJson: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const task = (payload as Record<string, unknown>).task;
  if (typeof task === 'string' && task.trim()) return task.trim().slice(0, 64);
  if (task && typeof task === 'object' && !Array.isArray(task)) {
    const id = (task as Record<string, unknown>).task_id;
    if (typeof id === 'string' && id.trim()) return id.trim().slice(0, 64);
  }
  return null;
}

/** Prédicat SQL « l'événement porte cette tâche » (texte ou objet task.task_id). */
const TASK_MATCH = "(json_extract(payload_json, '$.task') = ?T OR json_extract(payload_json, '$.task.task_id') = ?T)";

function participantsIn(ids: readonly string[], first: number): string {
  return ids.map((_, index) => '?' + (first + index)).join(',');
}

export interface ChatWrite {
  seq: number;
  at: number;
  type: string;
  session_id: string;
  task: string | null;
}

/**
 * Dernière écriture du chat (rôle ≠ api-agent) des identités `ids` dans le cycle, éventuellement
 * restreinte à une tâche et à une borne de temps ; null = aucune.
 */
export async function lastChatWrite(db: D1Database, cycleId: string, ids: readonly string[],
  options: { taskId?: string | null; sinceAt?: number; beforeSeq?: number } = {}): Promise<ChatWrite | null> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return null;
  const binds: unknown[] = [cycleId, ...unique];
  const clauses = [
    'cycle_id = ?1', 'participant_id IN (' + participantsIn(unique, 2) + ')',
    "COALESCE(role, '') <> 'api-agent'", 'type NOT IN ' + NON_CHAT_TYPES, 'json_valid(payload_json)',
  ];
  if (options.taskId) {
    binds.push(options.taskId);
    clauses.push(TASK_MATCH.replace(/\?T/g, '?' + binds.length));
  }
  if (options.sinceAt !== undefined) {
    binds.push(options.sinceAt);
    clauses.push('at >= ?' + binds.length);
  }
  if (options.beforeSeq !== undefined) {
    binds.push(options.beforeSeq);
    clauses.push('seq < ?' + binds.length);
  }
  const row = await db.prepare('SELECT seq, at, type, session_id, payload_json FROM events WHERE '
    + clauses.join(' AND ') + ' ORDER BY seq DESC LIMIT 1').bind(...binds)
    .first<{ seq: number; at: number; type: string; session_id: string | null; payload_json: string }>();
  if (!row) return null;
  return { seq: row.seq, at: row.at, type: row.type, session_id: row.session_id ?? '', task: taskOfPayload(row.payload_json) };
}

/**
 * Le chat de l'agent est-il actif ? Écriture non API depuis moins de CHAT_ACTIVE_SECONDS, sur le
 * cycle (taskId null) ou sur cette tâche. Fenêtre glissante : jamais un blocage définitif.
 */
export async function chatActiveWithin(db: D1Database, cycleId: string, ids: readonly string[], now: number,
  taskId: string | null = null, windowSeconds = CHAT_ACTIVE_SECONDS): Promise<boolean> {
  return (await lastChatWrite(db, cycleId, ids, { taskId, sinceAt: now - windowSeconds })) !== null;
}

export interface ConcurrentSession {
  /** Session qui a écrit juste avant sur la même tâche (jamais celle de l'appelant). */
  other_session_id: string;
  seq: number;
  at: number;
  task: string;
}

/**
 * Avertissement de session concurrente pour un événement qui vient d'être écrit : une AUTRE session
 * nommée du même agent a écrit sur la même tâche il y a moins de CONCURRENT_SESSION_SECONDS.
 * Sans session_id ou sans tâche : null (aucun faux positif). Non bloquant par construction.
 */
export async function concurrentSession(db: D1Database, event: { cycle_id: string; seq: number; at: number;
  session_id: string; role: string; payload_json: string }, ids: readonly string[]): Promise<ConcurrentSession | null> {
  const sessionId = event.session_id.trim();
  if (!sessionId || event.role === 'api-agent') return null;
  const task = taskOfPayload(event.payload_json);
  if (!task) return null;
  const previous = await lastChatWrite(db, event.cycle_id, ids,
    { taskId: task, sinceAt: event.at - CONCURRENT_SESSION_SECONDS, beforeSeq: event.seq });
  if (!previous || !previous.session_id || previous.session_id === sessionId) return null;
  return { other_session_id: previous.session_id, seq: previous.seq, at: previous.at, task };
}

export interface ActiveWork {
  /** Dernière écriture du chat de l'agent dans ce cycle (null = jamais). */
  last_chat_write: ChatWrite | null;
  /** Exécutions API encore ouvertes de l'agent dans ce cycle (running / needs_reconcile). */
  open_api_runs: Array<{ run_id: string; task_id: string; task_kind: string; status: string; updated_at: number }>;
  /** Derniers checkpoints de l'agent, un par tâche, du plus récent au plus ancien. */
  last_checkpoints: Array<{ task: string | null; seq: number; at: number; channel: 'api' | 'chat'; summary: string }>;
  truncated: { open_api_runs: boolean; last_checkpoints: boolean };
}

async function agentRunsTableExists(db: D1Database): Promise<boolean> {
  return !!(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").first<{ name: string }>());
}

function checkpointSummary(payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const parts = [payload.state, payload.summary, payload.todo, payload.done].filter(part => typeof part === 'string' && part.trim());
    return (parts as string[]).join(' — ').slice(0, ACTIVE_WORK_SUMMARY_CHARS);
  } catch {
    return '';
  }
}

/** Travail en cours de l'agent dans le cycle (lecture seule, bornée, limitée à ses identités). */
export async function loadActiveWork(db: D1Database, cycleId: string, ids: readonly string[]): Promise<ActiveWork> {
  await ensureSchema(db);
  const unique = [...new Set(ids)].filter(Boolean);
  const empty: ActiveWork = { last_chat_write: null, open_api_runs: [], last_checkpoints: [], truncated: { open_api_runs: false, last_checkpoints: false } };
  if (unique.length === 0) return empty;
  const placeholders = participantsIn(unique, 2);

  const lastWrite = await lastChatWrite(db, cycleId, unique);

  const { results: checkpointRows } = await db.prepare([
    'SELECT seq, at, role, payload_json FROM events WHERE cycle_id = ?1 AND participant_id IN (' + placeholders + ')',
    "AND type = 'checkpoint' AND json_valid(payload_json) ORDER BY seq DESC LIMIT 50",
  ].join(' ')).bind(cycleId, ...unique).all<{ seq: number; at: number; role: string | null; payload_json: string }>();
  const seenTasks = new Set<string>();
  const checkpoints: ActiveWork['last_checkpoints'] = [];
  let checkpointsTruncated = false;
  for (const row of checkpointRows) {
    const task = taskOfPayload(row.payload_json);
    const key = task ?? '';
    if (seenTasks.has(key)) continue;
    seenTasks.add(key);
    if (checkpoints.length >= ACTIVE_WORK_MAX_CHECKPOINTS) {
      checkpointsTruncated = true;
      break;
    }
    checkpoints.push({ task, seq: row.seq, at: row.at, channel: row.role === 'api-agent' ? 'api' : 'chat', summary: checkpointSummary(row.payload_json) });
  }

  let runs: ActiveWork['open_api_runs'] = [];
  if (await agentRunsTableExists(db)) {
    const { results } = await db.prepare([
      'SELECT run_id, task_id, task_kind, status, updated_at FROM agent_runs',
      'WHERE cycle_id = ?1 AND participant_id IN (' + placeholders + ") AND status IN ('running', 'needs_reconcile')",
      'ORDER BY updated_at DESC, run_id LIMIT ' + (ACTIVE_WORK_MAX_RUNS + 1),
    ].join(' ')).bind(cycleId, ...unique).all<ActiveWork['open_api_runs'][number]>();
    runs = results;
  }

  return {
    last_chat_write: lastWrite,
    open_api_runs: runs.slice(0, ACTIVE_WORK_MAX_RUNS),
    last_checkpoints: checkpoints,
    truncated: { open_api_runs: runs.length > ACTIVE_WORK_MAX_RUNS, last_checkpoints: checkpointsTruncated },
  };
}

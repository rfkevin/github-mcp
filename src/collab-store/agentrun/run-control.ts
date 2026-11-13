/**
 * CC8 — steering conversationnel et arrêt ciblé d'une WorkSession.
 *
 * Les messages sont persistés en D1 et injectés à la prochaine frontière
 * d'étape modèle. Aucun second run n'est créé. Une interruption ciblée clôt
 * uniquement le run désigné et fence les effets de son ancienne génération.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureAgentRunSchema } from './schema';

export interface RunControlTarget {
  run_id: string; cycle_id: string; participant_id: string; task_id: string;
  lease_key: string; generation: number; status: string; stop_reason: string;
}

export async function runControlTarget(db: D1Database, runId: string): Promise<RunControlTarget | null> {
  await ensureAgentRunSchema(db);
  return db.prepare(
    'SELECT run_id,cycle_id,participant_id,task_id,lease_key,generation,status,stop_reason FROM agent_runs WHERE run_id=?1',
  ).bind(runId).first<RunControlTarget>();
}

/** Les écritures de contrôle sont autorisées même pendant HALT : aucun modèle n'est appelé. */
export async function steerAgentRun(db: D1Database, input: {
  runId: string; sender: string; opId: string; message: string; now: number;
}): Promise<{ status: 'queued' | 'duplicate'; run_id: string }> {
  await ensureAgentRunSchema(db);
  const message = input.message.trim();
  if (!message || message.length > 4_000) {
    throw new CollabStoreError('RUN_MESSAGE_INVALID', 'Un message de 1 à 4000 caractères est requis.');
  }
  if (!input.opId || input.opId.length > 253) {
    throw new CollabStoreError('INVALID_OP_ID', 'Identifiant de message idempotent requis.');
  }
  const inserted = await db.prepare([
    'INSERT OR IGNORE INTO agent_run_messages (run_id,op_id,sender_pid,body,created_at)',
    'SELECT r.run_id,?2,?3,?4,?5 FROM agent_runs r',
    "WHERE r.run_id=?1 AND r.status='running'",
  ].join(' ')).bind(input.runId,input.opId,input.sender,message,input.now).run();
  if (inserted.meta.changes === 1) return { status: 'queued', run_id: input.runId };
  const old = await db.prepare(
    'SELECT sender_pid,body FROM agent_run_messages WHERE run_id=?1 AND op_id=?2',
  ).bind(input.runId,input.opId).first<{ sender_pid: string; body: string }>();
  if (old) {
    if (old.sender_pid !== input.sender || old.body !== message) {
      throw new CollabStoreError('IDEMPOTENCY_CONFLICT', 'Identifiant déjà utilisé pour un autre message.');
    }
    return { status: 'duplicate', run_id: input.runId };
  }
  throw new CollabStoreError('RUN_NOT_RUNNING', 'Le run est introuvable ou déjà terminé ; aucun nouveau run créé.');
}

export interface DeliveredSteer { delivered_step: number; sender_pid: string; body: string; message_id: number }

/**
 * Claim D1 : les messages en attente sont attachés à l'étape AVANT l'appel modèle.
 * Crash/retry de la même étape => même liste, même ordre. Un message arrivé pendant
 * l'appel restera en attente et sera livré au prochain appel du même run.
 */
export async function claimSteeringMessages(db: D1Database, input: {
  runId: string; step: number; worker: string; attempts: number;
}): Promise<{ live: boolean; messages: DeliveredSteer[] }> {
  const guard = [
    "EXISTS (SELECT 1 FROM agent_runs r JOIN agent_fences f ON f.lease_key=r.lease_key",
    " JOIN agent_run_steps s ON s.run_id=r.run_id AND s.n=?2",
    " WHERE r.run_id=?1 AND r.status='running' AND f.holder='api'",
    " AND f.generation=r.generation AND s.claimed_by=?3 AND s.attempts=?4",
    " AND s.state <> 'completed')",
    "AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name='halt' AND value='1')",
  ].join(' ');
  const live = await db.prepare('SELECT 1 AS ok WHERE ' + guard)
    .bind(input.runId,input.step,input.worker,input.attempts).first<{ ok: number }>();
  if (!live) return { live: false, messages: [] };
  await db.prepare('UPDATE agent_run_messages SET delivered_step=?2 WHERE run_id=?1 AND delivered_step IS NULL AND ' + guard)
    .bind(input.runId,input.step,input.worker,input.attempts).run();
  const result = await db.prepare(
    'SELECT message_id,delivered_step,sender_pid,body FROM agent_run_messages WHERE run_id=?1 AND delivered_step<=?2 ORDER BY delivered_step,message_id',
  ).bind(input.runId,input.step).all<DeliveredSteer>();
  return { live: true, messages: result.results };
}

/** Arrêt terminal individuel : n'écrit ni owner_flags ni le statut des autres runs. */
export async function stopAgentRun(db: D1Database, input: {
  runId: string; sender: string; reason: string; now: number;
}): Promise<{ status: 'stopped' | 'already_stopped'; run_id: string }> {
  await ensureAgentRunSchema(db);
  const run = await runControlTarget(db,input.runId);
  if (!run) throw new CollabStoreError('RUN_UNKNOWN', 'Exécution inconnue.');
  if (run.status === 'halted' && run.stop_reason.startsWith('individual_stop:')) {
    return { status: 'already_stopped', run_id: input.runId };
  }
  if (run.status !== 'running') throw new CollabStoreError('RUN_NOT_RUNNING', 'Exécution déjà terminée.');
  const reason = input.reason.trim().slice(0, 300) || 'arrêt demandé';
  const stopReason = 'individual_stop:' + reason;
  const [stopped] = await db.batch([
    db.prepare("UPDATE agent_runs SET status='halted',stop_reason=?2,updated_at=?3 WHERE run_id=?1 AND status='running'")
      .bind(input.runId,stopReason,input.now),
    // Invalidates the in-flight API worker but cannot affect another participant/lease.
    db.prepare([
      "UPDATE agent_fences SET generation=generation+1,holder='none',held_until=0,updated_at=?4",
      "WHERE lease_key=?1 AND generation=?2 AND holder='api'",
      "AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id=?3 AND lease_key=?1",
      "AND generation=?2 AND status='halted' AND stop_reason=?5)",
    ].join(' ')).bind(run.lease_key,run.generation,input.runId,input.now,stopReason),
    db.prepare([
      "INSERT INTO agent_run_journal (at,kind,run_id,detail)",
      "SELECT ?2,'individual_stop',?1,?3 WHERE EXISTS",
      "(SELECT 1 FROM agent_runs WHERE run_id=?1 AND status='halted' AND stop_reason=?4)",
    ].join(' ')).bind(input.runId,input.now,input.sender.slice(0,128),stopReason),
  ]);
  if (stopped.meta.changes !== 1) {
    const current = await runControlTarget(db,input.runId);
    if (current?.stop_reason.startsWith('individual_stop:')) return { status: 'already_stopped', run_id: input.runId };
    throw new CollabStoreError('RUN_NOT_RUNNING', 'L’exécution a changé avant l’arrêt.');
  }
  return { status: 'stopped', run_id: input.runId };
}

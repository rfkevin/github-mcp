/** S8b: bounded supervision on the existing controller pass; proposals only. */
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { ensureSchema } from '../store/schema';
import { sha256Hex } from '../store/hash';
import { HALT_ACTIVE_SQL } from '../owner/automation';
import { activeMandate, latestMandateActSeq } from '../owner/delegation-execution';
import { executablePayloadSha256 } from '../owner/executable';
import { equivalentParticipantIds, logicalIdentityOf } from '../identity/families';
import { STORE_MIGRATION_0012_SALON } from '../salon/schema';

export const STALL_SECONDS = 24 * 3600;
export const AUTONOMY_LIMIT = 50;
const AUTHOR = 'system:controller';
interface Task { task_id: string; revision: number; owner_pid: string; reviewer_pid: string; tester_pid: string; since: number }
interface Alert { key: string; task: string; body: string; payload: Record<string, unknown>; type: 'checkpoint' | 'owner.request'; wake: string | null }
export interface AutonomyOptions { now?: () => Date; salonEnabled?: boolean; beforeWrite?: () => Promise<void> }
export interface AutonomyResult { status: 'disabled' | 'idle' | 'applied' | 'stale'; recorded: number }

async function setup(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS controller_stalls (cycle_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY(cycle_id,task_id,revision))'),
    ...STORE_MIGRATION_0012_SALON.map(sql => db.prepare(sql)),
  ]);
}

async function blockedTasks(db: D1Database, cycle: string, revision: number, now: number): Promise<Task[]> {
  // Missing historical timestamp: start an observation window, never invent 24h of inactivity.
  await db.prepare(`INSERT OR IGNORE INTO controller_stalls (cycle_id,task_id,revision,first_seen)
    SELECT cycle_id,task_id,revision,?2 FROM tasks WHERE cycle_id=?1 AND status='blocked'
    AND EXISTS (SELECT 1 FROM cycles WHERE cycle_id=?1 AND revision=?3 AND status='open') AND NOT ${HALT_ACTIVE_SQL}`)
    .bind(cycle, now, revision).run();
  const rows = await db.prepare(`SELECT t.task_id,t.revision,t.owner_pid,t.reviewer_pid,t.tester_pid,
    COALESCE((SELECT MAX(e.at) FROM events e WHERE e.cycle_id=t.cycle_id AND e.expected_rev=t.revision-1
      AND e.type IN ('task.claim','task.status','task.handoff','owner.decision')),s.first_seen) AS since
    FROM tasks t JOIN controller_stalls s ON s.cycle_id=t.cycle_id AND s.task_id=t.task_id AND s.revision=t.revision
    WHERE t.cycle_id=?1 AND t.status='blocked'
    AND NOT EXISTS(SELECT 1 FROM events e WHERE e.cycle_id=t.cycle_id AND e.type='checkpoint' AND e.participant_id='system:controller'
      AND json_valid(e.payload_json) AND json_extract(e.payload_json,'$.state')='S8_BLOCKED_ESCALATION'
      AND json_extract(e.payload_json,'$.task')=t.task_id AND json_extract(e.payload_json,'$.task_revision')=t.revision)
    ORDER BY since,t.task_id LIMIT ?2`)
    .bind(cycle, AUTONOMY_LIMIT).all<Task>();
  return rows.results;
}

async function taskAlerts(cycle: string, tasks: Task[], now: number, holder: string | null): Promise<Alert[]> {
  const alerts: Alert[] = [];
  for (const t of tasks) {
    if (now - t.since < STALL_SECONDS) continue;
    const key = 's8:' + await sha256Hex(JSON.stringify([cycle,t.task_id,t.revision]));
    const body = `Cycle ${cycle}, tâche ${t.task_id} bloquée depuis au moins 24 h. Coordinateur : examiner le blocage et choisir un remplaçant capable ; réattribution à faire valider, jamais appliquée par ce passage.`;
    alerts.push({ key, task: t.task_id, body, type: 'checkpoint', wake: holder, payload: {
      task: t.task_id, task_revision: t.revision, state: 'S8_BLOCKED_ESCALATION', since: t.since, summary: body,
      reassignment_draft: { action: 'reassign_task', cycle_id: cycle, task_id: t.task_id,
        expected_revision: t.revision, expected_owner_pid: t.owner_pid,
        expected_reviewer_pid: t.reviewer_pid, expected_tester_pid: t.tester_pid,
        requires: 'Choix des trois titulaires actifs, capacité et familles D12 distinctes avant demande exécutable.' },
    } });
  }
  return alerts;
}

async function successor(db: D1Database, family: string): Promise<{ participant_id: string; family_id: string } | null> {
  // Only owner-granted coordinators are suggested. Availability remains an owner decision.
  const rows = await db.prepare(`SELECT c.participant_id FROM coordinators c JOIN participants p USING(participant_id)
    WHERE c.status='active' AND p.status='active' ORDER BY c.participant_id LIMIT 50`).all<{ participant_id: string }>();
  for (const row of rows.results) {
    const candidateFamily = await logicalIdentityOf(db, row.participant_id);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(candidateFamily)) continue;
    if (candidateFamily !== family) return { participant_id: row.participant_id, family_id: candidateFamily };
  }
  return null;
}

async function silentCoordinator(db: D1Database, cycle: string, now: number): Promise<Alert | null> {
  const mandate = await activeMandate(db, cycle);
  if (!mandate?.participant_id) return null;
  const pending = await db.prepare("SELECT 1 AS ok FROM tasks WHERE cycle_id=?1 AND status NOT IN ('done','verified') LIMIT 1").bind(cycle).first();
  if (!pending) return null;
  const ids = await equivalentParticipantIds(db, mandate.participant_id);
  const marks = ids.map((_, i) => '?' + (i + 2)).join(',');
  const activity = await db.prepare(`SELECT MAX(at) AS at FROM events WHERE cycle_id=?1 AND participant_id IN (${marks})`)
    .bind(cycle, ...ids).first<{ at: number | null }>();
  const row = await db.prepare('SELECT updated_at FROM delegated_mandates WHERE cycle_id=?1').bind(cycle).first<{ updated_at: number }>();
  const since = Math.max(row?.updated_at ?? now, activity?.at ?? 0);
  if (now - since < STALL_SECONDS) return null;
  const family = await logicalIdentityOf(db, mandate.participant_id);
  const candidate = await successor(db, family);
  // Stable per mandate: rejected/expired proposals are not regenerated every 15 minutes.
  const key = 's8:' + await sha256Hex(JSON.stringify([cycle,'coordinator',mandate.epoch]));
  const body = `Cycle ${cycle} : coordinateur ${mandate.participant_id} sans événement depuis au moins 24 h, avec tâches ouvertes. ${candidate ? 'Remplacement proposé par ' + candidate.participant_id + ', à valider sur /owner après contrôle de disponibilité.' : 'Aucun autre coordinateur habilité : choix du propriétaire requis.'}`;
  if (!candidate) return { key, task: '', body, type: 'checkpoint', wake: null,
    payload: { state: 'S8_COORDINATOR_NO_SUCCESSOR', summary: body, expected_epoch: mandate.epoch, since } };
  const params = { cycle_id: cycle, ...candidate, expected_epoch: mandate.epoch };
  return { key, task: '', body, type: 'owner.request', wake: null, payload: {
    request_id: key, action: 'appoint_cycle_coordinator', params, summary: body,
    payload_sha256: await executablePayloadSha256('appoint_cycle_coordinator', params),
    preconditions: { previous_seq: await latestMandateActSeq(db, cycle) },
    reason: body, risk: 'La capacité réelle du remplaçant doit être confirmée par le propriétaire avant approbation.',
    rollback: 'Nouvelle nomination owner au nouvel epoch ; aucun changement effectué par cette proposition.',
    max_cost_cents: 0, expires_at: now + STALL_SECONDS,
  } };
}

/** Atomic alert + salon + proposal; CAS prevents stale observations from becoming actions. */
export async function superviseCycle(db: D1Database, cycle: string, options: AutonomyOptions = {}): Promise<AutonomyResult> {
  if (options.salonEnabled !== true) return { status: 'disabled', recorded: 0 };
  await setup(db);
  const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const state = await db.prepare(`SELECT revision FROM cycles WHERE cycle_id=?1 AND status='open' AND NOT ${HALT_ACTIVE_SQL}`)
    .bind(cycle).first<{ revision: number }>();
  if (!state) return { status: 'idle', recorded: 0 };
  const mandate = await activeMandate(db, cycle);
  const tasks = await blockedTasks(db, cycle, state.revision, now);
  const alerts = await taskAlerts(cycle, tasks, now, mandate?.participant_id ?? null);
  const silence = await silentCoordinator(db, cycle, now);
  if (silence) alerts.push(silence);
  const fresh: Alert[] = [];
  for (const alert of alerts) {
    if (!await db.prepare('SELECT 1 FROM events WHERE idempotency_key=?1').bind(alert.key).first()) fresh.push(alert);
  }
  if (!fresh.length) return { status: 'idle', recorded: 0 };
  await options.beforeWrite?.();
  const statements = [db.prepare(`INSERT INTO collab_store_guard(ok) SELECT CASE WHEN
    EXISTS(SELECT 1 FROM cycles WHERE cycle_id=?1 AND revision=?2 AND status='open')
    AND NOT ${HALT_ACTIVE_SQL} THEN 1 ELSE 0 END`).bind(cycle,state.revision)];
  for (const [i, alert] of fresh.entries()) {
    if (alert.type === 'owner.request') {
      const params = alert.payload.params as { participant_id: string; family_id: string };
      statements.push(db.prepare(`INSERT INTO collab_store_guard(ok) SELECT CASE WHEN EXISTS(
        SELECT 1 FROM coordinators c JOIN participants p USING(participant_id)
        WHERE c.participant_id=?1 AND c.status='active' AND p.status='active')
        AND COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id=?1),?1)=?2
        THEN 1 ELSE 0 END`).bind(params.participant_id,params.family_id));
    }
    statements.push(db.prepare(`INSERT INTO events(cycle_id,at,type,participant_id,role,payload_json,expected_rev,idempotency_key)
      VALUES(?1,?2,?3,?4,'controller',?5,?6,?7)`)
      .bind(cycle,now,alert.type,AUTHOR,JSON.stringify(alert.payload),state.revision+i,alert.key));
    statements.push(db.prepare(`INSERT INTO salon_messages(msg_id,at,author_pid,level,body,task_id,incident_key,new_fact,over_quota,masked)
      VALUES(?1,?2,?3,?4,?5,?6,?1,1,0,0)`)
      .bind(alert.key,now,AUTHOR,alert.task ? 'blocking' : 'decision',alert.body,alert.task));
    if (alert.wake) statements.push(db.prepare('INSERT OR IGNORE INTO salon_wakes(msg_id,participant_id,delivered_at) VALUES(?1,?2,NULL)').bind(alert.key,alert.wake));
  }
  statements.push(db.prepare('UPDATE cycles SET revision=?2 WHERE cycle_id=?1 AND revision=?3').bind(cycle,state.revision+fresh.length,state.revision));
  statements.push(expireDueHypotheses(db, cycle));
  statements.push(db.prepare('DELETE FROM collab_store_guard'));
  try { await db.batch(statements); }
  catch (error) {
    if (error instanceof Error && /CHECK constraint|UNIQUE constraint/.test(error.message)) return { status: 'stale', recorded: 0 };
    throw error;
  }
  return { status: 'applied', recorded: fresh.length };
}

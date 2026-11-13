/** Coordinator bridge to the SAME API/S7 engine used by event wakeups. */
import { CollabStoreError, type CollabStore } from '../store/collab-store';
import { isCoordinator } from '../owner/coordinators';
import { equivalentParticipantIds, assertDistinctLogicalParticipants } from '../identity/families';
import { opIdClientFor, parseOpId } from '../contracts';
import { exactGrant, type WriteGrant } from './github-write/authorization';
import { issueDynamicGrant } from './github-write/dynamic-grants';
import { apiParticipants, taskKindCostCents } from './plan';
import { ToolRefused } from './engine';
import { ensureAgentRunSchema } from './schema';
import type { AgentRunObjectEnv } from './object';

/** Grants and D1 assignment only; planAgentRuns creates all model runs. */
export interface LaunchInput {
  db:D1Database; store:CollabStore; env:AgentRunObjectEnv; coordinator:string;
  cycle:string; task:string; participant:string;
  reviewer?:string; tester?:string; paths?:string[]; acceptance?:string[];
  scheduledAt?:number; opId:string; now:number;
}
export interface LaunchResult {
  status:'queued'|'scheduled'; cycle:string; task:string; participant:string;
  branch:string; scheduled_at:number|null; detail:string;
}
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function deny(code: string, message: string): never { throw new CollabStoreError(code, message); }

export async function grantForLaunch(db: D1Database, env: AgentRunObjectEnv, cycle: string, task: string,
  pid: string, coordinator: string, paths?: string[], acceptance?: string[], now=Math.floor(Date.now()/1000)): Promise<WriteGrant> {
  if (env.AGENT_RUNS_ENABLED !== 'true' || env.AGENT_RUN_GITHUB_WRITES !== 'true')
    deny('AGENT_RUN_DISABLED', 'Runs or GitHub write tools disabled.');
  if (![cycle, task, pid].every(s => ID.test(s))) deny('INVALID_RUN_TARGET', 'Invalid target identifiers.');
  if (!apiParticipants(env.AGENT_RUN_PARTICIPANTS).includes(pid)
      || !(env.AGENT_RUN_GITHUB_WRITERS ?? '').split(',').map(s => s.trim()).includes(pid))
    deny('WRITER_NOT_GRANTED', 'Agent has no API writing permission.');
  if (taskKindCostCents(env, 'implement') !== 0) deny('PAID_RUN_FORBIDDEN', 'Only zero-cost implement runs are allowed.');
  const policy={writers:env.AGENT_RUN_GITHUB_WRITERS,
    tasks:env.AGENT_RUN_GITHUB_TASKS,dynamic:env.AGENT_RUN_DYNAMIC_SCOPE};
  const existing=await exactGrant(db,policy,cycle,task,pid);
  if (existing) {
    if (paths && JSON.stringify(paths)!==JSON.stringify(existing.paths))
      deny('TASK_SCOPE_MISMATCH', 'Cannot widen or alter a frozen grant.');
    if (acceptance && JSON.stringify(acceptance)!==JSON.stringify(existing.acceptance??[]))
      deny('TASK_ACCEPTANCE_MISMATCH','Cannot modify a frozen mission.');
    if (!existing.branch.startsWith('mcp/105856986/' + pid + '-api-'))
      deny('TASK_NOT_GRANTED','Branch outside API namespace.');
    return existing;
  }
  if (!paths || paths.length<1) deny('TASK_NOT_GRANTED','Missing owner-approved static grant or dynamic scope paths.');
  return issueDynamicGrant(db,env.AGENT_RUN_DYNAMIC_SCOPE,{
    cycle,task,participant:pid,paths,acceptance,coordinator,now});

}
interface Task { owner_pid: string; reviewer_pid: string; tester_pid: string; status: string; owned_paths: string }
async function readTask(i: LaunchInput): Promise<Task | null> {
  return i.db.prepare('SELECT owner_pid,reviewer_pid,tester_pid,status,owned_paths FROM tasks WHERE cycle_id=?1 AND task_id=?2')
    .bind(i.cycle, i.task).first<Task>();
}
async function event(i: LaunchInput, type: 'task.claim'|'task.handoff'|'checkpoint', suffix: string, payload: unknown) {
  const rev = await i.store.currentRevision(i.cycle);
  const out = await i.store.appendEvent({cycle_id:i.cycle, participant_id:i.coordinator, expected_rev:rev,
    type, role:'coordinator', payload_json:JSON.stringify(payload),
    op_id:type === 'checkpoint' ? i.opId : opIdClientFor(i.coordinator) + ':' + i.cycle + ':' + suffix + ':1'});
  if (out.status === 'stale') deny('STALE', 'Cycle changed; retry after reading its delta.');
  if (out.status === 'quota_exhausted') deny('QUOTA_EXHAUSTED', 'Store daily quota exhausted.');
}
/** The immutable grant is mirrored in the EXISTING task journal and materialized
 * next_action, which both chat and API already read through buildRolePacket.
 * It is mission data, NOT a substitute for the effect-time GitHub authorization. */
function workSessionNextAction(grant: WriteGrant): string {
  const acceptance = grant.acceptance ?? [];
  return [
    'WorkSession ' + grant.task + ' — mission ' + (grant.mission ?? 'pilot') + '.',
    'Chemins attribués : ' + grant.paths.join(', '),
    ...(acceptance.length ? ['Critères d’acceptation :', ...acceptance.map((item, index) => (index + 1) + '. ' + item)] : []),
    'Lire les sources au SHA exact, vérifier les résultats CI et ouvrir une PR sans fusion.',
  ].join('\n');
}
async function assignIfMissing(i: LaunchInput, grant: WriteGrant) {
  let t = await readTask(i);
  const coords = await equivalentParticipantIds(i.db, i.coordinator);
  if (!t) {
    if (!i.reviewer || !i.tester || i.reviewer === i.tester || i.reviewer === i.participant
        || i.tester === i.participant || coords.includes(i.reviewer) || coords.includes(i.tester)
        || coords.includes(i.participant))
      deny('D12_ASSIGNMENT_REQUIRED', 'New task requires separate reviewer and tester, different from author and coordinator.');
    // Existing store contract: owner claims under THEIR OWN identity; no Gemini impersonation.
    await event(i, 'task.claim', 's7launch-' + i.task + '-claim',
      {task:{task_id:i.task,owner_pid:i.coordinator,reviewer_pid:i.reviewer,tester_pid:i.tester,
        status:'in_progress',owned_paths:grant.paths,next_action:workSessionNextAction(grant)}});
    t = await readTask(i);
  }
  if (t && coords.includes(t.owner_pid)) {
    await event(i, 'task.handoff', 's7launch-' + i.task + '-handoff',
      {task:{task_id:i.task,owner_pid:i.participant,next_action:workSessionNextAction(grant)}});
    t = await readTask(i);
  }
  const targets = await equivalentParticipantIds(i.db, i.participant);
  let owned: unknown;
  try { owned = JSON.parse(t?.owned_paths ?? ''); } catch { deny('TASK_SCOPE_MISMATCH', 'Invalid owned paths.'); }
  if (!t || !targets.includes(t.owner_pid) || t.status !== 'in_progress'
      || JSON.stringify(owned) !== JSON.stringify(grant.paths)
      || targets.includes(t.reviewer_pid) || targets.includes(t.tester_pid))
    deny('TASK_SCOPE_MISMATCH', 'Task owner, status, D12 roles or paths differ from owner grant.');
}
/** Fail BEFORE issuing an immutable dynamic grant or an immutable timer.
 * The store's task.claim/handoff gates still revalidate at the D1 CAS commit.
 */
async function preflightAssignment(i:LaunchInput, paths:readonly string[]|null):Promise<void> {
  const existing=await readTask(i);
  const coords=await equivalentParticipantIds(i.db,i.coordinator);
  const targets=await equivalentParticipantIds(i.db,i.participant);
  if(!existing) {
    if(!i.reviewer||!i.tester)
      deny('D12_ASSIGNMENT_REQUIRED','New assignment needs reviewer and tester.');
    await assertDistinctLogicalParticipants(i.db,[i.participant,i.reviewer,i.tester]);
    if(coords.includes(i.participant)||coords.includes(i.reviewer)||coords.includes(i.tester))
      deny('D12_ASSIGNMENT_REQUIRED','Coordinator cannot review, test or author their own assignment.');
    for(const pid of [i.participant,i.reviewer,i.tester]) {
      const active=await i.db.prepare("SELECT status FROM participants WHERE participant_id=?1")
        .bind(pid).first<{status:string}>();
      if(active?.status!=='active') deny('UNREGISTERED_PARTICIPANT','D12 participant is not active.');
    }
    return;
  }
  let owned:unknown;
  try {owned=JSON.parse(existing.owned_paths);}catch {
    deny('TASK_SCOPE_MISMATCH','Current owned_paths is invalid JSON.');
  }
  if(existing.status!=='in_progress'
    ||(!coords.includes(existing.owner_pid)&&!targets.includes(existing.owner_pid))
    ||(paths!==null&&JSON.stringify(owned)!==JSON.stringify(paths))
    ||targets.includes(existing.reviewer_pid)||targets.includes(existing.tester_pid))
    deny('TASK_SCOPE_MISMATCH','Existing owner, status, D12 roles or files differ from authorized assignment.');
  await assertDistinctLogicalParticipants(i.db,[i.participant,existing.reviewer_pid,existing.tester_pid]);
}

/** Never constructs or wakes a run. Only the existing event-driven WorkSession scheduler does. */
export async function assignCoordinatorWorksession(i:LaunchInput):Promise<LaunchResult> {
  if (!await isCoordinator(i.db,i.coordinator)) deny('COORDINATOR_REQUIRED','Owner-approved coordinator required.');
  const op=parseOpId(i.opId);
  if(op.client!==opIdClientFor(i.coordinator)||op.cycle!==i.cycle)
    deny('INVALID_OP_ID','Assignment op_id must belong to coordinator and cycle.');
  const current=await readTask(i);
  if(!current&&(!i.reviewer||!i.tester||i.reviewer===i.tester||i.reviewer===i.participant||i.tester===i.participant
    ||i.coordinator===i.reviewer||i.coordinator===i.tester||i.coordinator===i.participant))
    deny('D12_ASSIGNMENT_REQUIRED','Separate author, reviewer and tester are required.');
  if(current&&(current.status!=='in_progress'||(current.owner_pid!==i.coordinator&&current.owner_pid!==i.participant)))
    deny('TASK_SCOPE_MISMATCH','Task owner or status differs from assignment.');
  const cycle=await i.db.prepare('SELECT status FROM cycles WHERE cycle_id=?1').bind(i.cycle).first<{status:string}>();
  if(cycle?.status!=='open') deny('CYCLE_NOT_OPEN','Cycle must be open.');
  // Reject accidental JS-millisecond epochs without limiting normal schedules.
  if(i.scheduledAt!==undefined&&(!Number.isSafeInteger(i.scheduledAt)
    ||i.scheduledAt>9_999_999_999))
    deny('INVALID_SCHEDULE','scheduled_at must be a UTC Unix timestamp in seconds (not milliseconds).');
  await ensureAgentRunSchema(i.db);
  const prior=await i.db.prepare('SELECT participant_id,not_before,created_by FROM agent_task_schedule WHERE cycle_id=?1 AND task_id=?2')
    .bind(i.cycle,i.task).first<{participant_id:string;not_before:number;created_by:string}>();
  if(i.scheduledAt!==undefined&&i.scheduledAt<i.now&&!prior)
    deny('INVALID_SCHEDULE','A new scheduled_at must not be in the past.');
  if(prior&&(prior.participant_id!==i.participant||prior.created_by!==i.coordinator
    ||(i.scheduledAt!==undefined&&prior.not_before!==i.scheduledAt)))
    deny('SCHEDULE_CONFLICT','An immutable task schedule already exists with different parameters.');
  let grant:WriteGrant;
  try {
    // The read-only preflight can also reject a corrupt dynamic grant; map that
    // ToolRefused identically to grantForLaunch instead of leaking STORE_UNAVAILABLE.
    const policy={writers:i.env.AGENT_RUN_GITHUB_WRITERS,tasks:i.env.AGENT_RUN_GITHUB_TASKS,
      dynamic:i.env.AGENT_RUN_DYNAMIC_SCOPE};
    const intendedPaths=i.paths??(await exactGrant(i.db,policy,i.cycle,i.task,i.participant))?.paths??null;
    await preflightAssignment(i,intendedPaths);
    grant=await grantForLaunch(i.db,i.env,i.cycle,i.task,i.participant,i.coordinator,i.paths,i.acceptance,i.now);
  } catch(error) {
    if(!(error instanceof ToolRefused)) throw error;
    // Preserve the former manual bridge's typed, allowlisted refusal, not STORE_UNAVAILABLE.
    const allowed=new Set([
      'dynamic_policy_invalid','dynamic_policy_not_approved','dynamic_scope_not_approved',
      'dynamic_acceptance_invalid','dynamic_grant_corrupt','dynamic_grant_invalid',
      'dynamic_cycle_not_open','dynamic_coordinator_not_active','dynamic_grant_cap_exhausted',
      'dynamic_branch_conflict','dynamic_grant_insert_refused','dynamic_grant_expired',
      'dynamic_grant_conflict','api_write_policy_invalid','api_task_grant_ambiguous',
    ]);
    throw new CollabStoreError('GITHUB_GRANT_REFUSED',allowed.has(error.message)?error.message:'api_grant_refused');
  }
  // Revalidate the actual immutable grant, not only the candidate paths.
  await preflightAssignment(i,grant.paths);
  const due=prior?.not_before??i.scheduledAt??null;
  // The schedule MUST predate task.claim/task.handoff, because those D1 events
  // independently wake the planner. After preflight, write both immutable timer
  // and durable deadline outbox in one D1 batch (no half-created timer intent).
  if(due!==null&&due>i.now) {
    const key='worksession-schedule:'+i.cycle+':'+i.task+':'+i.participant;
    await i.db.batch([
      i.db.prepare('INSERT OR IGNORE INTO agent_task_schedule(cycle_id,task_id,participant_id,not_before,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6)')
        .bind(i.cycle,i.task,i.participant,due,i.coordinator,i.now),
      i.db.prepare(['INSERT OR IGNORE INTO agent_event_wake_intents',
        '(event_key,cycle_id,event_type,status,attempts,next_at,created_at,updated_at,last_error)',
        "VALUES(?1,?2,'task.schedule','queued',0,?3,?4,?4,'')"].join(' '))
        .bind(key,i.cycle,due,i.now),
    ]);
  } else if(i.scheduledAt!==undefined) {
    // Identical replay after the deadline: the row already exists and is immutable.
    if(!prior) deny('INVALID_SCHEDULE','A new deadline cannot be in the past.');
  }
  const existing=await i.db.prepare('SELECT participant_id,not_before,created_by FROM agent_task_schedule WHERE cycle_id=?1 AND task_id=?2')
    .bind(i.cycle,i.task).first<{participant_id:string;not_before:number;created_by:string}>();
  if(existing&&(existing.participant_id!==i.participant||existing.created_by!==i.coordinator
    ||(i.scheduledAt!==undefined&&existing.not_before!==i.scheduledAt)))
    deny('SCHEDULE_CONFLICT','The schedule changed during assignment; no task handoff was made.');
  await assignIfMissing(i,grant);
  await event(i,'checkpoint','assigned-'+i.task,
    {task:i.task,state:'WORKSESSION_ASSIGNED',participant:i.participant,branch:grant.branch,scheduled_at:due});
  return {status:due!==null&&due>i.now?'scheduled':'queued',cycle:i.cycle,task:i.task,
    participant:i.participant,branch:grant.branch,scheduled_at:due,
    detail:'D1 assignment accepted; automatic planner creates and wakes the run.'};
}

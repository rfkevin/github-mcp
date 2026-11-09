/** Coordinator bridge to the SAME API/S7 engine used by event wakeups. */
import { CollabStoreError, type CollabStore } from '../store/collab-store';
import { isCoordinator } from '../owner/coordinators';
import { equivalentParticipantIds } from '../identity/families';
import { opIdClientFor, parseOpId } from '../contracts';
import { exactGrant, type WriteGrant } from './github-write/authorization';
import { issueDynamicGrant } from './github-write/dynamic-grants';
import { apiParticipants, attemptRunId, taskKindMaxSteps, taskKindMaxTokens, taskPrompt, taskKindCostCents } from './plan';
import { runDeadlineS } from './run-policy';
import { runCapacity } from './capacity';
import { createRun, releaseChat, leaseKeyOf } from './engine';
import { ensureAgentRunSchema } from './schema';
import type { WakeFn } from './orchestrator';
import type { AgentRunObjectEnv } from './object';

export interface LaunchInput {
  db: D1Database; store: CollabStore; env: AgentRunObjectEnv; coordinator: string;
  cycle: string; task: string; participant: string;
  reviewer?: string; tester?: string; paths?: string[]; acceptance?: string[];
  takeoverChat: boolean; opId: string; now: number; wake: WakeFn;
}
export interface LaunchResult {
  status: 'started' | 'existing' | 'wake_pending'; run_id: string; cycle: string;
  task: string; participant: string; wake_accepted: boolean; cost_cents: 0; detail: string;
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
        status:'in_progress',owned_paths:grant.paths,next_action:'Delegation S7 par le coordinateur'}});
    t = await readTask(i);
  }
  if (t && coords.includes(t.owner_pid)) {
    await event(i, 'task.handoff', 's7launch-' + i.task + '-handoff',
      {task:{task_id:i.task,owner_pid:i.participant,next_action:'Run implement API S7, une seule tentative'}});
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
export async function launchCoordinatorImplement(i: LaunchInput): Promise<LaunchResult> {
  if (!await isCoordinator(i.db, i.coordinator)) deny('COORDINATOR_REQUIRED', 'Owner-approved coordinator required.');
  const op = parseOpId(i.opId);
  if (op.client !== opIdClientFor(i.coordinator) || op.cycle !== i.cycle)
    deny('INVALID_OP_ID', 'Launch op_id must belong to the authenticated coordinator and cycle.');
  // No implicit grant for an unrelated or wrongly assigned task.
  const current=await readTask(i);
  if (!current && (!i.reviewer||!i.tester||i.reviewer===i.tester
    || i.reviewer===i.participant||i.tester===i.participant
    || i.coordinator===i.reviewer||i.coordinator===i.tester||i.coordinator===i.participant))
    deny('D12_ASSIGNMENT_REQUIRED','Distinct reviewer and tester required before grant issue.');
  if (current && (current.status!=='in_progress'
    || (current.owner_pid!==i.coordinator && current.owner_pid!==i.participant)))
    deny('TASK_SCOPE_MISMATCH','Existing task may not be regranted to another author.');
  const grant = await grantForLaunch(i.db,i.env,i.cycle,i.task,i.participant,
    i.coordinator,i.paths,i.acceptance,i.now);
  if (!i.env.AGENT_RUN) deny('AGENT_RUN_UNAVAILABLE', 'Durable Object binding required.');
  const c = await i.db.prepare('SELECT status,phase FROM cycles WHERE cycle_id=?1').bind(i.cycle)
    .first<{status:string;phase:string}>();
  if (c?.status !== 'open') deny('CYCLE_NOT_OPEN', 'Cycle must be open.');
  const capacity = await runCapacity(i.db, i.env, i.participant, i.cycle, 'implement', new Date(i.now*1000));
  if (!capacity.capable) deny('AGENT_NOT_CAPABLE', capacity.reason);
  await assignIfMissing(i, grant);
  await ensureAgentRunSchema(i.db);
  const rounds = await i.db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id=?1 AND type='round.add'")
    .bind(i.cycle).first<{n:number}>();
  const runId = await attemptRunId('implement',i.cycle,i.participant,i.task,'none',c.phase,rounds?.n??0,1);
  const existing = await i.db.prepare('SELECT status FROM agent_runs WHERE run_id=?1').bind(runId)
    .first<{status:string}>();
  const summary = (status: LaunchResult['status'], accepted: boolean, detail: string): LaunchResult =>
    ({status,run_id:runId,cycle:i.cycle,task:i.task,participant:i.participant,
      wake_accepted:accepted,cost_cents:0,detail});
  if (existing) return summary('existing',false,existing.status);
  await event(i,'checkpoint','s7launch-' + i.task + '-go',
    {task:i.task,state:'COORDINATOR_OWNER_GO',participant:i.participant,branch:grant.branch,
      takeover_chat:i.takeoverChat,cost_cents:0});
  if (i.takeoverChat) {
    for (const pid of await equivalentParticipantIds(i.db,i.participant))
      await releaseChat(i.db,{cycleId:i.cycle,participantId:pid,taskId:i.task,now:i.now});
  }
  const created = await createRun(i.db,{
    runId,cycleId:i.cycle,participantId:i.participant,taskId:i.task,taskKind:'implement',
    prompt:taskPrompt('implement',i.cycle,i.task,'none'),maxSteps:taskKindMaxSteps('implement'),
    maxTokens:taskKindMaxTokens('implement',{}),maxCostCents:0,
    deadlineAt:i.now+runDeadlineS('implement',0),now:i.now});
  if (!created.created) {
    if (created.reason === 'run_exists') return summary('existing',false,'run_exists');
    deny('RUN_NOT_CREATED',created.reason);
  }
  const ack = await i.wake(leaseKeyOf(i.cycle,i.participant,i.task),runId)
    .catch(()=>({accepted:false as const,reason:'wake_rpc_failed'}));
  return summary(ack.accepted?'started':'wake_pending',ack.accepted,
    ack.accepted?'Durable Object accepted alarm':ack.reason);
}

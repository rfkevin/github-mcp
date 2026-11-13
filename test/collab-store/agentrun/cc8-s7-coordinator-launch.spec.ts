import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerAgentRunTools } from '../../../src/collab-store/mcp/agentrun-tools';
import { outputSchemas } from '../../../src/collab-store/mcp/schemas';
import { grantForLaunch } from '../../../src/collab-store/agentrun/coordinator-launch';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';

const grant = {cycle:'cc8-systeme-unique',task:'S7-compare-gemini-1',participant:'gemini',
  branch:'mcp/105856986/gemini-api-s7-compare-1',
  paths:['test/collab-store/agentrun/s7-compare-gemini-1.spec.ts']};
const config = {AGENT_RUNS_ENABLED:'true',AGENT_RUN_GITHUB_WRITES:'true',
  AGENT_RUN_PARTICIPANTS:'vibe,gemini',AGENT_RUN_GITHUB_WRITERS:'vibe,gemini',
  AGENT_RUN_GITHUB_TASKS:JSON.stringify([grant])} as AgentRunObjectEnv;
const get = (env:AgentRunObjectEnv=config,pid='gemini')=>
  grantForLaunch(db,env,'cc8-systeme-unique','S7-compare-gemini-1',pid,'gpt6');

describe('CC8 S7 direct API bridge — deny by default', () => {
  it('requires exact owner grant for participant, task and isolated branch',async()=>{
    expect(await get()).toEqual(grant);
    await expect(get(config,'vibe')).rejects.toThrow();
    await expect(get({...config,AGENT_RUN_GITHUB_TASKS:'[]'})).rejects.toThrow();
    await expect(get({...config,AGENT_RUN_GITHUB_TASKS:JSON.stringify([{...grant,branch:'main'}])})).rejects.toThrow();
  });
  it('refuses missing writing rights but permits an owner-configured paid implement budget',async()=>{
    await expect(get({...config,AGENT_RUNS_ENABLED:'false'})).rejects.toThrow();
    await expect(get({...config,AGENT_RUN_GITHUB_WRITERS:''})).rejects.toThrow();
    await expect(get({...config,AGENT_RUN_COST_CENTS_IMPLEMENT:'1'} as AgentRunObjectEnv)).resolves.toEqual(grant);
    await expect(get({...config,AGENT_RUN_COST_CENTS_IMPLEMENT:'1',AGENT_RUN_GITHUB_TASKS:'[]'} as AgentRunObjectEnv))
      .rejects.toThrow();
  });
});


import { env } from 'cloudflare:test';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';
import { assignCoordinatorWorksession } from '../../../src/collab-store/agentrun/coordinator-launch';
import { planAgentRuns } from '../../../src/collab-store/agentrun/plan';
import { drainDurableEventWakes } from '../../../src/collab-store/agentrun/wake-trigger';
import { leaseKeyOf, preemptByChat, releaseChat } from '../../../src/collab-store/agentrun/engine';
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let sequence = 0;
async function setup(label: string) {
  const k = ++sequence;
  const cycle = '0000-s7-direct-' + label + '-' + k + '-' + Date.now().toString(36);
  const coordinator = 's7-direct-c-' + k;
  const vibe = 's7-direct-v-' + k;
  const gemini = 's7-direct-g-' + k;
  const grok = 's7-direct-t-' + k;
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  await insertCycleRow(db,cycle,'P6');
  await insertPhaseDefinition(db,cycle,'P6',[]);
  for(const pid of [coordinator,vibe,gemini,grok])
    await registerParticipant(db,{participant_id:pid,display_label:pid,proof:OWNER_PROOF,op:'s7-direct-register-'+pid});
  await db.prepare("INSERT INTO coordinators(participant_id,status,event_seq,updated_at) VALUES(?1,'active',NULL,?2)")
    .bind(coordinator,Math.floor(Date.now()/1000)).run();
  const task='test-'+label;
  const path='test/collab-store/agentrun/s7-direct-'+label+'.spec.ts';
  const grant={cycle,task,participant:gemini,branch:'mcp/105856986/'+gemini+'-api-test',paths:[path]};
  const runtime={AGENT_RUNS_ENABLED:'true',AGENT_RUN_GITHUB_WRITES:'true',AGENT_RUN_PARTICIPANTS:gemini,
    AGENT_RUN_GITHUB_WRITERS:gemini,AGENT_RUN_GITHUB_TASKS:JSON.stringify([grant]),
    AGENT_RUN_MODEL:'workers-ai:@cf/zai-org/glm-4.7-flash',AI:{},AGENT_RUN:{} as never} as unknown as AgentRunObjectEnv;
  const wakeIds: string[] = [];
  const input={db,store:new CollabStore(db,{dailyWriteLimit:100000}),env:runtime,coordinator,cycle,task,
    participant:gemini,reviewer:vibe,tester:grok,takeoverChat:false,
    opId:coordinator+':'+cycle+':launch:1',now:Math.floor(Date.now()/1000),
    wake:async (_lease:string,id:string)=>{wakeIds.push(id);return {accepted:true as const};}};
  return {coordinator,vibe,gemini,grok,cycle,task,path,grant,runtime,wakeIds,input};
}
describe('CC8 #320 — one D1 assignment, one WorkSession planner',()=>{
  it('two assignments create D1 tasks and grants, NO run or direct wake',async()=>{
    const s=await setup('parallel');
    const other='test-parallel-other';
    const grant2={cycle:s.cycle,task:other,participant:s.vibe,
      branch:'mcp/105856986/'+s.vibe+'-api-test',paths:['test/collab-store/agentrun/s7-direct-parallel-other.spec.ts']};
    s.runtime.AGENT_RUN_PARTICIPANTS=[s.gemini,s.vibe].join(',');
    s.runtime.AGENT_RUN_GITHUB_WRITERS=[s.gemini,s.vibe].join(',');
    s.runtime.AGENT_RUN_GITHUB_TASKS=JSON.stringify([s.grant,grant2]);
    const a=await assignCoordinatorWorksession(s.input);
    const b=await assignCoordinatorWorksession({...s.input,task:other,participant:s.vibe,
      reviewer:s.gemini,tester:s.grok,opId:s.coordinator+':'+s.cycle+':other:1'});
    expect(a).toMatchObject({status:'queued',branch:s.grant.branch,scheduled_at:null});
    expect(b).toMatchObject({status:'queued',branch:grant2.branch,scheduled_at:null});
    const tasks=(await db.prepare('SELECT task_id,owner_pid FROM tasks WHERE cycle_id=?1 ORDER BY task_id')
      .bind(s.cycle).all<{task_id:string;owner_pid:string}>()).results;
    expect(tasks).toEqual([{task_id:s.task,owner_pid:s.gemini},{task_id:other,owner_pid:s.vibe}]);
    const count=await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id=?1')
      .bind(s.cycle).first<{n:number}>();
    expect(count?.n).toBe(0);
    expect(s.wakeIds).toHaveLength(0);
    // The D1 checkpoint is queued for the common event-pass, not a parallel launch.
    const queued=await db.prepare("SELECT COUNT(*) AS n FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='checkpoint'")
      .bind(s.cycle).first<{n:number}>();
    expect(queued?.n).toBe(2);
  });

  it('replay does not create another run or wake and keeps D12 assignment',async()=>{
    const s=await setup('replay');
    const first=await assignCoordinatorWorksession(s.input);
    const again=await assignCoordinatorWorksession(s.input);
    expect(again).toEqual(first);
    const row=await db.prepare('SELECT owner_pid,reviewer_pid,tester_pid,owned_paths FROM tasks WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{owner_pid:string;reviewer_pid:string;tester_pid:string;owned_paths:string}>();
    expect(row).toMatchObject({owner_pid:s.gemini,reviewer_pid:s.vibe,tester_pid:s.grok});
    expect(JSON.parse(row!.owned_paths)).toEqual([s.path]);
    const checkpoints=await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id=?1 AND type='checkpoint'")
      .bind(s.cycle).first<{n:number}>();
    expect(checkpoints?.n).toBe(1);
    expect(s.wakeIds).toHaveLength(0);
  });

  it('scheduled_at is explicit, immutable and adds a durable deadline',async()=>{
    const s=await setup('timer');
    const due=s.input.now+600;
    const input={...s.input,scheduledAt:due};
    expect(await assignCoordinatorWorksession(input)).toMatchObject({status:'scheduled',scheduled_at:due});
    const row=await db.prepare('SELECT not_before FROM agent_task_schedule WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{not_before:number}>();
    expect(row?.not_before).toBe(due);
    const timer=await db.prepare("SELECT next_at,status FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='task.schedule'")
      .bind(s.cycle).first<{next_at:number;status:string}>();
    expect(timer).toMatchObject({next_at:due,status:'queued'});
    const early=await planAgentRuns(db,s.runtime,{now:s.input.now+1,limit:10});
    expect(early.created).toBe(0);
    await expect(assignCoordinatorWorksession({...input,scheduledAt:due+5,opId:s.coordinator+':'+s.cycle+':mutate:1'}))
      .rejects.toMatchObject({code:'SCHEDULE_CONFLICT'});
    expect(await assignCoordinatorWorksession(input)).toMatchObject({status:'scheduled'});
  });

  it('rejects mismatched task scope without orphaning a schedule or a dynamic wake',async()=>{
    const s=await setup('orphan');
    // Coordinator already owns a task whose owned_paths contradict the static grant.
    const claimed=await s.input.store.appendEvent({
      cycle_id:s.cycle,type:'task.claim',participant_id:s.coordinator,
      expected_rev:await s.input.store.currentRevision(s.cycle),
      payload_json:JSON.stringify({task:{task_id:s.task,owner_pid:s.coordinator,
        reviewer_pid:s.vibe,tester_pid:s.grok,status:'in_progress',
        owned_paths:['test/collab-store/agentrun/not-granted.spec.ts']}}),
      op_id:s.coordinator+':'+s.cycle+':prepare-wrong:1',
    });
    expect(claimed.status).toBe('applied');
    const at=s.input.now+90;
    await expect(assignCoordinatorWorksession({...s.input,scheduledAt:at}))
      .rejects.toMatchObject({code:'TASK_SCOPE_MISMATCH'});
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_task_schedule WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{n:number}>())?.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='task.schedule'")
      .bind(s.cycle).first<{n:number}>())?.n).toBe(0);
    // Repair the task's owned paths and assign a DIFFERENT date successfully.
    const corrected=await s.input.store.appendEvent({
      cycle_id:s.cycle,type:'task.claim',participant_id:s.coordinator,
      expected_rev:await s.input.store.currentRevision(s.cycle),
      payload_json:JSON.stringify({task:{task_id:s.task,owner_pid:s.coordinator,
        reviewer_pid:s.vibe,tester_pid:s.grok,status:'in_progress',owned_paths:[s.path]}}),
      op_id:s.coordinator+':'+s.cycle+':prepare-right:1',
    });
    expect(corrected.status).toBe('applied');
    expect(await assignCoordinatorWorksession({...s.input,scheduledAt:at+180,opId:s.coordinator+':'+s.cycle+':retry:1'}))
      .toMatchObject({status:'scheduled',scheduled_at:at+180});
  });

  it('rejects millisecond timestamps before creating any schedule or grant',async()=>{
    const s=await setup('milliseconds');
    await expect(assignCoordinatorWorksession({...s.input,scheduledAt:s.input.now*1000}))
      .rejects.toMatchObject({code:'INVALID_SCHEDULE'});
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_task_schedule WHERE cycle_id=?1')
      .bind(s.cycle).first<{n:number}>())?.n).toBe(0);
  });

  it('durable task.schedule outbox delivers at due through the normal planner, no cron',async()=>{
    const s=await setup('wake-due');
    const due=s.input.now+210;
    await assignCoordinatorWorksession({...s.input,scheduledAt:due});
    const early=await drainDurableEventWakes(db,s.runtime,{
      now:s.input.now+1,deliverer:'test-pre-due',wake:async()=>({accepted:true as const}),
    });
    expect(early.next_at).toBe(due);
    expect((await db.prepare("SELECT status FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='task.schedule'")
      .bind(s.cycle).first<{status:string}>())?.status).toBe('queued');
    const resumed=await drainDurableEventWakes(db,s.runtime,{
      now:due+1,deliverer:'test-at-due',wake:async()=>({accepted:true as const}),
    });
    expect(resumed.delivered).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("SELECT status FROM agent_event_wake_intents WHERE cycle_id=?1 AND event_type='task.schedule'")
      .bind(s.cycle).first<{status:string}>())?.status).toBe('delivered');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{n:number}>())?.n).toBe(1);
  });

  it('default mission is scheduled immediately once by the common planner',async()=>{
    const s=await setup('immediate');
    await assignCoordinatorWorksession(s.input);
    const first=await planAgentRuns(db,s.runtime,{now:s.input.now+1,limit:3});
    expect(first.created).toBe(1);
    const running=await db.prepare('SELECT run_id,task_kind,status FROM agent_runs WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{run_id:string;task_kind:string;status:string}>();
    expect(running).toMatchObject({task_kind:'implement',status:'running'});
    expect(running!.run_id).toMatch(/^api-implement-/);
    expect((await planAgentRuns(db,s.runtime,{now:s.input.now+2,limit:3})).created).toBe(0);
    expect(s.wakeIds).toHaveLength(0);
  });

  it('future schedule executes once when due, and an identical late replay stays valid',async()=>{
    const s=await setup('due-once');
    const due=s.input.now+180;
    const input={...s.input,scheduledAt:due};
    await assignCoordinatorWorksession(input);
    expect((await planAgentRuns(db,s.runtime,{now:due-1,limit:3})).created).toBe(0);
    const planned=await planAgentRuns(db,s.runtime,{now:due+1,limit:3});
    expect(planned.created).toBe(1);
    const row=await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{n:number}>();
    expect(row?.n).toBe(1);
    expect((await planAgentRuns(db,s.runtime,{now:due+2,limit:3})).created).toBe(0);
    const late=await assignCoordinatorWorksession({...input,now:due+10});
    expect(late).toMatchObject({status:'queued',scheduled_at:due});
    await expect(assignCoordinatorWorksession({...input,scheduledAt:due+20,
      now:due+10,opId:s.coordinator+':'+s.cycle+':alter-schedule:1'}))
      .rejects.toMatchObject({code:'SCHEDULE_CONFLICT'});
  });

  it('chat retains its lease; assignment never takes over the chat',async()=>{
    const s=await setup('lease');
    await preemptByChat(db,{cycleId:s.cycle,participantId:s.gemini,taskId:s.task,
      now:s.input.now,holdSeconds:3600});
    expect((await assignCoordinatorWorksession(s.input)).status).toBe('queued');
    const key=leaseKeyOf(s.cycle,s.gemini,s.task);
    expect((await db.prepare('SELECT holder FROM agent_fences WHERE lease_key=?1')
      .bind(key).first<{holder:string}>())?.holder).toBe('chat');
    expect((await planAgentRuns(db,s.runtime,{now:s.input.now+1})).created).toBe(0);
    await releaseChat(db,{cycleId:s.cycle,participantId:s.gemini,taskId:s.task,now:s.input.now+2});
    expect((await db.prepare('SELECT holder FROM agent_fences WHERE lease_key=?1')
      .bind(key).first<{holder:string}>())?.holder).not.toBe('api');
  });

  it('MCP exposes only assignment, not the obsolete manual runner',async()=>{
    const s=await setup('mcp');
    const handlers=new Map<string,(args:Record<string,unknown>)=>Promise<{structuredContent?:Record<string,unknown>;isError?:boolean}>>();
    const fakeServer={registerTool(name:string,_spec:unknown,handler:(args:Record<string,unknown>)=>Promise<{structuredContent?:Record<string,unknown>;isError?:boolean}>) {
      handlers.set(name,handler);
    }} as unknown as McpServer;
    const ctx={db,store:s.input.store,agentRunEnv:s.runtime,
      identity:async()=>({status:'registered',participant_id:s.coordinator})} as unknown as CollabToolContext;
    registerAgentRunTools(fakeServer,ctx);
    expect(handlers.has('collab_launch_implement')).toBe(false);
    const response=await handlers.get('collab_assign_worksession')!({
      cycle:s.cycle,task:s.task,participant:s.gemini,reviewer:s.vibe,tester:s.grok,
      op_id:s.input.opId,
    });
    expect(response.isError).toBeFalsy();
    expect(z.object(outputSchemas.collab_assign_worksession).parse(response.structuredContent))
      .toMatchObject({status:'queued',branch:s.grant.branch,scheduled_at:null});
  });
});

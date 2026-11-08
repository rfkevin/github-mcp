import { describe, expect, it } from 'vitest';
import { grantForLaunch } from '../../../src/collab-store/agentrun/coordinator-launch';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';

const grant = {cycle:'cc8-systeme-unique',task:'S7-compare-gemini-1',participant:'gemini',
  branch:'mcp/105856986/gemini-api-s7-compare-1',
  paths:['test/collab-store/agentrun/s7-compare-gemini-1.spec.ts']};
const config = {AGENT_RUNS_ENABLED:'true',AGENT_RUN_GITHUB_WRITES:'true',
  AGENT_RUN_PARTICIPANTS:'vibe,gemini',AGENT_RUN_GITHUB_WRITERS:'vibe,gemini',
  AGENT_RUN_GITHUB_TASKS:JSON.stringify([grant])} as AgentRunObjectEnv;
const get = (env:AgentRunObjectEnv=config,pid='gemini')=>
  grantForLaunch(env,'cc8-systeme-unique','S7-compare-gemini-1',pid);

describe('CC8 S7 direct API bridge — deny by default', () => {
  it('requires exact owner grant for participant, task and isolated branch',()=>{
    expect(get()).toEqual(grant);
    expect(()=>get(config,'vibe')).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_TASKS:'[]'})).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_TASKS:JSON.stringify([{...grant,branch:'main'}])})).toThrow();
  });
  it('refuses disabled API writing or any paid implement budget',()=>{
    expect(()=>get({...config,AGENT_RUNS_ENABLED:'false'})).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_WRITERS:''})).toThrow();
    expect(()=>get({...config,AGENT_RUN_COST_CENTS_IMPLEMENT:'1'} as AgentRunObjectEnv)).toThrow();
  });
});


import { env } from 'cloudflare:test';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';
import { launchCoordinatorImplement } from '../../../src/collab-store/agentrun/coordinator-launch';
import { leaseKeyOf, preemptByChat } from '../../../src/collab-store/agentrun/engine';
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
describe('CC8 S7 direct launch — real D1 handoff, run and lease',()=>{
  it('Gemini sans chat : handoff sous propre identité puis un run unique',async()=>{
    const s=await setup('gemini');
    const first=await launchCoordinatorImplement(s.input);
    expect(first.status).toBe('started');
    expect(first.cost_cents).toBe(0);
    expect(s.wakeIds).toEqual([first.run_id]);
    const row=await db.prepare('SELECT owner_pid,reviewer_pid,tester_pid,owned_paths FROM tasks WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,s.task).first<{owner_pid:string;reviewer_pid:string;tester_pid:string;owned_paths:string}>();
    expect(row?.owner_pid).toBe(s.gemini);
    expect(row?.reviewer_pid).toBe(s.vibe);
    expect(row?.tester_pid).toBe(s.grok);
    expect(JSON.parse(row!.owned_paths)).toEqual([s.path]);
    const run=await db.prepare('SELECT max_tokens,max_cost_cents,task_kind FROM agent_runs WHERE run_id=?1')
      .bind(first.run_id).first<{max_tokens:number;max_cost_cents:number;task_kind:string}>();
    expect(run).toEqual({max_tokens:48000,max_cost_cents:0,task_kind:'implement'});
    expect((await launchCoordinatorImplement(s.input)).status).toBe('existing');
    expect(s.wakeIds).toHaveLength(1);
  });
  it('Vibe chat : bail refuse sans takeover, puis transfert explicite au moteur',async()=>{
    const s=await setup('vibe');
    const g={...s.grant,participant:s.vibe,branch:'mcp/105856986/'+s.vibe+'-api-test'};
    s.runtime.AGENT_RUN_PARTICIPANTS=s.vibe;
    s.runtime.AGENT_RUN_GITHUB_WRITERS=s.vibe;
    s.runtime.AGENT_RUN_GITHUB_TASKS=JSON.stringify([g]);
    await db.prepare("INSERT INTO tasks(task_id,cycle_id,owner_pid,reviewer_pid,tester_pid,status,owned_paths,target_ref,next_action,revision) VALUES(?1,?2,?3,?4,?5,'in_progress',?6,'','',1)")
      .bind(s.task,s.cycle,s.vibe,s.coordinator,s.grok,JSON.stringify([s.path])).run();
    await preemptByChat(db,{cycleId:s.cycle,participantId:s.vibe,taskId:s.task,now:s.input.now,holdSeconds:3600});
    const target={...s.input,participant:s.vibe};
    await expect(launchCoordinatorImplement(target)).rejects.toMatchObject({code:'RUN_NOT_CREATED'});
    const answer=await launchCoordinatorImplement({...target,takeoverChat:true,
      opId:s.coordinator+':'+s.cycle+':launch:2'});
    expect(answer.status).toBe('started');
    expect(s.wakeIds).toEqual([answer.run_id]);
    const fence=await db.prepare('SELECT holder FROM agent_fences WHERE lease_key=?1')
      .bind(leaseKeyOf(s.cycle,s.vibe,s.task)).first<{holder:string}>();
    expect(fence?.holder).toBe('api');
  });
});

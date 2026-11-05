import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, preemptByChat } from '../../../../src/collab-store/agentrun/engine';
import { apiBranch, type GitHubWrites } from '../../../../src/collab-store/agentrun/github-tools';
import { createReadToolHost, type GitHubReads } from '../../../../src/collab-store/agentrun/read-tools';
import { createS7Tools, type ApiChecks } from '../../../../src/collab-store/agentrun/github-write/tools';
import { authorize, grants, inPaths, type WritePolicy } from '../../../../src/collab-store/agentrun/github-write/authorization';
import { engineFor } from '../../../../src/collab-store/agentrun/object';
import { replaceOnce } from '../../../../src/collab-store/agentrun/github-write/edits';
import { insertCycleRow, insertTaskRow, insertPhaseDefinition } from '../../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_990_000_000, REPO='rfkevin/github-mcp', BASE='mcp/105856986/cc3-integration';
const H='b'.repeat(40), BLOB='e'.repeat(40);
let n=0;
async function fixture() {
  const id=++n, cycle='s7-'+id+'-'+Date.now(), participant='s7-agent-'+id, run='run-'+cycle;
  const task='fix', name='fix', branch=apiBranch(participant,name);
  await insertCycleRow(db,cycle,'P6');
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(participant).run();

  await insertPhaseDefinition(db,cycle,'P6',[]);
  await insertTaskRow(db,{cycle, taskId:task, owner:participant,reviewer:'s7-review-'+id,tester:'s7-test-'+id});
  await db.prepare("UPDATE tasks SET status='in_progress', owned_paths=?3 WHERE cycle_id=?1 AND task_id=?2").bind(cycle,task,JSON.stringify(['src/demo/'])).run();
  expect((await createRun(db,{runId:run,cycleId:cycle,participantId:participant,taskId:task,taskKind:'implement',prompt:'test',maxSteps:30,maxTokens:100000,maxCostCents:0,deadlineAt:T+1000,now:T})).created).toBe(true);
  const policy:WritePolicy={writers:participant,tasks:JSON.stringify([{cycle,task,participant,branch,paths:['src/demo/']}])};
  let head=H, commits=0, mode='failure', runCounter=0, transportError=false;
  const history:Array<{sha:string;message:string}>=[];
  const writes:GitHubWrites={
    branchHead:async()=>head,
    createBranch:async()=>({sha:head}),
    commitFiles:async(_r,_b,expected,message)=>{
      if(expected!==head) throw Error('wrong head');
      head=(++commits).toString(16).padStart(40,'a');history.unshift({sha:head,message});
      if(transportError)throw Error('lost response');
      return {commit_sha:head};
    },
    recentCommits:async()=>[...history,{sha:H,message:'base'}],
    openDraftPullRequest:async()=>({number:1,head_sha:head}),
    openPullRequest:async()=>({number:1,head_sha:head}),
    findPullRequest:async()=>null,
  };
  const reads:GitHubReads={getTextFile:async(_r,path)=>({path,sha:BLOB,content:'hello world',size:11}),getPullRequest:async()=>({}),listCheckRuns:async()=>[],compareRefs:async()=>({})};
  const checks:ApiChecks={start:async sha=>({runId:++runCounter,targetSha:sha}),lookup:async()=>null,
    result:async sha=>({targetSha:sha,status:mode==='pending'?'in_progress':'completed',conclusion:mode==='pending'?null:mode,verifiedSuccess:mode==='success'})};
  const options={db,repository:REPO,baseBranch:BASE,writes};
  const s7={policy,reads,checks};const tools=createS7Tools(options,s7);
  let effect=0;
  const ctx=()=>({run_id:run,effect_key:(id * 1000 + ++effect).toString(16).padEnd(64,'0')});
  const commit=(extra:Record<string,unknown>={})=>({id:'c',name:'github_commit_files',args:{name,expected_head_sha:head,message:'fix',files:[{path:'src/demo/a.ts',content:'x'}],...extra}});
  const result=()=>tools.execute({id:'r',name:'github_check_result',args:{name,sha:head,run_id:++runCounter}},ctx());
  return {cycle,task,participant,run,name,branch,policy,tools,options,s7,ctx,commit,result,reads,
    head:()=>head,commits:()=>commits,setMode:(m:string)=>{mode=m;},lose:()=>{transportError=true;}};
}

describe('CC8 S7 — permissions, edits and correction loop',()=>{
  it('exposes the current base commit SHA and refuses an unavailable or invalid base head',async()=>{
    const f=await fixture();
    const call={id:'scope',name:'github_write_scope',args:{}};
    expect(await f.tools.execute(call,f.ctx())).toMatchObject({branch:f.branch,name:f.name,base_branch:BASE,base_sha:H});
    f.options.writes.branchHead=async(_repo,branch)=>branch===BASE?null:H;
    await expect(f.tools.execute(call,f.ctx())).rejects.toThrow('api_base_head_unavailable');
    f.options.writes.branchHead=async()=> 'invalid';
    await expect(f.tools.execute(call,f.ctx())).rejects.toThrow('api_base_head_unavailable');
  });
  it('rejects either missing permission, wrong branch and changed ownership before GitHub',async()=>{
    const f=await fixture();
    await expect(authorize(db,{},f.run,f.branch)).rejects.toThrow('api_writer_not_enabled');
    await expect(authorize(db,{writers:f.participant},f.run,f.branch)).rejects.toThrow('api_task_not_enabled');
    await expect(authorize(db,f.policy,f.run,f.branch+'-other')).rejects.toThrow('api_task_not_enabled');
    await db.prepare('UPDATE tasks SET owner_pid=?2 WHERE cycle_id=?1').bind(f.cycle,'different').run();
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_task_inactive');
    expect(f.commits()).toBe(0);
  });
  it('rejects paths outside either grant or task, traversal and prefix siblings',async()=>{
    const f=await fixture();
    for(const path of ['src/demo2/a.ts','src/demo/../secret','src/demo\\secret','/src/demo/a.ts','.github/workflows/x.yml']){
      await expect(f.tools.execute(f.commit({files:[{path,content:'x'}]}),f.ctx())).rejects.toThrow('api_write_outside_task');
    }
    await db.prepare('UPDATE tasks SET owned_paths=?2 WHERE cycle_id=?1').bind(f.cycle,'["src/other/"]').run();
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_outside_task');
    expect(f.commits()).toBe(0);
  });
  it('honors pause, HALT and a newly taken chat lease',async()=>{
    const f=await fixture();await authorize(db,f.policy,f.run,f.branch);
    await db.prepare("INSERT INTO agent_run_status(participant_id,version,status,updated_at,event_seq) VALUES(?1,1,'paused',0,0)").bind(f.participant).run();
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('AGENT_PAUSED');
    await db.prepare("UPDATE agent_run_status SET status='resumed' WHERE participant_id=?1").bind(f.participant).run();
    await db.prepare("INSERT OR REPLACE INTO owner_flags(name,value,updated_at) VALUES('halt','1',0)").run();
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('HALT_ACTIVE');
    await db.prepare("UPDATE owner_flags SET value='0' WHERE name='halt'").run();
    await preemptByChat(db,{cycleId:f.cycle,participantId:f.participant,taskId:f.task,holdSeconds:900,now:T});
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_preempted');expect(f.commits()).toBe(0);
  });
  it('replaces a unique literal only at matching head and blob',async()=>{
    const f=await fixture();
    const call={id:'r',name:'github_replace_text',args:{name:f.name,expected_head_sha:H,path:'src/demo/a.ts',expected_sha:BLOB,old_text:'world',new_text:'S7',message:'fix'}};
    await expect(f.tools.execute({...call,args:{...call.args,expected_sha:H}},f.ctx())).rejects.toThrow('api_edit_blob_changed');
    await expect(f.tools.execute({...call,args:{...call.args,expected_head_sha:BLOB}},f.ctx())).rejects.toThrow('api_write_head_changed');
    expect(await f.tools.execute(call,f.ctx())).toMatchObject({next_action:'github_run_checks'});expect(f.commits()).toBe(1);
  });
  it('pending CI blocks a correction; red -> correction -> green requests D12',async()=>{
    const f=await fixture();await f.tools.execute(f.commit(),f.ctx());
    f.setMode('pending');expect(await f.result()).toMatchObject({next_action:'wait'});
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_wait_for_failed_ci');
    f.setMode('failure');expect(await f.result()).toMatchObject({next_action:'correct'});
    await f.tools.execute(f.commit(),f.ctx());f.setMode('success');
    expect(await f.result()).toMatchObject({next_action:'request_D12',verifiedSuccess:true});
    expect(f.commits()).toBe(2);
  });
  it('three failed corrections escalate durably and prevent a fourth',async()=>{
    const f=await fixture();await f.tools.execute(f.commit(),f.ctx());
    for(let i=0;i<3;i++){await f.result();await f.tools.execute(f.commit(),f.ctx());}
    expect(await f.result()).toMatchObject({next_action:'escalate'});
    const row=await db.prepare('SELECT status FROM tasks WHERE cycle_id=?1 AND task_id=?2').bind(f.cycle,f.task).first<{status:string}>();
    expect(row?.status).toBe('blocked');
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_task_inactive');expect(f.commits()).toBe(4);
  });
  it('lost commit response reconciles without a second commit or consumed correction',async()=>{
    const f=await fixture();const call=f.commit(),ctx=f.ctx();f.lose();
    await expect(f.tools.execute(call,ctx)).rejects.toThrow('lost response');
    const result=await f.tools.lookup(call,ctx);expect(result?.found).toBe(true);
    expect(f.commits()).toBe(1);
    expect(await db.prepare('SELECT after_sha FROM api_write_commits WHERE effect_key=?1').bind(ctx.effect_key).first()).toEqual({after_sha:f.head()});
  });
  it('host exposes S7 only for implement, and no checks when disabled',async()=>{
    const f=await fixture();const host=createReadToolHost({db,repository:REPO,github:f.reads,githubWrites:{writes:f.options.writes,baseBranch:BASE,s7:f.s7}});
    expect(host.list('implement')).toContain('github_run_checks');expect(host.list('review')).not.toContain('github_replace_text');
    expect(host.list('implement').some(s=>s.includes('merge'))).toBe(false);
    expect(createS7Tools(f.options,{...f.s7,checks:null}).names('implement')).not.toContain('github_run_checks');
  });
  it('scope discovery reveals only the current task grant',async()=>{
    const f=await fixture();
    expect(await f.tools.execute({id:'s',name:'github_write_scope',args:{}},f.ctx())).toMatchObject({branch:f.branch,name:f.name,corrections_remaining:3});
  });
  it('definite validation refusal releases reservation; malformed input does not consume a correction',async()=>{
    const f=await fixture();
    await expect(f.tools.execute(f.commit({message:''}),f.ctx())).rejects.toThrow();
    expect(f.commits()).toBe(0);
    expect(await f.tools.execute(f.commit(),f.ctx())).toMatchObject({corrections_remaining:3});
  });
  it('CI for another target is refused before recording a failed result',async()=>{
    const f=await fixture();await f.tools.execute(f.commit(),f.ctx());
    f.s7.checks.result=async()=>({targetSha:H,status:'completed',conclusion:'failure',verifiedSuccess:false});
    await expect(f.result()).rejects.toThrow('api_check_target_mismatch');
    await expect(f.tools.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_wait_for_failed_ci');
  });
  it('a recreated host preserves correction budget and pending CI gate',async()=>{
    const f=await fixture();await f.tools.execute(f.commit(),f.ctx());
    const restarted=createS7Tools(f.options,f.s7);
    await expect(restarted.execute(f.commit(),f.ctx())).rejects.toThrow('api_write_wait_for_failed_ci');
    await f.result();
    expect(await restarted.execute(f.commit(),f.ctx())).toMatchObject({corrections_remaining:2});
  });
  it('reconciliation of durable escalation survives task becoming blocked',async()=>{
    const f=await fixture();await f.tools.execute(f.commit(),f.ctx());
    for(let i=0;i<3;i++){await f.result();await f.tools.execute(f.commit(),f.ctx());}
    const call={id:'r',name:'github_check_result',args:{name:f.name,sha:f.head(),run_id:99}},ctx=f.ctx();
    expect(await f.tools.execute(call,ctx)).toMatchObject({next_action:'escalate'});
    expect(await f.tools.lookup(call,ctx)).toMatchObject({found:true,result:{next_action:'escalate'}});
  });
  it('production engine enforces S7 even when the legacy global switch is enabled',async()=>{
    const f=await fixture();
    const env={AGENT_RUN_MODEL:'workers-ai:@cf/zai-org/glm-4.7-flash',AI:{async run(){return {};}},AGENT_RUN_REPOSITORY:REPO,AGENT_RUN_GITHUB_WRITES:'true'};
    const host=engineFor(env,db,f.reads,f.options.writes)(f.run).tools;
    await expect(host.execute(f.commit(),f.ctx())).rejects.toThrow('api_writer_not_enabled');
    expect(f.commits()).toBe(0);
  });
  it('configuration and edits fail closed',()=>{
    expect(()=>grants({tasks:'{}'})).toThrow('api_write_policy_invalid');
    expect(inPaths('src/demo2/a',['src/demo/'])).toBe(false);
    for(const [content,old] of [['aa','a'],['abc','x'],['abc','']])expect(()=>replaceOnce(content,old,'z')).toThrow();
    expect(replaceOnce('hello world','world','$&')).toBe('hello $&');
  });
});

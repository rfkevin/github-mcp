import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, storeCompletionVerified } from '../../../src/collab-store/agentrun/engine';
import { createNoChangeTools } from '../../../src/collab-store/agentrun/no-change';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow, insertEventRow } from '../a0-helpers';

const db=(env as unknown as {COLLAB_DB_C2:D1Database}).COLLAB_DB_C2;
const HEAD='a'.repeat(40), BASE='b'.repeat(40);
const CHECKS=['ci','Workers Builds: github-mcp','GitGuardian Security Checks','SonarCloud Code Analysis'];
let seq=0;
const now=()=>Math.floor(Date.now()/1000);
async function fixture(){
  const k=++seq,cycle='s9-nc-'+k+'-'+Date.now().toString(36);
  const owner='s9nc-gemini-'+k,reviewer='s9nc-vibe-'+k,tester='s9nc-grok-'+k;
  const task='fix',runId='api-implement-'+cycle;
  const branch='mcp/105856986/'+owner+'-api-d1234567890abcdef12345678';
  await insertCycleRow(db,cycle,'P6');
  await insertPhaseDefinition(db,cycle,'P6',[]);
  for(const p of [owner,reviewer,tester]){
    await db.prepare("INSERT OR IGNORE INTO participants(participant_id,display_label,status) VALUES (?1,?1,'active')")
      .bind(p).run();
  }
  await insertTaskRow(db,{cycle,taskId:task,owner,reviewer,tester});
  await db.prepare('UPDATE tasks SET owned_paths=?3 WHERE cycle_id=?1 AND task_id=?2')
    .bind(cycle,task,JSON.stringify(['src/demo/'])).run();
  const when=now();
  await createRun(db,{runId,cycleId:cycle,participantId:owner,taskId:task,taskKind:'implement',
    prompt:'fix',maxSteps:20,maxTokens:10000,maxCostCents:0,deadlineAt:when+3600,now:when});
  let prHead=HEAD,prBase=BASE,prOpen=true,prBranch=branch,ciGreen=true;
  const github={
    async getTextFile(){return {path:'demo',sha:'d'.repeat(40),content:'',size:0};},
    async getPullRequest(){return {number:337,state:prOpen?'open':'closed',merged:!prOpen,draft:false,
      head:{sha:prHead,ref:prBranch},base:{sha:prBase}};},
    async listCheckRuns(){return CHECKS.map((name,i)=>({id:i+10,name,status:'completed',
      conclusion:ciGreen?'success':'failure',head_sha:HEAD}));},
    async compareRefs(){return {files:[]};},
  };
  const policy={writers:owner,tasks:JSON.stringify([{cycle,task,participant:owner,branch,paths:['src/demo/']}])};
  const tools=createNoChangeTools({db,repository:'rfkevin/github-mcp',github,policy});
  const inputs={task,pr:337,head:HEAD,base:BASE,attestation:'Le rerun natif a réussi sur le même SHA ; aucun correctif de code n est nécessaire.'};
  const prior={task,state:'RUN_PROVEN',run_participant:owner,pr:337,head:HEAD,base:BASE,verified_success:true};
  await insertEventRow(db,{cycle,type:'run.proof',participant:'agentrun',role:'server',
    payload:prior,key:'proof:'+cycle});
  const proof=await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE cycle_id=?1 AND type='run.proof'")
    .bind(cycle).first<{seq:number}>();
  const correction={task,items:['Confirmer CI verte au même SHA'],reason:'flaky CI'};
  await insertEventRow(db,{cycle,type:'correction.request',participant:'gpt6',role:'coordinator',
    payload:correction,key:'correction:'+cycle});
  const row=await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE cycle_id=?1 AND type='correction.request'")
    .bind(cycle).first<{seq:number}>();
  const correction_seq=row!.seq;
  const call={id:'nc',name:'store_no_change_submit',args:{...inputs,correction_seq}};
  const ctx={run_id:runId,effect_key:'a'.repeat(64)};
  return {cycle,owner,reviewer,tester,runId,branch,proofSeq:proof!.seq,correction_seq,call,ctx,tools,
    setCi:(green:boolean)=>{ciGreen=green;},setHead:(head:string)=>{prHead=head;},
    setBase:(base:string)=>{prBase=base;},setBranch:(b:string)=>{prBranch=b;},
    setOpen:(b:boolean)=>{prOpen=b;}};
}

describe('CC8 S9 — resoumission explicite no-change après correction',()=>{
  it('attestation auteur : même preuve et SHA + CI verte → nouvelle soumission, jamais un verdict',async()=>{
    const f=await fixture();
    const result=await f.tools.execute(f.call,f.ctx) as {seq:number;status:string;type:string};
    expect(result).toMatchObject({type:'evidence.add',status:'applied'});
    const event=await db.prepare('SELECT participant_id,payload_json FROM events WHERE seq=?1')
      .bind(result.seq).first<{participant_id:string;payload_json:string}>();
    expect(event?.participant_id).toBe(f.owner);
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      task:'fix',origin:'author_no_change',state:'NO_CHANGE_SUBMITTED',head:HEAD,base:BASE,
      correction_seq:f.correction_seq,prior_proof_seq:f.proofSeq,
    });
    // L'effet D1 de la WorkSession suffit pour une complétion vérifiée du RUN,
    // même sans un second commit dans cette exécution.
    await db.prepare([
      'INSERT INTO agent_run_effects(effect_key,run_id,n,idx,tool,args,status,result,updated_at)',
      "VALUES(?1,?2,0,0,'store_no_change_submit',?3,'completed',?4,?5)",
    ].join(' ')).bind('eff:'+f.cycle,f.runId,JSON.stringify(f.call.args),JSON.stringify(result),now()).run();
    expect(await storeCompletionVerified(db,{run_id:f.runId,cycle_id:f.cycle,participant_id:f.owner,
      task_id:'fix',task_kind:'implement',prompt:'fix'})).toBe(true);
    const actions=await previewNextActions(db,f.cycle,f.owner,{all:true});
    expect(actions.all?.filter(x=>x.task_id==='fix').map(x=>x.action).sort()).toEqual(['review','test']);
    await expect(f.tools.execute(f.call,{run_id:f.runId,effect_key:'b'.repeat(64)}))
      .rejects.toThrow('NO_CHANGE_ALREADY_SUBMITTED');
  });

  it('CI rouge, PR différente, mauvaise base/branche : aucun effet',async()=>{
    const f=await fixture();
    f.setCi(false);await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_CI_NOT_VERIFIED_GREEN');
    f.setCi(true);f.setHead('c'.repeat(40));
    await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_PR_HEAD_OR_BRANCH_MISMATCH');
    f.setHead(HEAD);f.setBase('d'.repeat(40));
    await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_PR_HEAD_OR_BRANCH_MISMATCH');
    f.setBase(BASE);f.setBranch('mcp/105856986/other-api-branch');
    await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_PR_HEAD_OR_BRANCH_MISMATCH');
    f.setBranch(f.branch);f.setOpen(false);
    await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_PR_HEAD_OR_BRANCH_MISMATCH');
    const row=await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id=?1 AND type='evidence.add'")
      .bind(f.cycle).first<{n:number}>();
    expect(row?.n).toBe(0);
  });

  it('correction dépassée et verdict négatif : pas de raccourci sur D12',async()=>{
    const f=await fixture();
    await expect(f.tools.execute({...f.call,args:{...f.call.args,correction_seq:1}},f.ctx))
      .rejects.toThrow('NO_CHANGE_CORRECTION_STALE');
    await insertEventRow(db,{cycle:f.cycle,type:'evidence.add',participant:f.reviewer,role:'reviewer',
      payload:{task:'fix',source:'github',pr:337,head:HEAD,base:BASE,state:'CHANGES_REQUESTED'},key:'d12:'+f.cycle});
    await expect(f.tools.execute(f.call,f.ctx)).rejects.toThrow('NO_CHANGE_D12_VERDICT_ALREADY_EXISTS');
  });

  it('lecture des erreurs de SES anciens runs, jamais des arguments ni erreurs des autres',async()=>{
    const f=await fixture();
    const foreign=await fixture();
    const key='failure:'+f.cycle;
    await db.prepare([
      'INSERT INTO agent_run_effects(effect_key,run_id,n,idx,tool,args,status,result,updated_at)',
      "VALUES(?1,?2,6,0,'github_replace_text',?3,'failed',?4,?5)",
    ].join(' ')).bind(key,f.runId,JSON.stringify({secret:'SHOULD_NOT_LEAK'}),
      JSON.stringify({error:'api_write_wait_for_failed_ci'}),now()).run();
    const host=createReadToolHost({db,repository:null,github:null,unifiedCapabilities:true});
    const output=await host.execute({id:'diag',name:'store_run_diagnostics',args:{run_id:f.runId}},
      {run_id:f.runId}) as Record<string,unknown>;
    expect(output.errors).toMatchObject([{step:6,tool:'github_replace_text',error:'api_write_wait_for_failed_ci'}]);
    expect(JSON.stringify(output)).not.toContain('SHOULD_NOT_LEAK');
    await expect(host.execute({id:'foreign',name:'store_run_diagnostics',args:{run_id:foreign.runId}},
      {run_id:f.runId})).rejects.toThrow('run_not_owned_or_unknown');
  });
});

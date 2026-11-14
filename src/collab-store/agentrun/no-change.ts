/**
 * CC8 S9 — resoumission EXPLICITE de l'auteur au même SHA, sans faux commit.
 * D12 et la CI restent indépendants. Cette voie ne peut pas clore une
 * correction sur une PR déjà rejetée par un relecteur/testeur.
 */
import { CollabStore } from '../store/collab-store';
import { assertAutomationRunning } from '../owner/automation';
import { ToolRefused, type ToolCall, type LookupResult } from './engine';
import { exactGrant, authorize, type WritePolicy } from './github-write/authorization';
import { effectOpId } from './store-tools';
import { nativeCiState, type CiCheck } from '../controller/ci-transition';
import { VERDICT_REQUIRED_CHECKS } from './verdict-tools';
import type { GitHubReads } from './read-tools';
import type { ToolSchema } from './workers-ai-model';

const SHA=/^[a-f0-9]{40}$/;
const TASK=/^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const NO_CHANGE_TOOL='store_no_change_submit';
export const NO_CHANGE_SCHEMA: ToolSchema={
  name:NO_CHANGE_TOOL,
  description:'Auteur API seulement. Après correction.request et lorsqu aucun changement n est requis, confirmer explicitement le code déjà soumis. Le serveur vérifie ancien run.proof, même PR/branche/head/base, CI native verte et absence de verdict D12. Ne crée pas de commit ni de verdict. Attestation motivée obligatoire.',
  parameters:{type:'object',properties:{
    task:{type:'string'},pr:{type:'integer',minimum:1},
    head:{type:'string',pattern:SHA.source},base:{type:'string',pattern:SHA.source},
    correction_seq:{type:'integer',minimum:1},
    attestation:{type:'string',minLength:20,maxLength:1000},
  },required:['task','pr','head','base','correction_seq','attestation'],additionalProperties:false},
};

export interface NoChangeOptions {
  db:D1Database; repository:string; github:GitHubReads; policy:WritePolicy;
  requiredChecks?:readonly string[];
}
type Run={cycle_id:string;participant_id:string;task_id:string;task_kind:string;status:string};
type P={task?:unknown;state?:unknown;pr?:unknown;head?:unknown;base?:unknown;verified_success?:unknown;run_participant?:unknown};
const obj=(value:string):P|null=>{try{
  const p:unknown=JSON.parse(value);
  return p&&typeof p==='object'&&!Array.isArray(p)?p as P:null;
}catch{return null;}};
function fields(args:Record<string,unknown>){
  const {task,pr,head,base,correction_seq,attestation}=args;
  if(typeof task!=='string'||!TASK.test(task)
    ||typeof pr!=='number'||!Number.isSafeInteger(pr)||pr<1||pr>100_000_000
    ||typeof head!=='string'||!SHA.test(head)||typeof base!=='string'||!SHA.test(base)
    ||typeof correction_seq!=='number'||!Number.isSafeInteger(correction_seq)||correction_seq<1
    ||typeof attestation!=='string'||attestation.trim().length<20||attestation.length>1000)
    throw new ToolRefused('NO_CHANGE_ARGS_INVALID');
  return {task,pr,head,base,correction_seq,attestation:attestation.trim()};
}
export function createNoChangeTools(options:NoChangeOptions){
  async function runScope(runId:string):Promise<Run>{
    const run=await options.db.prepare([
      'SELECT cycle_id,participant_id,task_id,task_kind,status FROM agent_runs WHERE run_id=?1',
    ].join(' ')).bind(runId).first<Run>();
    if(!run||run.status!=='running'||run.task_kind!=='implement'||!run.task_id)
      throw new ToolRefused('NO_CHANGE_RUN_NOT_ACTIVE');
    return run;
  }
  async function execute(call:ToolCall,ctx:{run_id:string;effect_key?:string}):Promise<unknown>{
    if(!ctx.effect_key)throw new ToolRefused('effect_key_required');
    const args=fields(call.args??{}),run=await runScope(ctx.run_id);
    if(args.task!==run.task_id)throw new ToolRefused('NO_CHANGE_TASK_MISMATCH');
    const grant=await exactGrant(options.db,options.policy,run.cycle_id,run.task_id,run.participant_id);
    if(!grant)throw new ToolRefused('NO_CHANGE_GRANT_MISSING');
    await authorize(options.db,options.policy,ctx.run_id,grant.branch);
    // Révision figée AVANT lectures GitHub pour écarter toute correction concurrente.
    const store=new CollabStore(options.db);
    const revision=await store.currentRevision(run.cycle_id);
    // Les arguments PR/SHA ne donnent pas d'autorisation : tous relus au GitHub.
    const pull=await options.github.getPullRequest(options.repository,args.pr) as Record<string,unknown>|null;
    const head=pull?.head as Record<string,unknown>|undefined;
    const base=pull?.base as Record<string,unknown>|undefined;
    if(!pull||pull.number!==args.pr||pull.state!=='open'||pull.merged===true||pull.draft===true
      ||head?.sha!==args.head||base?.sha!==args.base||head?.ref!==grant.branch)
      throw new ToolRefused('NO_CHANGE_PR_HEAD_OR_BRANCH_MISMATCH');
    const raw=await options.github.listCheckRuns(options.repository,args.head) as Array<Record<string,unknown>>;
    const checks:CiCheck[]=raw.flatMap(v=>
      Number.isSafeInteger(v.id)&&typeof v.name==='string'&&typeof v.status==='string'
        ?[{id:v.id as number,name:v.name,status:v.status,conclusion:typeof v.conclusion==='string'?v.conclusion:null,
          ...(typeof v.head_sha==='string'?{head_sha:v.head_sha}:{})}]:[]);
    if(nativeCiState(checks,args.head,options.requiredChecks?.length?options.requiredChecks:VERDICT_REQUIRED_CHECKS).state!=='passed')
      throw new ToolRefused('NO_CHANGE_CI_NOT_VERIFIED_GREEN');
    const correction=await options.db.prepare([
      "SELECT seq FROM events WHERE cycle_id=?1 AND type='correction.request' AND json_valid(payload_json)",
      "AND json_extract(payload_json,'$.task')=?2 ORDER BY seq DESC LIMIT 1",
    ].join(' ')).bind(run.cycle_id,run.task_id).first<{seq:number}>();
    if(!correction||correction.seq!==args.correction_seq)throw new ToolRefused('NO_CHANGE_CORRECTION_STALE');
    // Une soumission récente interdit la répétition d'une correction déjà traitée.
    const submitted=await options.db.prepare([
      'SELECT 1 FROM events WHERE cycle_id=?1 AND seq>?2 AND',
      "((type IN ('run.proof','run.reconcile') AND participant_id='agentrun')",
      "OR (type='evidence.add' AND participant_id=?3))",
      "AND json_valid(payload_json) AND json_extract(payload_json,'$.task')=?4 LIMIT 1",
    ].join(' ')).bind(run.cycle_id,correction.seq,run.participant_id,run.task_id).first();
    if(submitted)throw new ToolRefused('NO_CHANGE_ALREADY_SUBMITTED');
    // Une CHANGES_REQUESTED, FAIL ou même un AGREE/PASS préexistant ne doit jamais
    // être réutilisé pour franchir D12 sur une resoumission sans diff.
    const verdicts=await options.db.prepare([
      "SELECT 1 FROM events WHERE cycle_id=?1 AND type='evidence.add'",
      "AND json_valid(payload_json) AND json_extract(payload_json,'$.task')=?2",
      "AND json_extract(payload_json,'$.head')=?3 AND json_extract(payload_json,'$.base')=?4",
      "AND json_extract(payload_json,'$.state') IN ('AGREE','PASS','FAIL','CHANGES_REQUESTED') LIMIT 1",
    ].join(' ')).bind(run.cycle_id,run.task_id,args.head,args.base).first();
    if(verdicts)throw new ToolRefused('NO_CHANGE_D12_VERDICT_ALREADY_EXISTS');
    const {results}=await options.db.prepare([
      "SELECT seq,payload_json FROM events WHERE cycle_id=?1 AND type='run.proof'",
      "AND participant_id='agentrun' AND seq<?2 AND json_valid(payload_json)",
      "AND json_extract(payload_json,'$.task')=?3",
      "AND json_extract(payload_json,'$.pr')=?4",
      "AND json_extract(payload_json,'$.head')=?5 AND json_extract(payload_json,'$.base')=?6",
      'ORDER BY seq DESC LIMIT 10',
    ].join(' ')).bind(run.cycle_id,correction.seq,run.task_id,args.pr,args.head,args.base)
      .all<{seq:number;payload_json:string}>();
    const prior=results.find(row=>{
      const p=obj(row.payload_json);
      return p?.state==='RUN_PROVEN'&&p.verified_success===true&&p.run_participant===run.participant_id;
    });
    if(!prior)throw new ToolRefused('NO_CHANGE_PRIOR_PROOF_MISSING');
    // L'événement evidence.add vaut soumission de l'auteur, JAMAIS approbation D12.
    const payload={task:run.task_id,source:'github',state:'NO_CHANGE_SUBMITTED',
      origin:'author_no_change',pr:args.pr,head:args.head,base:args.base,
      correction_seq:correction.seq,prior_proof_seq:prior.seq,
      attestation:args.attestation,verified_success:true};
    await assertAutomationRunning(options.db);
    const outcome=await store.appendEvent({cycle_id:run.cycle_id,participant_id:run.participant_id,
      type:'evidence.add',expected_rev:revision,payload_json:JSON.stringify(payload),
      op_id:effectOpId(run.participant_id,run.cycle_id,ctx.effect_key),role:'owner'});
    if(outcome.status==='stale')throw new ToolRefused('NO_CHANGE_CONCURRENT_CHANGE_RECHECK');
    if(outcome.status==='quota_exhausted')throw new ToolRefused('QUOTA_EXHAUSTED');
    return {seq:outcome.event.seq,type:'evidence.add',status:outcome.status,
      head:args.head,base:args.base,next_action:'request_independent_D12'};
  }
  return {execute,
    async lookup(call:ToolCall,ctx:{run_id:string;effect_key:string}):Promise<LookupResult>{
      const run=await runScope(ctx.run_id);
      const key='op:'+effectOpId(run.participant_id,run.cycle_id,ctx.effect_key);
      const hit=await options.db.prepare('SELECT seq FROM events WHERE idempotency_key=?1')
        .bind(key).first<{seq:number}>();
      return hit?{found:true,result:{seq:hit.seq,type:'evidence.add',status:'duplicate'}}:{found:false};
    },
  };
}

import { describe, expect, it } from 'vitest';
import { readPreparationEvidence, PREPARATION_ROUNDS_MAX, preparationViolation } from
  '../../../src/collab-store/agentrun/guided-preparation';
import { type ToolCall, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { T, BASE, HEAD, C1, BRANCH, PATH, SCOPE, PASSED, newRun, host, scripted, drive, row, commitAs }
  from './s7-guided-harness';

const SOURCE='src/collab-store/agentrun/s7-guided.ts';
const source={path:SOURCE,sha:'3'.repeat(40),size:210,content:'export function planGuidedS7(entries: readonly GuidedEntry[], branch: string, taskId: string, step: number) { return { kind:"stop" }; }'};
const call=(name:string,args:Record<string,unknown>,id:string):ToolCall=>({name,args,id});
const readCalls:ToolCall[]=[
  call('store_context',{},'ctx'),
  call('store_delta',{since_seq:0,limit:50},'delta'),
  call('store_memory',{},'memory'),
  call('store_continuity',{},'continuity'),
  call('github_read_file',{path:SOURCE,ref:BASE},'src'),
];
const responses:Record<string,unknown>={
  ctx:{cycle_id:'x',revision:3,phase:'P6',tasks:[]},
  delta:{events:[],has_more:false},memory:{entries:[]},continuity:{handovers:[],api_runs:[]},
  src:source,
};
const record=(calls:ToolCall[],values:Record<string,unknown>,failed:string[]=[])=>
  ({model_output:JSON.stringify({text:'Analyse des fichiers',tool_calls:calls}),
    results:JSON.stringify(calls.map(c=>({id:c.id,content:JSON.stringify(values[c.id]??{error:'missing'}),
      ...(failed.includes(c.id)?{error:true}:{})})))});
const HANDOVER={text:'',tool_calls:[call('store_handover',{done:'PR ouverte',todo:'Revue D12',learned:'Signature vérifiée dans source'},'pass')]};
const CODE="import { describe, it, expect } from 'vitest';\n"+
  "import { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n"+
  "describe('S7',()=>{it('exports a function',()=>{expect(typeof planGuidedS7).toBe('function');});});";

function consultantHost() {
  const adapter=host({
    github_write_scope:[SCOPE],
    github_create_branch:[{sha:HEAD,branch:BRANCH}],
    github_commit_files:[{branch:BRANCH,commit_sha:C1}],
    github_run_checks:[{targetSha:C1,runId:1001,status:'requested'}],
    github_check_result:[PASSED(C1)],
    github_open_pr:[{branch:BRANCH,head_sha:C1,number:901,draft:false}],
    store_handover:[{seq:99,type:'checkpoint',status:'applied'}],
  });
  const seenRead:string[]=[];
  const available=new Set(['store_context','store_delta','store_memory','store_continuity','github_read_file','github_list_directory']);
  const allowedWrites=new Set(['store_handover','store_memory_propose','store_memory_rewrite']);
  const tools:ToolHost={
    list:(kind:string)=>[...new Set([...adapter.tools.list(kind),...available,...allowedWrites])],
    spec:(kind:string,name:string)=>available.has(name)?{name,effect:'read'}
      :allowedWrites.has(name)?{name,effect:'write'}:adapter.tools.spec(kind,name),
    async execute(c,ctx) {
      if(available.has(c.name)) {
        seenRead.push(c.name);
        if(c.name==='github_list_directory') return {path:c.args.path,ref:c.args.ref,entries:[{name:'s7-guided.ts',path:SOURCE,type:'file',size:210,sha:source.sha}],truncated:false};
        if(c.name==='github_read_file') {
          if(c.args.path===SOURCE && c.args.ref===BASE) return source;
          if(c.args.path==='package.json' && c.args.ref===HEAD)
            return {path:'package.json',sha:'4'.repeat(40),size:100,content:JSON.stringify({devDependencies:{vitest:'1.0.0'}})};
          throw new Error('File not found for source proof');
        }
        if(c.name==='store_context') return responses.ctx;
        if(c.name==='store_delta') return responses.delta;
        if(c.name==='store_memory') return responses.memory;
        if(c.name==='store_continuity') return responses.continuity;
      }
      return adapter.tools.execute(c,ctx);
    },
  };
  return {tools,adapter,seenRead};
}

describe('CC8 S7 consultant : mémoire et analyse avant codage',()=>{
  it('exige contexte, mémoire, continuité et fichier source au SHA base',()=>{
    expect(readPreparationEvidence([record(readCalls,responses)],BASE,[PATH]))
      .toMatchObject({rounds:1,prepared:true,missing:[],source_paths:[SOURCE]});
    expect(readPreparationEvidence([record(readCalls,responses,['src'])],BASE,[PATH]).prepared).toBe(false);
    const wrong=readCalls.map(c=>c.name==='github_read_file'?{...c,args:{path:SOURCE,ref:'a'.repeat(40)}}:c);
    expect(readPreparationEvidence([record(wrong,responses)],BASE,[PATH]).prepared).toBe(false);
    const own=readCalls.map(c=>c.name==='github_read_file'?{...c,args:{path:PATH,ref:BASE}}:c);
    expect(readPreparationEvidence([record(own,responses)],BASE,[PATH]).prepared).toBe(false);
    expect(readPreparationEvidence([record(readCalls.filter(c=>c.name!=='store_memory'),responses)],BASE,[PATH]).missing)
      .toContain('store_memory');
  });
  it('interdit github_commit_files, les réponses sans outil et les appels étrangers en consultation',()=>{
    expect(preparationViolation(commitAs('github_commit_files',CODE),['store_context','github_read_file']))
      .toMatch(/tool_not_offered/);
    expect(preparationViolation({text:'j’ai lu',tool_calls:[]},['store_context'])).toBe('no_tool_call');
    expect(preparationViolation({text:'',tool_calls:readCalls},readCalls.map(c=>c.name))).toBeNull();
    expect(preparationViolation({text:'',tool_calls:[call('github_list_directory',{path:'',ref:BASE},'tree')]},
      ['github_list_directory'])).toBeNull();
    expect(PREPARATION_ROUNDS_MAX).toBe(3);
  });
  it('exploration de répertoire : le modèle consulte les sources sans chemin préconnu',async()=>{
    const s=await newRun('consultant-discovery');
    const h=consultantHost();
    const first=call('github_list_directory',{path:'src/collab-store/agentrun',ref:BASE},'tree');
    const model=scripted([{text:'Je découvre les chemins.',tool_calls:[first]},
      {text:'Je lis mémoire, contexte et signature réelle.',tool_calls:readCalls},
      commitAs('github_commit_files',CODE),HANDOVER]);
    const outcomes=await drive(s.runId,{model:model.client,tools:h.tools,now:()=>T+100,workerId:'consultant',
      guidedS7:true,guidedPreparation:true,githubCompletionGrants:s.grants});
    expect(outcomes.at(-1), JSON.stringify({outcomes, run: await row(s.runId)})).toBe('completed');
    expect(model.seen).toHaveLength(4);
    expect(model.seen[0].tools).toContain('github_list_directory');
    expect(model.seen[2].tools).toEqual(['github_commit_files']);
    expect(model.seen[3].tools).toContain('store_handover');
  });
  it('les résultats de contexte, mémoire et source restent visibles au modèle AVANT le commit',async()=>{
    const s=await newRun('consultant-verified');
    const h=consultantHost();
    const model=scripted([{text:'Je commence par les sources.',tool_calls:readCalls},
      commitAs('github_commit_files',CODE),HANDOVER]);
    const outcomes=await drive(s.runId,{model:model.client,tools:h.tools,now:()=>T+100,workerId:'consultant',
      guidedS7:true,guidedPreparation:true,compactHistory:true,githubCompletionGrants:s.grants});
    expect(outcomes.at(-1), JSON.stringify({outcomes, run: await row(s.runId)})).toBe('completed');
    expect(h.seenRead.slice(0,readCalls.length)).toEqual(readCalls.map(x=>x.name));
    expect(model.seen).toHaveLength(3);
    expect(model.seen[0].tools).toEqual([...readCalls.map(c=>c.name),'github_list_directory']);
    expect(model.seen[1].tools).toEqual(['github_commit_files']);
    expect(model.seen[2].tools).toContain('store_handover');
    const prompt=JSON.stringify(model.seen[1].messages);
    expect(prompt).toContain('planGuidedS7(entries: readonly GuidedEntry[]');
    expect(prompt).toContain('continuity');
    expect(prompt).toContain('memory');
    expect((await row(s.runId)).status).toBe('completed');
  });
  it('en cas de source manquante : trois lectures puis arrêt typé SANS commit',async()=>{
    const s=await newRun('consultant-insufficient');
    const h=consultantHost();
    const calls=readCalls.filter(c=>c.name!=='github_read_file');
    const model=scripted([1,2,3].map(()=>({text:'Source pas encore trouvé',tool_calls:calls})));
    const outcomes=await drive(s.runId,{model:model.client,tools:h.tools,now:()=>T+100,workerId:'consultant',
      guidedS7:true,guidedPreparation:true,githubCompletionGrants:s.grants});
    expect(outcomes.at(-1)).toBe('failed');
    expect(model.seen).toHaveLength(3);
    expect((await row(s.runId)).stop_reason).toBe('guided_stop:preparation_incomplete');
    expect(h.adapter.writes()).toEqual(['github_write_scope','github_create_branch']);
  });
  it('le mode non activé conserve le comportement S7 précédent',async()=>{
    const s=await newRun('consultant-off');
    const h=consultantHost();
    const model=scripted([commitAs('github_commit_files',CODE)]);
    const outcomes=await drive(s.runId,{model:model.client,tools:h.tools,now:()=>T+100,workerId:'legacy',
      guidedS7:true,githubCompletionGrants:s.grants});
    expect(outcomes.at(-1), JSON.stringify({outcomes, run: await row(s.runId)})).toBe('completed');
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0].tools).toContain('github_commit_files');
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { createStoreWriteTools } from '../../../src/collab-store/agentrun/store-tools';
import { loadContinuity } from '../../../src/collab-store/context/continuity';
import { MemoryStore } from '../../../src/collab-store/memory/memory-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let serial=0;
const key = (c:string)=>c.repeat(64);
async function fixture() {
  await ensureSchema(db);
  const n=++serial;
  const cycle='s7-mem-bridge-'+n+'-'+Date.now().toString(36);
  const participant='s7-bridge-agent-'+n;
  const peer='s7-bridge-peer-'+n;
  await insertCycleRow(db,cycle,'P6');
  await insertPhaseDefinition(db,cycle,'P6',[]);
  await insertTaskRow(db,{cycle,taskId:'bridge',owner:participant,reviewer:peer,tester:'s7-bridge-t-'+n});
  const runId=cycle+'-run';
  const now=Math.floor(Date.now()/1000);
  const created=await createRun(db,{runId,cycleId:cycle,participantId:participant,taskId:'bridge',taskKind:'implement',
    prompt:'Analyze and hand over',maxSteps:12,maxTokens:48000,maxCostCents:0,deadlineAt:now+900,now});
  expect(created.created).toBe(true);
  return {cycle,participant,peer,runId,scope:'participant:'+participant};
}
describe('CC8 S7 consultant : mémoire C4 éditable et passation chat/API',()=>{
  it('outils de passation et correction disponibles uniquement avec continuité activée',()=>{
    const active=createReadToolHost({db,repository:null,github:null,storeWrites:true,continuity:true});
    const old=createReadToolHost({db,repository:null,github:null,storeWrites:true,continuity:false});
    for(const name of ['store_memory_propose','store_memory_rewrite','store_handover']) {
      expect(active.spec('implement',name)).toEqual({name,effect:'write'});
      expect(old.spec('implement',name)).toBeNull();
    }
  });
  it('passation écrite par API puis relue sous la même identité avec reprise idempotente',async()=>{
    const f=await fixture();
    const store=createStoreWriteTools(db);
    const tool={id:'pass',name:'store_handover',
      args:{done:'Lecture réelle du code confirmée',todo:'Faire reviewer la PR',learned:'Signature à 5 arguments'}};
    const ctx={run_id:f.runId,effect_key:key('a')};
    const first=await store.execute(tool,ctx) as {seq:number;type:string;status:string};
    expect(first).toMatchObject({type:'checkpoint',status:'applied'});
    expect(await store.execute(tool,ctx)).toMatchObject({seq:first.seq,status:'duplicate'});
    const nextChat=await loadContinuity(db,f.cycle,[f.participant]);
    expect(nextChat.handovers[0]).toMatchObject({seq:first.seq,channel:'api',
      done:'Lecture réelle du code confirmée',todo:'Faire reviewer la PR',learned:'Signature à 5 arguments'});
  });
  it('proposer une leçon puis réviser la mémoire active via C4 : version candidate et revue distincte',async()=>{
    const f=await fixture();
    const c4=new MemoryStore(db);
    const store=createStoreWriteTools(db);
    const proposal=await store.execute({id:'create',name:'store_memory_propose',
      args:{kind:'lesson',text:'L ancienne signature était mal décrite',confidence:'observed',
        evidence_refs:['sha:base']}},
    {run_id:f.runId,effect_key:key('b')}) as {status:string};
    expect(proposal.status).toBe('applied');
    const row=await db.prepare("SELECT id, version FROM memory_entries WHERE scope=?1 AND status='candidate' ORDER BY id DESC LIMIT 1")
      .bind(f.scope).first<{id:string;version:number}>();
    expect(row).not.toBeNull();
    await c4.activate(row!.id,1,f.peer,f.cycle);
    const rewrite={id:'rewrite',name:'store_memory_rewrite',
      args:{id:row!.id,text:'Signature réelle vérifiée dans le code source, 5 paramètres.',
        evidence_refs:['sha:base','test:CI']}};
    const event=await store.execute(rewrite,{run_id:f.runId,effect_key:key('c')}) as {type:string;status:string};
    expect(event).toMatchObject({type:'memory.consolidate',status:'applied'});
    expect(await c4.get(row!.id,1)).toMatchObject({status:'superseded'});
    expect(await c4.get(row!.id,2)).toMatchObject({status:'candidate',text:rewrite.args.text});
    // Un chat suivant ne prend pas une candidate pour une mémoire déjà validée.
    expect((await c4.listActiveFor(f.participant,[f.scope])).find(x=>x.id===row!.id)).toBeUndefined();
    await c4.activate(row!.id,2,f.peer,f.cycle);
    expect((await c4.listActiveFor(f.participant,[f.scope])).find(x=>x.id===row!.id))
      .toMatchObject({version:2,status:'active',text:rewrite.args.text});
  });
  it('refuse une passation vide et une réécriture sans preuves',async()=>{
    const f=await fixture();
    const store=createStoreWriteTools(db);
    await expect(store.execute({id:'bad',name:'store_handover',args:{}},
      {run_id:f.runId,effect_key:key('d')})).rejects.toThrow();
    await expect(store.execute({id:'bad2',name:'store_memory_rewrite',args:{id:'x',text:'bad',evidence_refs:[]}},
      {run_id:f.runId,effect_key:key('e')})).rejects.toThrow();
  });
});

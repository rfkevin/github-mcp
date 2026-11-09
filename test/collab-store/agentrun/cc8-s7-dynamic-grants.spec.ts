import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';
import { launchCoordinatorImplement } from '../../../src/collab-store/agentrun/coordinator-launch';
import { authorize, exactGrant } from '../../../src/collab-store/agentrun/github-write/authorization';
import { issueDynamicGrant, findDynamicGrant, parseDynamicGrantPolicy, DYNAMIC_GRANT_TTL_SECONDS }
  from '../../../src/collab-store/agentrun/github-write/dynamic-grants';
import { isCoordinator } from '../../../src/collab-store/owner/coordinators';
import { collabFailure } from '../../../src/collab-store/mcp/result';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';

const db=(env as unknown as {COLLAB_DB_C2:D1Database}).COLLAB_DB_C2;
let seq=0;
const PREFIX='test/collab-store/agentrun/';
const NOW=()=>Math.floor(Date.now()/1000);

async function setup(label:string) {
  const k=++seq;
  const cycle='s7-dyn-'+label+'-'+k+'-'+Date.now().toString(36);
  const coordinator='s7dyn-c-'+k, gemini='s7dyn-g-'+k, vibe='s7dyn-v-'+k, grok='s7dyn-t-'+k;
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  await insertCycleRow(db,cycle,'P6');
  await insertPhaseDefinition(db,cycle,'P6',[]);
  for (const pid of [coordinator,gemini,vibe,grok]) {
    await registerParticipant(db,{participant_id:pid,display_label:pid,
      proof:OWNER_PROOF,op:'s7dyn-register-'+pid});
  }
  await db.prepare("INSERT INTO coordinators(participant_id,status,event_seq,updated_at) VALUES(?1,'active',NULL,?2)")
    .bind(coordinator,NOW()).run();
  const policy=JSON.stringify({cycle,participants:[gemini,vibe],path_prefixes:[PREFIX],max_paths:1,max_grants:4});
  const runtime={AGENT_RUNS_ENABLED:'true',AGENT_RUN_GITHUB_WRITES:'true',
    AGENT_RUN_PARTICIPANTS:[gemini,vibe].join(','),
    AGENT_RUN_GITHUB_WRITERS:[gemini,vibe].join(','),
    AGENT_RUN_GITHUB_TASKS:'[]',AGENT_RUN_DYNAMIC_SCOPE:policy,
    AGENT_RUN_MODEL:'workers-ai:@cf/zai-org/glm-4.7-flash',AI:{},
    AGENT_RUN:{} as never} as unknown as AgentRunObjectEnv;
  const wakes:string[]=[];
  const make=(task:string,participant:string,reviewer:string,path:string,op:string)=>({
    db,store:new CollabStore(db,{dailyWriteLimit:100000}),env:runtime,
    coordinator,cycle,task,participant,reviewer,tester:grok,
    paths:[path],acceptance:['Tester une fonction réelle au SHA source.'],
    takeoverChat:false,opId:coordinator+':'+cycle+':'+op+':1',now:NOW(),
    wake:async(_lease:string,run_id:string)=>{wakes.push(run_id);return {accepted:true as const};},
  });
  return {cycle,coordinator,gemini,vibe,grok,policy,runtime,wakes,make};
}

describe('CC8 — dynamic D1 GitHub grants, owner bounded, no PR per task',()=>{
  it('configuration absente ou malformée : aucune autorisation automatique',()=>{
    expect(parseDynamicGrantPolicy(undefined)).toBeNull();
    expect(()=>parseDynamicGrantPolicy('{broken')).toThrow();
    expect(()=>parseDynamicGrantPolicy(JSON.stringify({
      cycle:'cc8-systeme-unique',participants:['vibe'],path_prefixes:['/'],max_paths:1,max_grants:20,
    }))).toThrow();
    expect(()=>parseDynamicGrantPolicy(JSON.stringify({
      cycle:'cc8-systeme-unique',participants:['vibe'],path_prefixes:['.github/'],max_paths:1,max_grants:20,
    }))).toThrow();
  });

  it('grant immuable + redémarrage et même intention idempotents ; sortie de périmètre refusée',async()=>{
    const s=await setup('frozen'),task='dyn-frozen';
    const path=PREFIX+'dyn-frozen.spec.ts';
    const input={cycle:s.cycle,task,participant:s.gemini,paths:[path],
      acceptance:['Tester la préparation en lecture seule.'],coordinator:s.coordinator,now:NOW()};
    const grant=await issueDynamicGrant(db,s.policy,input);
    expect(grant).toMatchObject({cycle:s.cycle,task,participant:s.gemini,paths:[path],mission:'functional'});
    expect(grant.branch).toMatch(/^mcp\/105856986\/s7dyn-g-\d+-api-d[a-f0-9]{24}$/);
    expect(await issueDynamicGrant(db,s.policy,input)).toEqual(grant);
    await expect(issueDynamicGrant(db,s.policy,{...input,paths:[PREFIX+'other.spec.ts']})).rejects.toThrow();
    await expect(issueDynamicGrant(db,s.policy,{...input,task:'dyn-outside',
      paths:['src/collab-store/agentrun/engine.ts']})).rejects.toThrow();
    await expect(issueDynamicGrant(db,s.policy,{...input,task:'dyn-protected',
      paths:['.github/workflows/ci.yml']})).rejects.toThrow();
    const row=await db.prepare('SELECT created_by,expires_at,paths_json FROM api_dynamic_grants WHERE cycle=?1 AND task=?2')
      .bind(s.cycle,task).first<{created_by:string;expires_at:number;paths_json:string}>();
    expect(row?.created_by).toBe(s.coordinator);
    await expect(db.prepare('UPDATE api_dynamic_grants SET paths_json=?1 WHERE cycle=?2 AND task=?3')
      .bind(JSON.stringify(['src/secret.ts']),s.cycle,task).run()).rejects.toThrow();
    expect(await findDynamicGrant(db,s.policy,s.cycle,task,s.gemini,input.now+DYNAMIC_GRANT_TTL_SECONDS+1)).toBeNull();
    expect(await findDynamicGrant(db,undefined,s.cycle,task,s.gemini)).toBeNull();
  });

  it('un coordinateur lance Gemini puis Vibe : deux tâches, deux grants D1, deux runs concurrents',async()=>{
    const s=await setup('parallel');
    const a=s.make('dyn-gemini',s.gemini,s.vibe,PREFIX+'dyn-gemini.spec.ts','launch-gemini');
    const b=s.make('dyn-vibe',s.vibe,s.gemini,PREFIX+'dyn-vibe.spec.ts','launch-vibe');
    const first=await launchCoordinatorImplement(a);
    const second=await launchCoordinatorImplement(b);
    expect(first.status).toBe('started');
    expect(second.status).toBe('started');
    expect(first.run_id).not.toBe(second.run_id);
    expect(s.wakes).toEqual([first.run_id,second.run_id]);
    const {results}=await db.prepare("SELECT run_id,task_id,participant_id,status,cost_cents FROM agent_runs WHERE run_id IN (?1,?2) ORDER BY task_id")
      .bind(first.run_id,second.run_id).all<{run_id:string;task_id:string;participant_id:string;status:string;cost_cents:number}>();
    expect(results).toHaveLength(2);
    expect(results.map(x=>x.status)).toEqual(['running','running']);
    expect(results.map(x=>x.cost_cents)).toEqual([0,0]);
    const policy={writers:s.runtime.AGENT_RUN_GITHUB_WRITERS,tasks:s.runtime.AGENT_RUN_GITHUB_TASKS,dynamic:s.policy};
    const grant=await exactGrant(db,policy,s.cycle,'dyn-gemini',s.gemini);
    expect(grant?.paths).toEqual(a.paths);
    expect((await authorize(db,policy,first.run_id,grant!.branch)).owned_paths).toEqual(a.paths);
    expect((await launchCoordinatorImplement(a)).status).toBe('existing');
    expect(s.wakes).toHaveLength(2);
    await expect(launchCoordinatorImplement({...a,paths:[PREFIX+'changed.spec.ts'],
      opId:s.coordinator+':'+s.cycle+':launch-mutated:1'})).rejects.toThrow();
    // Owner can disable the whole dynamic scope in one config change; D1 rows remain but lose authority.
    await expect(authorize(db,{...policy,dynamic:undefined},first.run_id,grant!.branch)).rejects.toThrow();
  });

  it('un coordinateur révoqué reçoit un refus précis',async()=>{
    const s=await setup('limit');
    const i={cycle:s.cycle,task:'dyn-limit',participant:s.gemini,paths:[PREFIX+'dyn-limit.spec.ts'],
      coordinator:s.coordinator,now:NOW()};
    await db.prepare("UPDATE coordinators SET status='revoked' WHERE participant_id=?1").bind(s.coordinator).run();
    await expect(issueDynamicGrant(db,s.policy,i)).rejects.toThrow('dynamic_coordinator_not_active');
  });
  it('le coordinateur peut lancer sous un alias owner-approved ; audit et révocation restent effectifs',async()=>{
    const s=await setup('alias'), alias=s.coordinator+'-alias';
    await registerParticipant(db,{participant_id:alias,display_label:alias,
      proof:OWNER_PROOF,op:'s7dyn-register-'+alias});
    for (const pid of [s.coordinator,alias]) {
      await db.prepare('INSERT INTO participant_identity_families(participant_id,family_id,event_seq,updated_at) VALUES(?1,?2,NULL,?3)')
        .bind(pid,'family-'+s.coordinator,NOW()).run();
    }
    expect(await isCoordinator(db,alias)).toBe(true);
    const input={...s.make('alias-run',s.gemini,s.vibe,PREFIX+'alias.spec.ts','alias-launch'),
      coordinator:alias,opId:alias+':'+s.cycle+':alias-launch:1'};
    const first=await launchCoordinatorImplement(input);
    expect(first.status).toBe('started');
    const row=await db.prepare('SELECT created_by FROM api_dynamic_grants WHERE cycle=?1 AND task=?2')
      .bind(s.cycle,input.task).first<{created_by:string}>();
    expect(row?.created_by).toBe(alias);
    const grant=await findDynamicGrant(db,s.policy,s.cycle,input.task,s.gemini);
    expect(grant?.paths).toEqual(input.paths);
    const policy={writers:s.runtime.AGENT_RUN_GITHUB_WRITERS,tasks:'[]',dynamic:s.policy};
    expect((await authorize(db,policy,first.run_id,grant!.branch)).participant).toBe(s.gemini);
    expect((await launchCoordinatorImplement(input)).status).toBe('existing');
    expect(s.wakes).toHaveLength(1);
    await db.prepare("UPDATE coordinators SET status='revoked' WHERE participant_id=?1")
      .bind(s.coordinator).run();
    expect(await isCoordinator(db,alias)).toBe(false);
    expect(await findDynamicGrant(db,s.policy,s.cycle,input.task,s.gemini)).toBeNull();
    await expect(authorize(db,policy,first.run_id,grant!.branch)).rejects.toThrow('api_task_not_enabled');
    await expect(issueDynamicGrant(db,s.policy,{cycle:s.cycle,task:input.task,
      participant:s.gemini,paths:input.paths!,acceptance:input.acceptance,
      coordinator:alias,now:NOW()})).rejects.toThrow('dynamic_coordinator_not_active');
  });

  it('plafond atomique, rejeu au plafond et conflit immuable sont distingués',async()=>{
    const s=await setup('cap');
    const policy=JSON.stringify({...JSON.parse(s.policy),max_grants:1});
    const i={cycle:s.cycle,task:'cap-a',participant:s.gemini,paths:[PREFIX+'cap-a.spec.ts'],
      coordinator:s.coordinator,now:NOW()};
    const j={...i,task:'cap-b',paths:[PREFIX+'cap-b.spec.ts']};
    const results=await Promise.allSettled([issueDynamicGrant(db,policy,i),issueDynamicGrant(db,policy,j)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.message).toBe('dynamic_grant_cap_exhausted');
    const winner=results[0].status==='fulfilled'?i:j;
    const replay=await issueDynamicGrant(db,policy,winner);
    expect(replay.task).toBe(winner.task);
    await expect(issueDynamicGrant(db,policy,{...winner,acceptance:['Changed mission']}))
      .rejects.toThrow('dynamic_grant_conflict');
    await expect(issueDynamicGrant(db,policy,{...winner,now:winner.now+DYNAMIC_GRANT_TTL_SECONDS+1}))
      .rejects.toThrow('dynamic_grant_expired');
    const count=await db.prepare('SELECT COUNT(*) AS n FROM api_dynamic_grants WHERE cycle=?1')
      .bind(s.cycle).first<{n:number}>();
    expect(count?.n).toBe(1);
  });

  it('cycle fermé : aucun grant et raison explicite',async()=>{
    const s=await setup('closed');
    await db.prepare("UPDATE cycles SET status='closed' WHERE cycle_id=?1").bind(s.cycle).run();
    await expect(issueDynamicGrant(db,s.policy,{cycle:s.cycle,task:'closed-task',
      participant:s.gemini,paths:[PREFIX+'closed.spec.ts'],coordinator:s.coordinator,now:NOW()}))
      .rejects.toThrow('dynamic_cycle_not_open');
    const count=await db.prepare('SELECT COUNT(*) AS n FROM api_dynamic_grants WHERE cycle=?1')
      .bind(s.cycle).first<{n:number}>();
    expect(count?.n).toBe(0);
  });

  it('le lancement expose le refus MCP précis sans prétendre que D1 est indisponible',async()=>{
    const s=await setup('mcp');
    const policy=JSON.stringify({...JSON.parse(s.policy),max_grants:1});
    s.runtime.AGENT_RUN_DYNAMIC_SCOPE=policy;
    await issueDynamicGrant(db,policy,{cycle:s.cycle,task:'reserved',
      participant:s.gemini,paths:[PREFIX+'reserved.spec.ts'],coordinator:s.coordinator,now:NOW()});
    let failure:unknown;
    try {
      await launchCoordinatorImplement(s.make('over-cap',s.gemini,s.vibe,PREFIX+'over-cap.spec.ts','over-cap'));
    } catch(error) { failure=error; }
    expect(failure).toBeDefined();
    const result=collabFailure(failure,'Launch refused.');
    expect(result.structuredContent.error).toEqual({
      code:'GITHUB_GRANT_REFUSED',message:'dynamic_grant_cap_exhausted',retryable:false,
    });
    expect(result.structuredContent).not.toHaveProperty('fallback');
    expect(s.wakes).toHaveLength(0);
    const task=await db.prepare('SELECT 1 AS ok FROM tasks WHERE cycle_id=?1 AND task_id=?2')
      .bind(s.cycle,'over-cap').first();
    expect(task).toBeNull();
  });

});

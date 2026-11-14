import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
import { nativeCiCandidate, handleGitHubWebhook, WEBHOOK_PATH } from '../../../src/collab-store/controller/webhook';
import { racingBatch } from '../coordinator-helpers';
import {
  nativeCiState, reconcileNativeCi, NATIVE_REQUIRED_CHECKS, type CiCheck,
} from '../../../src/collab-store/controller/ci-transition';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const REPO = 'rfkevin/github-mcp';
let n = 0;
const uniq = (prefix: string) => prefix + (++n) + '-' + Date.now().toString(36);
const checks = (state: 'success' | 'failure' | 'pending', id = 10): CiCheck[] =>
  NATIVE_REQUIRED_CHECKS.map((name, i) => ({
    id: name === 'ci' ? id : i + 1, name,
    head_sha: HEAD, status: name === 'ci' && state === 'pending' ? 'in_progress' : 'completed',
    conclusion: name === 'ci' ? (state === 'pending' ? null : state) : 'success',
  }));
function live() {
  let currentChecks = checks('failure');
  let head = HEAD, base = BASE, open = true;
  const reads = {
    async getPullRequest(_repository: string, number: number): Promise<unknown> {
      return { number, state: open ? 'open' : 'closed', merged: !open,
        head: { sha: head }, base: { sha: base } };
    },
    async listCheckRuns(): Promise<CiCheck[]> { return currentChecks; },
  };
  return { reads,
    setChecks(next: CiCheck[]) { currentChecks = next; },
    setHead(next: string) { head = next; },
    setBase(next: string) { base = next; },
    setOpen(next: boolean) { open = next; } };
}

async function seed() {
  await ensureSchema(db);
  const cycle = uniq('ci');
  await insertCycleRow(db,cycle,'P6');
  await insertPhaseDefinition(db,cycle,'P6',[]);
  await insertTaskRow(db,{cycle,taskId:'work',owner:'gemini',reviewer:'vibe',tester:'grok'});
  const proof = JSON.stringify({
    task:'work',state:'RUN_PROVEN',run_participant:'gemini',pr:337,
    head:HEAD,base:BASE,verified_success:true,run_id:'api-test',
  });
  const insert=await db.prepare([
    "INSERT INTO events(cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)",
    "VALUES(?1,1700000000,'run.proof','agentrun','','server',?2,1,?3,'')",
  ].join(' ')).bind(cycle,proof,'proof:'+cycle).run();
  expect(insert.meta.changes).toBe(1);
  return {cycle};
}
const execute=(cycle:string,reads:ReturnType<typeof live>['reads'],now=1700000100) =>
  reconcileNativeCi(db,{repository:REPO,number:337,head:HEAD,reads,now}).then(result=>({cycle,...result}));
const rows=(cycle:string,type:string)=>db.prepare("SELECT seq,payload_json FROM events WHERE cycle_id=?1 AND type=?2 ORDER BY seq")
  .bind(cycle,type).all<{seq:number;payload_json:string}>();

describe('CC8 S9 — transitions postrun CI native (GitHub vérifié)',()=>{
  it('latest check id wins: l ancien timeout ne remplace pas un rerun vert',()=>{
    expect(nativeCiState(checks('failure'),HEAD).state).toBe('failed');
    expect(nativeCiState([...checks('failure'),...checks('success',99)],HEAD)).toEqual({state:'passed',checkId:99});
    expect(nativeCiState(checks('pending'),HEAD).state).toBe('pending');
    expect(nativeCiState(checks('success').filter(x=>x.name!=='SonarCloud Code Analysis'),HEAD).state).toBe('pending');
    expect(nativeCiState(checks('success').map(x=>({...x,head_sha:OTHER})),HEAD).state).toBe('pending');
  });

  it('CI rouge → correction native + wake durable ; même SHA redevient vert → soumission serveur sans commit ni verdict',async()=>{
    const {cycle}=await seed(), state=live();
    const red=await execute(cycle,state.reads);
    expect(red).toMatchObject({status:'applied',kind:'correction.request',task:'work'});
    const corrections=await rows(cycle,'correction.request');
    expect(corrections.results).toHaveLength(1);
    expect(JSON.parse(corrections.results[0].payload_json))
      .toMatchObject({origin:'github_native_ci',head:HEAD,base:BASE,pr:337});
    expect((await db.prepare("SELECT event_type FROM agent_event_wake_intents WHERE cycle_id=?1")
      .bind(cycle).all<{event_type:string}>()).results).toMatchObject([{event_type:'correction.request'}]);
    expect((await previewNextActions(db,cycle,'gemini')).mine.map(x=>x.action)).toContain('address_correction');
    // Repeated delivery : aucune nouvelle demande (clé d'idempotence stable par check id).
    expect((await execute(cycle,state.reads)).status).toBe('ignored');
    expect((await rows(cycle,'correction.request')).results).toHaveLength(1);

    state.setChecks([...checks('failure'),...checks('success',99)]);
    const green=await execute(cycle,state.reads,1700000200);
    expect(green).toMatchObject({status:'applied',kind:'run.reconcile',task:'work'});
    const proofs=await rows(cycle,'run.reconcile');
    expect(proofs.results).toHaveLength(1);
    expect(JSON.parse(proofs.results[0].payload_json)).toMatchObject({
      run_participant:'gemini',verified_success:true,head:HEAD,base:BASE,pr:337,
      prior_proof_seq:expect.any(Number),correction_seq:corrections.results[0].seq,
    });
    const actions=await previewNextActions(db,cycle,'gemini',{all:true});
    expect(actions.mine.some(x=>x.action==='address_correction')).toBe(false);
    expect(actions.all?.map(x=>x.action).sort()).toEqual(['review','test']);
    expect((await execute(cycle,state.reads,1700000300)).status).toBe('ignored');
    expect((await rows(cycle,'run.reconcile')).results).toHaveLength(1);
  });

  it('correction humaine ou CHANGES_REQUESTED : CI verte ne supprime jamais la demande',async()=>{
    const {cycle}=await seed(),state=live();
    await db.prepare([
      "INSERT INTO events(cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)",
      "VALUES(?1,1700000100,'correction.request','gpt6','','coordinator',?2,1,?3,'')",
    ].join(' ')).bind(cycle,JSON.stringify({task:'work',items:['Corriger aussi les assertions fonctionnelles'],reason:'review'}),'human:'+cycle).run();
    state.setChecks(checks('success',99));
    expect(await execute(cycle,state.reads)).toMatchObject({status:'ignored',reason:'not_auto_ci_correction'});
    expect((await rows(cycle,'run.reconcile')).results).toHaveLength(0);
    expect((await previewNextActions(db,cycle,'gemini')).mine.map(x=>x.action)).toContain('address_correction');
  });

  it('HEAD/base modifiés, PR fermée, absence de preuve ou checks pending : aucun effet',async()=>{
    const {cycle}=await seed(),state=live();
    state.setHead(OTHER);
    expect((await execute(cycle,state.reads)).status).toBe('ignored');
    state.setHead(HEAD);state.setBase(OTHER);
    expect((await execute(cycle,state.reads)).status).toBe('ignored');
    state.setBase(BASE);state.setOpen(false);
    expect((await execute(cycle,state.reads)).status).toBe('ignored');
    state.setOpen(true);state.setChecks(checks('pending'));
    expect((await execute(cycle,state.reads)).status).toBe('ignored');
    expect((await rows(cycle,'correction.request')).results).toHaveLength(0);
    expect((await rows(cycle,'run.reconcile')).results).toHaveLength(0);
  });

  it('CAS : une correction concurrente au dernier instant interdit le réveil automatique',async()=>{
    const {cycle}=await seed(), state=live();
    const raced = racingBatch(db,7,target=>target.prepare([
      'INSERT INTO events(cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)',
      "VALUES(?1,1700000099,'correction.request','gpt6','','coordinator',?2,1,?3,'')",
    ].join(' ')).bind(cycle,JSON.stringify({task:'work',items:['Revoir le fond du test']}),'race:'+cycle).run());
    expect((await reconcileNativeCi(raced,{repository:REPO,number:337,head:HEAD,reads:state.reads,now:1700000100})).status)
      .toBe('ignored');
    const c=(await rows(cycle,'correction.request')).results;
    expect(c).toHaveLength(1);
    expect(JSON.parse(c[0].payload_json)).toMatchObject({items:['Revoir le fond du test']});
    expect((await rows(cycle,'run.reconcile')).results).toHaveLength(0);
  });

  it('webhook GitHub signé : check_run completed déclenche exactement la correction serveur et son hook de réveil',async()=>{
    const {cycle}=await seed(), state=live();
    const body=JSON.stringify({
      installation:{id:42}, action:'completed', repository:{full_name:REPO},
      check_run:{name:'ci',head_sha:HEAD,pull_requests:[{number:337}]},
    });
    const secret='test-only-ci-webhook-secret-012345';
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const sig=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body)));
    const signature='sha256='+[...sig].map(n=>n.toString(16).padStart(2,'0')).join('');
    const request=(id:string)=>new Request('https://example.test'+WEBHOOK_PATH,{
      method:'POST',body,headers:{'x-github-event':'check_run','x-github-delivery':id,
        'x-hub-signature-256':signature,'content-type':'application/json'},
    });
    const events:string[]=[];
    const ci={repository:REPO,reads:state.reads,onApplied:(event:{type:string})=>events.push(event.type)};
    const pending:Promise<unknown>[]=[];
    const ctx={waitUntil:(job:Promise<unknown>)=>{pending.push(job);}};
    const enabled={COLLAB_DB:db,COLLAB_STORE_ENABLED:'true',CONTROLLER_WEBHOOK_ENABLED:'true',
      GITHUB_WEBHOOK_SECRET:secret,GITHUB_INSTALLATION_ID:'42'};
    const delivery='abcd'+Date.now().toString(16)+'-'+(++n).toString(16);
    const response=await handleGitHubWebhook(request(delivery),enabled,ctx,{ci});
    expect(response?.status).toBe(202);
    await Promise.all(pending);
    expect(events).toEqual(['correction.request']);
    expect((await rows(cycle,'correction.request')).results).toHaveLength(1);
    const again:Promise<unknown>[]=[];
    const duplicate=await handleGitHubWebhook(request(delivery),enabled,
      {waitUntil:(job:Promise<unknown>)=>{again.push(job);}},{ci});
    expect(await duplicate?.json()).toMatchObject({outcome:'duplicate'});
    expect(again).toHaveLength(0);
  });

  it('seul check_run completed signé sur le bon dépôt produit un candidat, pas un contenu falsifié',()=>{
    const payload={action:'completed',repository:{full_name:REPO},
      check_run:{name:'ci',head_sha:HEAD,pull_requests:[{number:337}]}};
    expect(nativeCiCandidate('check_run',payload,REPO)).toEqual({number:337,head:HEAD});
    expect(nativeCiCandidate('check_run',{...payload,action:'rerequested'},REPO)).toBeNull();
    expect(nativeCiCandidate('check_run',payload,'other/repo')).toBeNull();
    expect(nativeCiCandidate('push',payload,REPO)).toBeNull();
    expect(nativeCiCandidate('check_run',{...payload,check_run:{...payload.check_run,head_sha:OTHER.slice(1)}},REPO)).toBeNull();
  });
});

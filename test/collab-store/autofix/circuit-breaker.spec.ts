import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { AUTOFIX_SCHEMA, claimAutoFix, claimAutoFixForFailure, stableProblemId, rotateCorrector, type AutoFixClaim } from '../../../src/collab-store/autofix/circuit-breaker';

const db=(env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let serial=0;
const base:AutoFixClaim={
 cycle:'l6pilot',problemId:'a'.repeat(64),failureRef:'ci:failed:first',
 now:1792410000,corrector:'gpt6',reviewer:'grok',tester:'vibe',
 correctorFamily:'openai',reviewerFamily:'xai',testerFamily:'zhipu',
 correctorChannel:'api',reviewerChannel:'trusted',testerChannel:'trusted',
};
beforeEach(async()=>{
 await ensureSchema(db);
 await db.batch(AUTOFIX_SCHEMA.map(s=>db.prepare(s)));
 await db.prepare("INSERT INTO owner_flags(name,value,updated_at) VALUES ('halt','0',0) ON CONFLICT(name) DO UPDATE SET value='0'").run();
 base.cycle='l6pilot-'+(++serial);
 await db.prepare('INSERT INTO cycles(cycle_id,status) VALUES (?1,?2)').bind(base.cycle,'open').run();
});
describe('L6 D2 circuit breaker',()=>{
 it('trusted roster creates stable ID and rotates author, irrespective of API writer',async()=>{
  const failure={cycle:base.cycle,signature:'FAILED TEST L6',failureRef:'ci:job:1',now:base.now};
  const policy={
   correctors:[{id:'gpt6',family:'openai',channel:'api' as const},{id:'claude',family:'anthropic',channel:'trusted' as const}],
   reviewer:{id:'grok',family:'xai',channel:'trusted' as const},
   tester:{id:'vibe',family:'zhipu',channel:'trusted' as const},
  };
  expect((await claimAutoFixForFailure(db,failure,policy)).accepted).toBe(true);
  expect((await claimAutoFixForFailure(db,{...failure,signature:' failed  test l6 '},policy)).accepted).toBe(true);
  expect((await claimAutoFixForFailure(db,failure,policy)).accepted).toBe(false);
  const rows=await db.prepare('SELECT corrector FROM cc5_autofix_attempts WHERE cycle=?1 ORDER BY attempt').bind(base.cycle).all<{corrector:string}>();
  expect(rows.results.map(x=>x.corrector)).toEqual(['claude','gpt6']);
  expect((await claimAutoFixForFailure(db,{...failure,signature:'another failure'}, {...policy,reviewer:{...policy.reviewer,channel:'api'}})).accepted).toBe(false);
 });
 it('stable ID and corrector rotation',async()=>{
  expect(await stableProblemId(' CI  FAIL ')).toBe(await stableProblemId('ci fail'));
  expect(rotateCorrector(['gpt6','grok','claude'],'gpt6')).toBe('grok');
 });
 it('API corrector cannot review or test',async()=>{
  expect((await claimAutoFix(db,{...base,reviewerChannel:'api' as 'trusted'})).accepted).toBe(false);
  expect((await claimAutoFix(db,{...base,testerChannel:'api' as 'trusted'})).accepted).toBe(false);
  expect((await claimAutoFix(db,base)).accepted).toBe(true);
 });
 it('registers the first failure once and limits a stable problem to two attempts',async()=>{
  expect((await claimAutoFix(db,base)).attempt).toBe(1);
  expect((await claimAutoFix(db,{...base,failureRef:'second failure'})).attempt).toBe(2);
  expect((await claimAutoFix(db,base)).accepted).toBe(false);
  const p=await db.prepare('SELECT first_failure_ref FROM cc5_autofix_problems WHERE cycle=?1').bind(base.cycle).first<{first_failure_ref:string}>();
  expect(p?.first_failure_ref).toBe('ci:failed:first');
 });
 it('enforces five per UTC day and resets on next day',async()=>{
  for(let i=0;i<5;i++) expect((await claimAutoFix(db,{...base,problemId:i.toString(16).padStart(64,'0')})).accepted).toBe(true);
  const sixth={...base,problemId:'f'.repeat(64)};
  expect((await claimAutoFix(db,sixth)).accepted).toBe(false);
  expect((await claimAutoFix(db,{...sixth,now:base.now+86400})).accepted).toBe(true);
 });
 it('has one winner at attempt two under concurrent claims',async()=>{
  expect((await claimAutoFix(db,base)).accepted).toBe(true);
  const results=await Promise.all([claimAutoFix(db,base),claimAutoFix(db,base)]);
  expect(results.filter(r=>r.accepted)).toHaveLength(1);
 });
 it('rejects self-review or same-family validation',async()=>{
  expect((await claimAutoFix(db,{...base,reviewerFamily:'openai'})).accepted).toBe(false);
  expect((await claimAutoFix(db,{...base,tester:'gpt6'})).accepted).toBe(false);
 });
 it('HALT blocks both first-failure registration and claim in the same batch',async()=>{
  await db.prepare("UPDATE owner_flags SET value='1' WHERE name='halt'").run();
  expect((await claimAutoFix(db,base)).accepted).toBe(false);
  const row=await db.prepare('SELECT count(*) AS n FROM cc5_autofix_problems WHERE cycle=?1').bind(base.cycle).first<{n:number}>();
  expect(row?.n).toBe(0);
 });
});

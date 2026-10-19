import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { AUTOFIX_SCHEMA, claimAutoFixForFailure, stableProblemId, rotateCorrector, type AutoFixTrustedPolicy } from '../../../src/collab-store/autofix/circuit-breaker';

const db=(env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let serial=0;
const policy:AutoFixTrustedPolicy={
 correctors:[{id:'gpt6',family:'openai',channel:'api'},{id:'claude',family:'anthropic',channel:'trusted'}],
 reviewer:{id:'grok',family:'xai',channel:'trusted'},
 tester:{id:'vibe',family:'zhipu',channel:'trusted'},
};
const failure=(signature='ci failure',failureRef='ci:failed:first')=>({cycle:baseCycle,signature,failureRef});
let baseCycle='';
beforeEach(async()=>{
 await ensureSchema(db);
 await db.batch(AUTOFIX_SCHEMA.map(s=>db.prepare(s)));
 await db.prepare("INSERT INTO owner_flags(name,value,updated_at) VALUES ('halt','0',0) ON CONFLICT(name) DO UPDATE SET value='0'").run();
 baseCycle='l6pilot-'+(++serial);
 await db.prepare('INSERT INTO cycles(cycle_id,status) VALUES (?1,?2)').bind(baseCycle,'open').run();
});
describe('L6 D2 circuit breaker increment 2',()=>{
 it('stable fingerprint at first failure, rotation and two-attempt cap',async()=>{
  const first=await claimAutoFixForFailure(db,failure(' CI FAIL '),policy);
  const second=await claimAutoFixForFailure(db,failure('ci  fail','ci:second'),policy);
  const third=await claimAutoFixForFailure(db,failure('ci fail','ci:third'),policy);
  expect([first.attempt,second.attempt,third.accepted]).toEqual([1,2,false]);
  const id=await stableProblemId('ci fail');
  const row=await db.prepare('SELECT first_failure_ref FROM cc5_autofix_problems WHERE cycle=?1 AND problem_id=?2').bind(baseCycle,id).first<{first_failure_ref:string}>();
  expect(row?.first_failure_ref).toBe('ci:failed:first');
  const claims=await db.prepare('SELECT corrector,day_utc FROM cc5_autofix_attempts WHERE cycle=?1 ORDER BY attempt').bind(baseCycle).all<{corrector:string;day_utc:string}>();
  expect(claims.results.map(x=>x.corrector)).toEqual(['claude','gpt6']);
  expect(claims.results.map(x=>x.day_utc)).toEqual([new Date().toISOString().slice(0,10),new Date().toISOString().slice(0,10)]);
 });
 it('five per day, HALT and separate validation families',async()=>{
  for(let i=0;i<5;i++) expect((await claimAutoFixForFailure(db,failure('failure '+i),policy)).accepted).toBe(true);
  expect((await claimAutoFixForFailure(db,failure('sixth'),policy)).accepted).toBe(false);
  expect((await claimAutoFixForFailure(db,failure('seventh'),{...policy,reviewer:{...policy.reviewer,channel:'api'}})).accepted).toBe(false);
 });
 it('HALT prevents first failure registration',async()=>{
  await db.prepare("UPDATE owner_flags SET value='1' WHERE name='halt'").run();
  expect((await claimAutoFixForFailure(db,failure('halt failure'),policy)).accepted).toBe(false);
  const row=await db.prepare('SELECT count(*) AS n FROM cc5_autofix_problems WHERE cycle=?1').bind(baseCycle).first<{n:number}>();
  expect(row?.n).toBe(0);
 });
 it('both autofix tables are append-only at SQL level',async()=>{
  await claimAutoFixForFailure(db,failure('append-only'),policy);
  for(const table of ['cc5_autofix_problems','cc5_autofix_attempts']){
   await expect(db.prepare('UPDATE '+table+' SET cycle=?1 WHERE cycle=?2').bind('tampered',baseCycle).run()).rejects.toThrow();
   await expect(db.prepare('DELETE FROM '+table+' WHERE cycle=?1').bind(baseCycle).run()).rejects.toThrow();
  }
 });
 it('only trusted roster can supply reviewer and tester',async()=>{
  expect((await claimAutoFixForFailure(db,failure('untrusted'),{...policy,tester:{...policy.tester,channel:'api'}})).accepted).toBe(false);
  expect(rotateCorrector(['gpt6','grok','claude'],'gpt6')).toBe('grok');
 });
});

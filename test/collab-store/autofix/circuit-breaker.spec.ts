import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { AUTOFIX_SCHEMA, claimAutoFix, type AutoFixClaim } from '../../../src/collab-store/autofix/circuit-breaker';

const db=env.DB;
const base:AutoFixClaim={
 cycle:'l6pilot',problemId:'a'.repeat(64),failureRef:'ci:failed:first',
 now:1792410000,corrector:'gpt6',reviewer:'grok',tester:'vibe',
 correctorFamily:'openai',reviewerFamily:'xai',testerFamily:'zhipu',
};
beforeEach(async()=>{
 await db.batch([
 db.prepare('CREATE TABLE IF NOT EXISTS cycles (cycle_id TEXT PRIMARY KEY,status TEXT)'),
 db.prepare('CREATE TABLE IF NOT EXISTS owner_flags (name TEXT PRIMARY KEY,value TEXT)'),
 ...AUTOFIX_SCHEMA.map(s=>db.prepare(s)),
 ]);
 await db.prepare('DELETE FROM cc5_autofix_attempts').run();
 await db.prepare('DELETE FROM cc5_autofix_problems').run();
 await db.prepare('DELETE FROM cycles').run();
 await db.prepare('DELETE FROM owner_flags').run();
 await db.prepare("INSERT INTO cycles VALUES ('l6pilot','open')").run();
});
describe('L6 D2 circuit breaker',()=>{
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
  await db.prepare("INSERT INTO owner_flags VALUES ('halt','1')").run();
  expect((await claimAutoFix(db,base)).accepted).toBe(false);
  const row=await db.prepare('SELECT count(*) AS n FROM cc5_autofix_problems').first<{n:number}>();
  expect(row?.n).toBe(0);
 });
});

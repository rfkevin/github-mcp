import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { superviseCycle, STALL_SECONDS } from '../../../src/collab-store/controller/autonomy';
import { runScheduledControllers } from '../../../src/collab-store/controller/scheduled';
import { activeMandate } from '../../../src/collab-store/owner/delegation-execution';
import { parseOwnerRequest } from '../../../src/collab-store/owner/executable';
import { insertCycleRow, insertTaskRow, insertEventRow } from '../a0-helpers';
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 2_000_000_000;
let n = 0;
const at = (seconds: number) => () => new Date(seconds * 1000);
async function fixture(blocked = true) {
  const cycle = 's8-' + (++n);
  await insertCycleRow(db,cycle,'P6');
  await insertTaskRow(db,{cycle,taskId:'work',owner:'author',reviewer:'reviewer',tester:'tester'});
  if (blocked) await db.prepare("UPDATE tasks SET status='blocked' WHERE cycle_id=?1").bind(cycle).run();
  return cycle;
}
async function events(cycle: string) {
  return (await db.prepare("SELECT type,payload_json FROM events WHERE cycle_id=?1 AND participant_id='system:controller' ORDER BY seq").bind(cycle).all<{type:string;payload_json:string}>()).results;
}
async function run(cycle: string, time = T, beforeWrite?: () => Promise<void>) {
  return superviseCycle(db,cycle,{now:at(time),salonEnabled:true,beforeWrite});
}
async function coordinator(cycle: string, alternate = true) {
  await activeMandate(db,cycle);
  await db.prepare('INSERT INTO delegated_mandates(cycle_id,participant_id,family_id,epoch,updated_at) VALUES(?1,?2,?2,1,?3)').bind(cycle,cycle+'-coord',T).run();
  if (alternate) {
    const pid = cycle+'-next';
    await db.prepare("INSERT INTO participants(participant_id,display_label,status) VALUES(?1,?1,'active')").bind(pid).run();
    await db.prepare("INSERT INTO coordinators(participant_id,status,updated_at) VALUES(?1,'active',?2)").bind(pid,T).run();
  }
}
describe('S8 autonomy on existing controller',()=>{
  it('disabled does not publish; missing history starts a full observation window',async()=>{
    const c=await fixture();
    expect(await superviseCycle(db,c)).toMatchObject({status:'disabled',recorded:0});
    expect((await run(c)).recorded).toBe(0);
    expect((await run(c,T+STALL_SECONDS-1)).recorded).toBe(0);
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(1);
    expect((await events(c))[0].type).toBe('checkpoint');
    const payload=JSON.parse((await events(c))[0].payload_json);
    expect(payload.reassignment_draft).toMatchObject({expected_revision:1,expected_owner_pid:'author'});
    expect((await db.prepare("SELECT status,owner_pid FROM tasks WHERE cycle_id=?1").bind(c).first())).toEqual({status:'blocked',owner_pid:'author'});
  });
  it('replays and concurrent passes produce one event and one salon alert',async()=>{
    const c=await fixture();await run(c);
    await Promise.all([run(c,T+STALL_SECONDS),run(c,T+STALL_SECONDS)]);
    await run(c,T+2*STALL_SECONDS);
    expect(await events(c)).toHaveLength(1);
    const rows=await db.prepare('SELECT COUNT(*) AS n FROM salon_messages WHERE body LIKE ?1').bind('Cycle '+c+',%').first<{n:number}>();
    expect(rows?.n).toBe(1);
  });
  it('resolved task is not escalated; a new blocked revision starts another window',async()=>{
    const c=await fixture();await run(c);
    await db.prepare("UPDATE tasks SET status='done' WHERE cycle_id=?1").bind(c).run();
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(0);
    await db.prepare("UPDATE tasks SET status='blocked',revision=2 WHERE cycle_id=?1").bind(c).run();
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(0);
    expect((await run(c,T+2*STALL_SECONDS)).recorded).toBe(1);
  });
  it('HALT during observation prevents both proposal and salon atomically',async()=>{
    const c=await fixture();await run(c);
    try {
      expect(await run(c,T+STALL_SECONDS,async()=>{await db.prepare("INSERT OR REPLACE INTO owner_flags(name,value,updated_at) VALUES('halt','1',?1)").bind(T).run();})).toMatchObject({status:'stale',recorded:0});
      expect(await events(c)).toHaveLength(0);
    } finally { await db.prepare("DELETE FROM owner_flags WHERE name='halt'").run(); }
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(1);
  });
  it('cycle CAS rejects a concurrent task transition without publishing stale state',async()=>{
    const c=await fixture();await run(c);
    const r=await run(c,T+STALL_SECONDS,async()=>{await db.batch([
      db.prepare("UPDATE tasks SET status='done',revision=2 WHERE cycle_id=?1").bind(c),
      db.prepare('UPDATE cycles SET revision=2 WHERE cycle_id=?1').bind(c),
    ]);});
    expect(r.status).toBe('stale');expect(await events(c)).toHaveLength(0);
  });
  it('silent coordinator prepares a valid expiring owner request without changing the mandate',async()=>{
    const c=await fixture(false);await coordinator(c);
    expect((await run(c,T+STALL_SECONDS-1)).recorded).toBe(0);
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(1);
    const ev=(await events(c))[0];expect(ev.type).toBe('owner.request');
    expect(await parseOwnerRequest(ev.payload_json)).toMatchObject({kind:'executable',request:{action:'appoint_cycle_coordinator',max_cost_cents:0}});
    expect(await activeMandate(db,c)).toMatchObject({participant_id:c+'-coord',epoch:1});
    await run(c,T+3*STALL_SECONDS);expect(await events(c)).toHaveLength(1);
  });
  it('activity from an identity-family alias resets silence; system alerts do not count',async()=>{
    const c=await fixture(false);await coordinator(c);
    for(const pid of [c+'-coord',c+'-alias']) {
      await db.prepare("INSERT OR IGNORE INTO participants(participant_id,display_label,status) VALUES(?1,?1,'active')").bind(pid).run();
      await db.prepare('INSERT INTO participant_identity_families(participant_id,family_id,updated_at) VALUES(?1,?2,?3)').bind(pid,c+'-family',T).run();
    }
    await insertEventRow(db,{cycle:c,type:'checkpoint',participant:c+'-alias',role:'coordinator',payload:{},key:c+'-activity'});
    await db.prepare('UPDATE events SET at=?2 WHERE idempotency_key=?1').bind(c+'-activity',T+100).run();
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(0);
    expect((await run(c,T+STALL_SECONDS+100)).recorded).toBe(1);
  });
  it('no eligible successor reports vacancy without preparing a revocation',async()=>{
    const c=await fixture(false);await coordinator(c,false);
    const saved=(await db.prepare("SELECT participant_id FROM coordinators WHERE status='active'").all<{participant_id:string}>()).results;
    await db.prepare("UPDATE coordinators SET status='revoked'").run();
    try {
      expect((await run(c,T+STALL_SECONDS)).recorded).toBe(1);
      const ev=(await events(c))[0];expect(ev.type).toBe('checkpoint');
      expect(JSON.parse(ev.payload_json).state).toBe('S8_COORDINATOR_NO_SUCCESSOR');
      expect(await activeMandate(db,c)).toMatchObject({epoch:1,participant_id:c+'-coord'});
    } finally {
      for(const row of saved) await db.prepare("UPDATE coordinators SET status='active' WHERE participant_id=?1").bind(row.participant_id).run();
    }
  });
  it('new activity during preparation invalidates the proposal through cycle CAS',async()=>{
    const c=await fixture(false);await coordinator(c);
    expect(await run(c,T+STALL_SECONDS,async()=>{
      await db.prepare('UPDATE cycles SET revision=revision+1 WHERE cycle_id=?1').bind(c).run();
    })).toMatchObject({status:'stale',recorded:0});
    expect(await events(c)).toHaveLength(0);
  });
  it('closed or fully completed cycle produces no coordinator replacement',async()=>{
    const c=await fixture(false);await coordinator(c);
    await db.prepare("UPDATE tasks SET status='done' WHERE cycle_id=?1").bind(c).run();
    expect((await run(c,T+STALL_SECONDS)).recorded).toBe(0);
    await db.prepare("UPDATE cycles SET status='closed' WHERE cycle_id=?1").bind(c).run();
    expect((await run(c,T+2*STALL_SECONDS)).recorded).toBe(0);
  });
  it('scheduled production path runs the supervisor when salon is enabled',async()=>{
    const c=await fixture();
    await runScheduledControllers(db,{research:false,now:at(T),salonEnabled:true});
    await runScheduledControllers(db,{research:false,now:at(T+STALL_SECONDS),salonEnabled:true});
    expect(await events(c)).toHaveLength(1);
  });
});

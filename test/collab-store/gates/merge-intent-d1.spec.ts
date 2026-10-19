import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { claimMergeIntent, reconcileMergeIntent } from '../../../src/collab-store/gates/merge-intent';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const sha = (char: string) => char.repeat(40);
const nextCycle = () => 'l4-intent-' + (++counter);
async function setup() {
  await ensureSchema(db);
  const cycle = nextCycle();
  await db.prepare("INSERT INTO cycles(cycle_id,status) VALUES (?1,'open')").bind(cycle).run();
  const intent = { cycle, task: 'l4', pr: 167, head: sha('a'), base: sha('b'), now: 1700000000 };
  await db.prepare('INSERT INTO cc5_merge_leases(cycle,task,head,base,expires_at,revoked) VALUES (?1,?2,?3,?4,?5,0)')
    .bind(cycle, 'l4', intent.head, intent.base, intent.now + 1000).run();
  return intent;
}
describe('CC-5 L4: real D1 claim and reconciliation', () => {
  it('schema is bootstrapped and duplicate claims are single-use', async () => {
    const intent = await setup();
    expect(await claimMergeIntent(db,intent)).toBe(true);
    expect(await claimMergeIntent(db,intent)).toBe(false);
    expect(await claimMergeIntent(db,{...intent,head:sha('c')})).toBe(false);
    const row = await db.prepare('SELECT count(*) AS n FROM cc5_merge_intents WHERE cycle=?1').bind(intent.cycle).first<{n:number}>();
    expect(row?.n).toBe(1);
  });
  it('parallel D1 claims have exactly one winner', async () => {
    const intent = await setup();
    const outcomes = await Promise.all([claimMergeIntent(db,intent),claimMergeIntent(db,intent)]);
    expect(outcomes.sort()).toEqual([false,true]);
    const row = await db.prepare('SELECT count(*) AS n FROM cc5_merge_intents WHERE cycle=?1').bind(intent.cycle).first<{n:number}>();
    expect(row?.n).toBe(1);
  });
  it('HALT blocks a claim, and lifting HALT allows only the first', async () => {
    const intent = await setup();
    await db.prepare("INSERT INTO owner_flags(name,value,updated_at) VALUES ('halt','1',0) ON CONFLICT(name) DO UPDATE SET value='1'").run();
    expect(await claimMergeIntent(db,intent)).toBe(false);
    await db.prepare("UPDATE owner_flags SET value='0' WHERE name='halt'").run();
    expect(await claimMergeIntent(db,intent)).toBe(true);
  });
  it('revoked, expired or wrong-SHA lease cannot claim', async () => {
    const intent = await setup();
    await db.prepare('UPDATE cc5_merge_leases SET revoked=1 WHERE cycle=?1').bind(intent.cycle).run();
    expect(await claimMergeIntent(db,intent)).toBe(false);
    await db.prepare('UPDATE cc5_merge_leases SET revoked=0,expires_at=?2 WHERE cycle=?1').bind(intent.cycle,intent.now).run();
    expect(await claimMergeIntent(db,intent)).toBe(false);
    await db.prepare('UPDATE cc5_merge_leases SET expires_at=?2,head=?3 WHERE cycle=?1').bind(intent.cycle,intent.now+1000,sha('c')).run();
    expect(await claimMergeIntent(db,intent)).toBe(false);
  });
  it('observation-only reconcile stays uncertain before TTL and confirms later', async () => {
    const intent = await setup();
    expect(await claimMergeIntent(db,intent)).toBe(true);
    expect(await reconcileMergeIntent(db,intent,null,intent.now+10)).toBe('uncertain');
    expect(await reconcileMergeIntent(db,intent,sha('c'),intent.now+20)).toBe('merged');
    expect(await reconcileMergeIntent(db,intent,null,intent.now+500)).toBe('merged');
  });
  it('orphan intent expires without ever creating a new claim', async () => {
    const intent = await setup();
    expect(await claimMergeIntent(db,intent)).toBe(true);
    expect(await reconcileMergeIntent(db,intent,null,intent.now+301)).toBe('expired');
    expect(await claimMergeIntent(db,intent)).toBe(false);
  });
});

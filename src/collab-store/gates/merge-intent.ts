/** CC-5 L4: one-shot D1 claim. Schema installed by the authorized deployment. */
export const MERGE_INTENT_TTL_SECONDS = 300;
export interface MergeIntent { cycle: string; task: string; pr: number; head: string; base: string; now: number }
export const MERGE_INTENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cc5_merge_intents (
    cycle TEXT NOT NULL, task TEXT NOT NULL, pr INTEGER NOT NULL,
    head TEXT NOT NULL, base TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'claimed',
    merge_sha TEXT, PRIMARY KEY(cycle,task,head,base),
    CHECK(state IN ('claimed','merged','expired','uncertain')))`,
  'CREATE UNIQUE INDEX IF NOT EXISTS cc5_merge_pr_unique ON cc5_merge_intents(cycle,pr)',
  `CREATE TABLE IF NOT EXISTS cc5_merge_leases (
    cycle TEXT NOT NULL, task TEXT NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(cycle,task))`,
] as const;
export async function claimMergeIntent(db: D1Database, input: MergeIntent): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(input.head) || !/^[a-f0-9]{40}$/.test(input.base) ||
      !/^[a-z0-9_-]+$/i.test(input.cycle) || !/^[a-z0-9_-]+$/i.test(input.task) ||
      !Number.isSafeInteger(input.pr) || input.pr <= 0 || !Number.isSafeInteger(input.now)) return false;
  const result = await db.prepare(`INSERT OR IGNORE INTO cc5_merge_intents
    (cycle,task,pr,head,base,claimed_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7
    WHERE EXISTS (SELECT 1 FROM cycles WHERE cycle_id=?1 AND status='open')
      AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name='halt' AND value='1')
      AND EXISTS (SELECT 1 FROM cc5_merge_leases
        WHERE cycle=?1 AND task=?2 AND head=?4 AND base=?5 AND revoked=0 AND expires_at>?6)
      AND NOT EXISTS (SELECT 1 FROM cc5_merge_intents WHERE cycle=?1 AND pr=?3)`)
    .bind(input.cycle,input.task,input.pr,input.head,input.base,input.now,
      input.now+MERGE_INTENT_TTL_SECONDS).run();
  return result.meta.changes === 1;
}
export async function reconcileMergeIntent(db: D1Database, input: MergeIntent,
  observedMergeSha: string | null, now: number): Promise<'merged' | 'expired' | 'uncertain' | null> {
  const row = await db.prepare(`SELECT state,expires_at FROM cc5_merge_intents
    WHERE cycle=?1 AND task=?2 AND head=?3 AND base=?4`)
    .bind(input.cycle,input.task,input.head,input.base)
    .first<{state:string;expires_at:number}>();
  if (!row) return null;
  if (row.state !== 'claimed') return row.state as 'merged'|'expired'|'uncertain';
  const state = observedMergeSha && /^[a-f0-9]{40}$/.test(observedMergeSha)
    ? 'merged' : now >= row.expires_at ? 'expired' : 'uncertain';
  // Keep an unexpired unconfirmed intent observable for later reconciliation.
  if (state === 'uncertain') return state;
  await db.prepare(`UPDATE cc5_merge_intents SET state=?1,merge_sha=?2
    WHERE cycle=?3 AND task=?4 AND head=?5 AND base=?6 AND state='claimed'`)
    .bind(state,state==='merged'?observedMergeSha:null,input.cycle,input.task,input.head,input.base).run();
  return state;
}

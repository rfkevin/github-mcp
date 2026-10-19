/** CC-5 L6 D2 — throwaway pilot only; no automatic code execution or merge. */
import { sha256Hex } from '../store/hash';
export async function stableProblemId(signature: string): Promise<string> {
 const normalized=signature.trim().replace(/\s+/g,' ').toLowerCase();
 if (!normalized || normalized.length>4096) throw new Error('INVALID_PROBLEM_SIGNATURE');
 return sha256Hex(normalized);
}
export function rotateCorrector(eligible: readonly string[], previous: string | null): string | null {
 const unique=[...new Set(eligible)];
 const valid=unique.filter(x=>/^[a-z0-9_-]{1,120}$/i.test(x));
 const pool=valid.toSorted();
 if (!pool.length) return null;
 return previous===null ? pool[0] : pool[(pool.indexOf(previous)+1)%pool.length];
}
export const AUTOFIX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cc5_autofix_problems (
    cycle TEXT NOT NULL, problem_id TEXT NOT NULL, first_failure_at INTEGER NOT NULL,
    first_failure_ref TEXT NOT NULL, PRIMARY KEY(cycle,problem_id))`,
  `CREATE TABLE IF NOT EXISTS cc5_autofix_attempts (
    cycle TEXT NOT NULL, problem_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    day_utc TEXT NOT NULL, corrector TEXT NOT NULL, reviewer TEXT NOT NULL,
    tester TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    PRIMARY KEY(cycle,problem_id,attempt))`,
  'CREATE INDEX IF NOT EXISTS cc5_autofix_day ON cc5_autofix_attempts(cycle,day_utc)',
] as const;

export interface AutoFixClaim {
  cycle: string; problemId: string; failureRef: string; now: number;
  corrector: string; reviewer: string; tester: string;
  correctorFamily: string; reviewerFamily: string; testerFamily: string;
  correctorChannel: 'api' | 'trusted'; reviewerChannel: 'trusted'; testerChannel: 'trusted';
}
export interface AutoFixClaimResult { accepted: boolean; attempt: number | null; dayUtc: string }

/**
 * One D1 batch: first failure registration + quota-controlled attempt.
 * Both writes independently recheck HALT in their own INSERT statement.
 * The INSERT ... SELECT counters are evaluated atomically by D1, not in JS.
 */
export async function claimAutoFix(db: D1Database, input: AutoFixClaim): Promise<AutoFixClaimResult> {
  const valid = /^[a-z0-9_-]{1,120}$/i;
  if (!valid.test(input.cycle) || !/^[a-f0-9]{64}$/.test(input.problemId) ||
      !input.failureRef.trim() || input.failureRef.length > 512 ||
      !Number.isSafeInteger(input.now) || input.now < 0 ||
      ![input.corrector,input.reviewer,input.tester,
        input.correctorFamily,input.reviewerFamily,input.testerFamily].every(x=>valid.test(x)) ||
      new Set([input.correctorFamily,input.reviewerFamily,input.testerFamily]).size !== 3 ||
      new Set([input.corrector,input.reviewer,input.tester]).size !== 3 ||
      !['api','trusted'].includes(input.correctorChannel) ||
      input.reviewerChannel !== 'trusted' || input.testerChannel !== 'trusted') {
    return {accepted:false,attempt:null,dayUtc:''};
  }
  const dayUtc = new Date(input.now * 1000).toISOString().slice(0,10);
  await db.batch(AUTOFIX_SCHEMA.map(sql=>db.prepare(sql)));
  const [first, attempt] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO cc5_autofix_problems
      (cycle,problem_id,first_failure_at,first_failure_ref)
      SELECT ?1,?2,?3,?4
      WHERE EXISTS (SELECT 1 FROM cycles WHERE cycle_id=?1 AND status='open')
        AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name='halt' AND value='1')`)
      .bind(input.cycle,input.problemId,input.now,input.failureRef),
    db.prepare(`INSERT OR IGNORE INTO cc5_autofix_attempts
      (cycle,problem_id,attempt,day_utc,corrector,reviewer,tester,claimed_at)
      SELECT ?1,?2,
        (SELECT COUNT(*)+1 FROM cc5_autofix_attempts WHERE cycle=?1 AND problem_id=?2),
        ?3,?4,?5,?6,?7
      WHERE EXISTS (SELECT 1 FROM cycles WHERE cycle_id=?1 AND status='open')
        AND EXISTS (SELECT 1 FROM cc5_autofix_problems WHERE cycle=?1 AND problem_id=?2)
        AND NOT EXISTS (SELECT 1 FROM owner_flags WHERE name='halt' AND value='1')
        AND (SELECT COUNT(*) FROM cc5_autofix_attempts WHERE cycle=?1 AND problem_id=?2) < 2
        AND (SELECT COUNT(*) FROM cc5_autofix_attempts WHERE cycle=?1 AND day_utc=?3) < 5`)
      .bind(input.cycle,input.problemId,dayUtc,input.corrector,input.reviewer,input.tester,input.now),
  ]);
  void first;
  if (attempt.meta.changes !== 1) return {accepted:false,attempt:null,dayUtc};
  const row=await db.prepare(`SELECT attempt FROM cc5_autofix_attempts
    WHERE cycle=?1 AND problem_id=?2 ORDER BY attempt DESC LIMIT 1`)
    .bind(input.cycle,input.problemId).first<{attempt:number}>();
  return {accepted:true,attempt:row?.attempt ?? null,dayUtc};
}

/** Trusted owner-provided roster. Never accept family or channel from a proposed fix. */
export interface AutoFixPrincipal { id:string; family:string; channel:'api'|'trusted' }
export interface AutoFixTrustedPolicy {
  correctors: readonly AutoFixPrincipal[];
  reviewer: AutoFixPrincipal;
  tester: AutoFixPrincipal;
}
export interface AutoFixFailure {
  cycle:string; signature:string; failureRef:string; now:number;
}
/**
 * Single pilot entry point: stable fingerprint and rotating corrector derived
 * from a trusted roster, not from agent-authored JSON. No fix is executed.
 */
export async function claimAutoFixForFailure(
  db:D1Database, failure:AutoFixFailure, policy:AutoFixTrustedPolicy,
):Promise<AutoFixClaimResult> {
  const problemId=await stableProblemId(failure.signature);
  if (policy.reviewer.channel!=='trusted' || policy.tester.channel!=='trusted') {
    return {accepted:false,attempt:null,dayUtc:''};
  }
  const eligible=policy.correctors.filter(p=>
    p.id!==policy.reviewer.id && p.id!==policy.tester.id &&
    p.family!==policy.reviewer.family && p.family!==policy.tester.family);
  if (eligible.length===0) return {accepted:false,attempt:null,dayUtc:''};
  await db.batch(AUTOFIX_SCHEMA.map(sql=>db.prepare(sql)));
  const previous=await db.prepare(`SELECT corrector FROM cc5_autofix_attempts
    WHERE cycle=?1 AND problem_id=?2 ORDER BY attempt DESC LIMIT 1`)
    .bind(failure.cycle,problemId).first<{corrector:string}>();
  const next=rotateCorrector(eligible.map(p=>p.id),previous?.corrector??null);
  const principal=eligible.find(p=>p.id===next);
  if (!principal) return {accepted:false,attempt:null,dayUtc:''};
  return claimAutoFix(db,{
    cycle:failure.cycle,problemId,failureRef:failure.failureRef,now:failure.now,
    corrector:principal.id,correctorFamily:principal.family,correctorChannel:principal.channel,
    reviewer:policy.reviewer.id,reviewerFamily:policy.reviewer.family,reviewerChannel:'trusted',
    tester:policy.tester.id,testerFamily:policy.tester.family,testerChannel:'trusted',
  });
}

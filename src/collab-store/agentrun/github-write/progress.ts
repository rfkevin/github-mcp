import { ToolRefused } from '../engine';
import type { WriteScope } from './authorization';

export async function ensureProgress(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS api_write_commits (effect_key TEXT PRIMARY KEY, cycle TEXT NOT NULL, task TEXT NOT NULL, branch TEXT NOT NULL, before_sha TEXT NOT NULL, after_sha TEXT, correction INTEGER NOT NULL, UNIQUE(cycle,task,branch,before_sha))'),
    db.prepare('CREATE TABLE IF NOT EXISTS api_write_checks (cycle TEXT NOT NULL, task TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, run_id INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(cycle,task,branch,sha))'),
  ]);
}
export async function reserveCommit(db: D1Database, s: WriteScope, key: string, head: string): Promise<void> {
  await ensureProgress(db);
  const existing = await db.prepare('SELECT cycle,task,branch,before_sha,after_sha FROM api_write_commits WHERE effect_key=?1').bind(key).first<{cycle:string;task:string;branch:string;before_sha:string;after_sha:string|null}>();
  if (existing) {
    if (existing.cycle !== s.cycle || existing.task !== s.task || existing.branch !== s.branch || existing.before_sha !== head) throw new ToolRefused('api_write_effect_conflict');
    if (existing.after_sha) throw new ToolRefused('api_write_already_committed');
    return; // same effect, after the engine has reconciled it
  }
  const prior = await db.prepare('SELECT after_sha FROM api_write_commits WHERE cycle=?1 AND task=?2 AND branch=?3')
    .bind(s.cycle, s.task, s.branch).all<{ after_sha: string | null }>();
  if (prior.results.some(p => p.after_sha === null)) throw new ToolRefused('api_write_needs_reconcile');
  const correction = prior.results.length > 0;
  if (correction && !prior.results.some(p => p.after_sha === head)) throw new ToolRefused('api_write_head_untracked');
  const check = await db.prepare('SELECT state FROM api_write_checks WHERE cycle=?1 AND task=?2 AND branch=?3 AND sha=?4')
    .bind(s.cycle, s.task, s.branch, head).first<{ state: string }>();
  if (correction && check?.state !== 'failed') throw new ToolRefused('api_write_wait_for_failed_ci');
  // A reservation is retained even after an uncertain transport result. Only lookup can settle it.
  const result = await db.prepare('INSERT OR IGNORE INTO api_write_commits (effect_key,cycle,task,branch,before_sha,correction) SELECT ?1,?2,?3,?4,?5,?6 WHERE (SELECT COUNT(*) FROM api_write_commits WHERE cycle=?2 AND task=?3 AND branch=?4) < 4')
    .bind(key, s.cycle, s.task, s.branch, head, correction ? 1 : 0).run();
  if (result.meta.changes !== 1) throw new ToolRefused('api_write_correction_limit_or_conflict');
}
export async function finishCommit(db: D1Database, key: string, sha: string): Promise<void> {
  await db.prepare('UPDATE api_write_commits SET after_sha=?2 WHERE effect_key=?1 AND (after_sha IS NULL OR after_sha=?2)').bind(key, sha).run();
}
export async function correctionsUsed(db: D1Database, s: WriteScope): Promise<number> {
  await ensureProgress(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM api_write_commits WHERE cycle=?1 AND task=?2 AND branch=?3 AND correction=1')
    .bind(s.cycle, s.task, s.branch).first<{ n: number }>();
  return row?.n ?? 0;
}
export async function recordCheck(db: D1Database, s: WriteScope, sha: string, runId: number, state: string): Promise<void> {
  await ensureProgress(db);
  await db.prepare('INSERT INTO api_write_checks (cycle,task,branch,sha,run_id,state) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(cycle,task,branch,sha) DO UPDATE SET run_id=excluded.run_id,state=excluded.state WHERE excluded.run_id>=api_write_checks.run_id')
    .bind(s.cycle, s.task, s.branch, sha, runId, state).run();
}

export async function releaseReservation(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM api_write_commits WHERE effect_key=?1 AND after_sha IS NULL').bind(key).run();
}

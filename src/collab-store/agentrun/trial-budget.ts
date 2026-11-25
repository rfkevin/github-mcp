// Each approval funds only the exact (cycle, task, participant) tuples shown to the owner.
// All members share the same immutable approval seq. Existing paid steps remain the ledger.
export const TRIAL_MEMBERS_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS agent_trial_members (',
  'cycle_id TEXT NOT NULL, task_id TEXT NOT NULL, participant_id TEXT NOT NULL,',
  'approval_seq INTEGER NOT NULL, limit_cents INTEGER NOT NULL CHECK(limit_cents >= 0),',
  'PRIMARY KEY(cycle_id, task_id, participant_id))',
].join(' ');

const trialUsage = `SELECT COALESCE(SUM(CASE WHEN s.settled = 1 THEN s.actual_cents ELSE s.reserved_cents END), 0)
  FROM agent_trial_members peer
  JOIN agent_runs r ON r.cycle_id=peer.cycle_id AND r.task_id=peer.task_id AND r.participant_id=peer.participant_id
  JOIN agent_paid_steps s ON s.run_id=r.run_id WHERE peer.approval_seq=m.approval_seq`;

export interface TrialBudget { limit_cents: number; used_cents: number }

export async function trialBudget(db: D1Database, cycle: string | null, task: string | null, participant: string) {
  if (!cycle || !task) return null;
  return db.prepare(`SELECT limit_cents, (${trialUsage}) AS used_cents FROM agent_trial_members m
    WHERE cycle_id=?1 AND task_id=?2 AND participant_id=?3`).bind(cycle, task, participant).first<TrialBudget>();
}

// NULL means no owner grant. Evaluate in the same transaction that inserts the paid step.
const runMember = `FROM agent_runs target
  JOIN agent_trial_members m ON m.cycle_id=target.cycle_id AND m.task_id=target.task_id
  AND m.participant_id=target.participant_id WHERE target.run_id=`;

export const RUN_TRIAL_REMAINING = `SELECT m.limit_cents - (${trialUsage}) ${runMember}?11`;

export async function trialForRun(db: D1Database, runId: string) {
  return db.prepare(`SELECT limit_cents, (${trialUsage}) AS used_cents ${runMember}?1`).bind(runId).first<TrialBudget>();
}

/** CC-5 L4: pure fail-closed gate for a candidate integration merge. */
import { nextActors, type ControllerSnapshot, type TaskFacts } from '../controller/rules';

export interface MergeCandidate {
  cycleId: string;
  taskId: string;
  head: string;
  base: string;
  integrationBase: string;
  prDraft: boolean;
  prMergeable: boolean;
  ciChecks: readonly { name: string; status: string; conclusion: string | null }[];
  expectedChecks: readonly string[];
  changedPaths: readonly string[];
  protectedPaths: readonly string[];
  lease: { cycleId: string; taskId: string; head: string; base: string; expiresAt: number; revoked: boolean } | null;
  now: number;
}
export interface GateVerdict { allowed: boolean; reasons: string[]; head: string; base: string }
const SHA = /^[0-9a-f]{40}$/;
const protectedMatch = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');

/**
 * This function is only an eligibility check, NEVER an authorization to merge.
 * The executor must re-read GitHub heads, CI, store facts, HALT and lease under
 * its own fenced authorization immediately before a protected write.
 */
export function evaluateMergeGate(snapshot: ControllerSnapshot, candidate: MergeCandidate): GateVerdict {
  const reasons: string[] = [];
  const deny = (reason: string) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!SHA.test(candidate.head) || !SHA.test(candidate.base)) deny('invalid_sha');
  if (candidate.cycleId !== snapshot.cycle_id) deny('wrong_cycle');
  if (snapshot.halted) deny('halt');
  const task: TaskFacts | undefined = snapshot.tasks.find(item => item.task_id === candidate.taskId);
  if (!task || task.status === 'blocked' || task.status === 'done' || task.status === 'verified') deny('task_not_active');
  if (!task?.submission || task.submission.head !== candidate.head || task.submission.base !== candidate.base)
    deny('submission_mismatch');
  if (candidate.base !== candidate.integrationBase) deny('integration_base_mismatch');
  if (candidate.prDraft) deny('draft_pr');
  if (!candidate.prMergeable) deny('unmergeable_pr');
  if (!candidate.lease || candidate.lease.revoked || candidate.lease.expiresAt <= candidate.now ||
      candidate.lease.cycleId !== candidate.cycleId || candidate.lease.taskId !== candidate.taskId ||
      candidate.lease.head !== candidate.head || candidate.lease.base !== candidate.base) deny('lease_invalid');
  if (!candidate.expectedChecks.length || new Set(candidate.expectedChecks).size !== candidate.expectedChecks.length)
    deny('checks_policy_invalid');
  for (const name of candidate.expectedChecks) {
    const matches = candidate.ciChecks.filter(check => check.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success')
      deny('ci_not_green');
  }
  if (!candidate.changedPaths.length) deny('empty_diff');
  if (candidate.changedPaths.some(path => !path || path.startsWith('/') || path.includes('..') ||
      candidate.protectedPaths.some(prefix => protectedMatch(path, prefix)))) deny('protected_or_invalid_path');
  if (!task || !nextActors(snapshot).decisions.some(decision =>
    decision.kind === 'merge_ready' && decision.task_id === candidate.taskId &&
    decision.subject === candidate.head + '..' + candidate.base)) deny('d12_verdicts_missing');
  return { allowed: reasons.length === 0, reasons, head: candidate.head, base: candidate.base };
}

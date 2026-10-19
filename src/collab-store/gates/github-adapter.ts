/**
 * CC-5 L4: concrete adapter connecting the controller/store reader, GitHub
 * integration executor and post-merge issue closer.
 *
 * The privileged executor is deliberately injected. A GitHub POST /merges
 * cannot atomically CAS a D1 lease and GitHub's branch ref; callers MUST use
 * a separately enforced, exclusive fencing protocol or deny the operation.
 */
import type { ControllerSnapshot } from '../controller/rules';
import type { MergeCandidate } from './merge-gate';
import { evaluateMergeGate } from './merge-gate';
import { executeIntegration, type IntegrationOutcome, type IntegrationPort } from './integration';
import { closeVerifiedIssue, type ClosurePort } from './closure';

export interface GitHubGateReader {
  /** Live store snapshot and live GitHub PR, checks, branch and lease, no cached values. */
  inspect(): Promise<{ snapshot: ControllerSnapshot; candidate: MergeCandidate }>;
  /** Independently verify GitHub PR is merged at this exact resulting SHA. */
  mergedPullRequest(mergeSha: string): Promise<boolean>;
  /** Explicit issue linked to this task; null means no automatic closure. */
  linkedIssue(): Promise<number | null>;
  closeIssue(issue: number): Promise<void>;
}

export interface FencedMergeExecutor {
  /**
   * Must hold an exclusive fence across store HALT/lease and GitHub writes.
   * Re-read all facts under the fence, evaluate the gate, assert exact refs,
   * then perform the merge. If a cross-system fence is unavailable, throw.
   * This callback is the only privileged write path.
   */
  mergeUnderFence(expected: { head: string; base: string },
    verify: (snapshot: ControllerSnapshot, candidate: MergeCandidate) => boolean):
    Promise<{ merged: boolean; mergeSha: string | null }>;
}

export interface GitHubGateTarget { pr: number; task: string; head: string; base: string }

export function githubIntegrationPort(reader: GitHubGateReader, writer: FencedMergeExecutor,
  target: GitHubGateTarget): IntegrationPort {
  const sameTarget = (candidate: MergeCandidate) =>
    candidate.taskId === target.task && candidate.head === target.head && candidate.base === target.base;
  const closure: ClosurePort = {
    mergedPullRequest: async (pr, sha) => pr === target.pr && reader.mergedPullRequest(sha),
    closeIssue: issue => reader.closeIssue(issue),
  };
  return {
    inspect: async () => {
      const facts = await reader.inspect();
      if (!sameTarget(facts.candidate)) throw new Error('L4_TARGET_CHANGED');
      return facts;
    },
    merge: expected => writer.mergeUnderFence(expected, (snapshot, candidate) =>
      sameTarget(candidate) && candidate.head === expected.head && candidate.base === expected.base &&
      evaluateMergeGate(snapshot, candidate).allowed),
    confirmMerged: sha => reader.mergedPullRequest(sha),
    closeAfterMerge: async sha => {
      const issue = await reader.linkedIssue();
      if (issue === null) return;
      if (!await closeVerifiedIssue(closure, target.pr, issue, sha))
        throw new Error('L4_CLOSURE_NOT_CONFIRMED');
    },
  };
}

/** Entry point for a privileged CC-5 integration execution. No bypass of the fence. */
export async function runGitHubIntegration(reader: GitHubGateReader, writer: FencedMergeExecutor,
  target: GitHubGateTarget): Promise<IntegrationOutcome> {
  if (!Number.isSafeInteger(target.pr) || target.pr <= 0 ||
      !/^[a-z0-9_-]+$/i.test(target.task) ||
      !/^[a-f0-9]{40}$/.test(target.head) || !/^[a-f0-9]{40}$/.test(target.base))
    throw new Error('L4_INVALID_TARGET');
  return executeIntegration(githubIntegrationPort(reader, writer, target));
}

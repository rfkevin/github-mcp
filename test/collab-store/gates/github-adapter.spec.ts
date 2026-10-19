import { describe, expect, it, vi } from 'vitest';
import { runGitHubIntegration, type GitHubGateReader, type FencedMergeExecutor } from '../../../src/collab-store/gates/github-adapter';
import type { ControllerSnapshot } from '../../../src/collab-store/controller/rules';
import type { MergeCandidate } from '../../../src/collab-store/gates';
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const target = { pr: 167, task: 'l4', head, base };
const snapshot: ControllerSnapshot = { cycle_id: 'c', revision: 1, phase: 'P6', halted: false,
  auto_advance: 'none', outputs_satisfied: false, tasks: [{ task_id: 'l4', status: 'review',
    revision: 1, owner: 'gpt6', reviewer: 'claude', tester: 'vibe', dependencies: [],
    submission: { head, base, seq: 1 }, verdicts: [
      { participant: 'claude', verdict: 'positive', head, base, seq: 2 },
      { participant: 'vibe', verdict: 'positive', head, base, seq: 3 }] }] };
const candidate: MergeCandidate = { cycleId: 'c', taskId: 'l4', head, base, integrationBase: base,
  prDraft: false, prMergeable: true, ciChecks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
  expectedChecks: ['ci'], changedPaths: ['src/collab-store/gates/index.ts'], protectedPaths: ['.github'],
  lease: { cycleId: 'c', taskId: 'l4', head, base, expiresAt: 200, revoked: false }, now: 100 };
const fixture = () => {
  const inspect = vi.fn(async () => ({ snapshot, candidate }));
  const mergedPullRequest = vi.fn(async () => true);
  const linkedIssue = vi.fn(async () => 13 as number | null);
  const closeIssue = vi.fn(async () => undefined);
  const reader = { inspect, mergedPullRequest, linkedIssue, closeIssue } satisfies GitHubGateReader;
  const mergeUnderFence = vi.fn(async (_expected: { head: string; base: string },
    verify: (snapshot: ControllerSnapshot, candidate: MergeCandidate) => boolean) =>
    verify(snapshot, candidate) ? { merged: true, mergeSha } : { merged: false, mergeSha: null });
  const writer = { mergeUnderFence } satisfies FencedMergeExecutor;
  return { reader, writer, mergeUnderFence, closeIssue, mergedPullRequest };
};
describe('CC-5 L4 privileged adapter', () => {
  it('connects guarded merge to GitHub confirmation and linked issue closure', async () => {
    const f = fixture();
    expect(await runGitHubIntegration(f.reader, f.writer, target)).toEqual({
      state: 'merged', mergeSha, closed: true });
    expect(f.mergeUnderFence).toHaveBeenCalledTimes(1);
    expect(f.closeIssue).toHaveBeenCalledWith(13);
  });
  it('rejects revoked lease inside fenced executor even after two green inspections', async () => {
    const f = fixture();
    f.mergeUnderFence.mockImplementationOnce(async (_expected, verify) =>
      verify(snapshot, { ...candidate, lease: { ...candidate.lease!, revoked: true } })
        ? { merged: true, mergeSha } : { merged: false, mergeSha: null });
    expect((await runGitHubIntegration(f.reader, f.writer, target)).state).toBe('unconfirmed');
    expect(f.closeIssue).not.toHaveBeenCalled();
  });
  it('never closes without verified merge or explicit issue', async () => {
    const f = fixture();
    f.mergedPullRequest.mockResolvedValueOnce(false);
    expect((await runGitHubIntegration(f.reader, f.writer, target)).state).toBe('unconfirmed');
    expect(f.closeIssue).not.toHaveBeenCalled();
    const noIssue = fixture();
    noIssue.reader.linkedIssue.mockResolvedValueOnce(null);
    expect(await runGitHubIntegration(noIssue.reader, noIssue.writer, target)).toEqual({
      state: 'merged', mergeSha, closed: true });
    expect(noIssue.closeIssue).not.toHaveBeenCalled();
  });
});

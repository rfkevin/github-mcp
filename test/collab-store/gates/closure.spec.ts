import { describe, expect, it, vi } from 'vitest';
import { closeVerifiedIssue } from '../../../src/collab-store/gates/closure';
import { gateEvidence } from '../../../src/collab-store/gates/verdicts';
const SHA = 'a'.repeat(40);
describe('L4 evidence and issue closure', () => {
  it('records exact D12 refs and blocks invalid targets', () => {
    const item = gateEvidence('l4', { allowed: false, reasons: ['halt'], head: SHA, base: SHA },
      'https://github.com/rfkevin/github-mcp/pull/167');
    expect(item).toMatchObject({ task: 'l4', verdict: 'BLOCK', reasons: ['halt'], head: SHA, base: SHA });
    expect(() => gateEvidence('../l4', { allowed: true, reasons: [], head: SHA, base: SHA }, item.source)).toThrow();
  });
  it('never closes unconfirmed PRs or invalid issue targets', async () => {
    const closeIssue = vi.fn(async () => undefined);
    const mergedPullRequest = vi.fn(async () => false);
    const port = { mergedPullRequest, closeIssue };
    expect(await closeVerifiedIssue(port, 167, 13, SHA)).toBe(false);
    expect(await closeVerifiedIssue(port, 167, -1, SHA)).toBe(false);
    expect(closeIssue).not.toHaveBeenCalled();
    mergedPullRequest.mockResolvedValueOnce(true);
    expect(await closeVerifiedIssue(port, 167, 13, SHA)).toBe(true);
    expect(closeIssue).toHaveBeenCalledWith(13);
  });
});

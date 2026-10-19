import { describe, expect, it, vi } from 'vitest';
import { executeIntegration, type IntegrationPort } from '../../../src/collab-store/gates/integration';
import type { ControllerSnapshot } from '../../../src/collab-store/controller/rules';
import type { MergeCandidate } from '../../../src/collab-store/gates';

const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const snapshot: ControllerSnapshot = {
  cycle_id: 'c', revision: 1, phase: 'P6', halted: false, auto_advance: 'none', outputs_satisfied: false,
  tasks: [{ task_id: 'l4', status: 'review', revision: 1, owner: 'gpt6', reviewer: 'claude', tester: 'vibe',
    dependencies: [], submission: { head, base, seq: 1 }, verdicts: [
      { participant: 'claude', verdict: 'positive', head, base, seq: 2 },
      { participant: 'vibe', verdict: 'positive', head, base, seq: 3 }] }],
};
const candidate: MergeCandidate = { cycleId: 'c', taskId: 'l4', head, base, integrationBase: base,
  prDraft: false, prMergeable: true, ciChecks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
  expectedChecks: ['ci'], changedPaths: ['src/collab-store/gates/index.ts'], protectedPaths: ['.github'],
  lease: { cycleId: 'c', taskId: 'l4', head, base, expiresAt: 200, revoked: false }, now: 100 };
const fixture = () => {
  const inspect = vi.fn(async () => ({ snapshot, candidate }));
  const merge = vi.fn(async (): Promise<{ merged: boolean; mergeSha: string | null }> => ({ merged: true, mergeSha: merged }));
  const confirmMerged = vi.fn(async () => true);
  const closeAfterMerge = vi.fn(async () => undefined);
  return { inspect, merge, confirmMerged, closeAfterMerge } satisfies IntegrationPort;
};
describe('L4 integration orchestration', () => {
  it('confirms merge before closing', async () => {
    const port = fixture();
    expect(await executeIntegration(port)).toEqual({ state: 'merged', mergeSha: merged, closed: true });
    expect(port.inspect).toHaveBeenCalledTimes(2);
    expect(port.merge).toHaveBeenCalledWith({ head, base });
    expect(port.closeAfterMerge).toHaveBeenCalledWith(merged);
  });
  it('denies HALT and lease expiration between reads', async () => {
    const halted = fixture();
    halted.inspect.mockResolvedValueOnce({ snapshot, candidate }).mockResolvedValueOnce({
      snapshot: { ...snapshot, halted: true }, candidate });
    expect((await executeIntegration(halted)).state).toBe('denied');
    expect(halted.merge).not.toHaveBeenCalled();
    const expired = fixture();
    expired.inspect.mockResolvedValueOnce({ snapshot, candidate }).mockResolvedValueOnce({
      snapshot, candidate: { ...candidate, now: 201 } });
    expect((await executeIntegration(expired)).state).toBe('denied');
    expect(expired.merge).not.toHaveBeenCalled();
  });
  it('never closes on failed or unconfirmed merge', async () => {
    const failed = fixture();
    failed.merge.mockResolvedValueOnce({ merged: false, mergeSha: null });
    expect((await executeIntegration(failed)).state).toBe('unconfirmed');
    expect(failed.closeAfterMerge).not.toHaveBeenCalled();
    const unconfirmed = fixture();
    unconfirmed.confirmMerged.mockResolvedValueOnce(false);
    expect((await executeIntegration(unconfirmed)).state).toBe('unconfirmed');
    expect(unconfirmed.closeAfterMerge).not.toHaveBeenCalled();
  });
});

describe('L4 confirmed merge with failed closure', () => {
  it('reports closure failure without retrying merge', async () => {
    const port = fixture();
    port.closeAfterMerge.mockRejectedValueOnce(new Error('GitHub close failed'));
    expect(await executeIntegration(port)).toEqual({ state: 'closure_failed', mergeSha: merged, closed: false });
    expect(port.merge).toHaveBeenCalledTimes(1);
  });
});

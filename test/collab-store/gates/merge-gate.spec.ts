import { describe, expect, it } from 'vitest';
import { evaluateMergeGate, type MergeCandidate } from '../../../src/collab-store/gates';
import type { ControllerSnapshot } from '../../../src/collab-store/controller/rules';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const snapshot: ControllerSnapshot = {
  cycle_id: 'cycle', revision: 5, phase: 'P6', halted: false, auto_advance: 'none',
  outputs_satisfied: false,
  tasks: [{ task_id: 'l4', status: 'review', revision: 3, owner: 'gpt6',
    reviewer: 'claude', tester: 'vibe', dependencies: [], submission: { head: H, base: B, seq: 10 },
    verdicts: [{ participant: 'claude', verdict: 'positive', head: H, base: B, seq: 11 },
      { participant: 'vibe', verdict: 'positive', head: H, base: B, seq: 12 }] }],
};
const candidate: MergeCandidate = {
  cycleId: 'cycle', taskId: 'l4', head: H, base: B, integrationBase: B,
  prDraft: false, prMergeable: true,
  ciChecks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
  expectedChecks: ['ci'], changedPaths: ['src/collab-store/gates/index.ts'],
  protectedPaths: ['src/collab-store/owner', '.github'],
  lease: { cycleId: 'cycle', taskId: 'l4', head: H, base: B, expiresAt: 200, revoked: false }, now: 100,
};
const gate = (changes: Partial<MergeCandidate> = {}, state: ControllerSnapshot = snapshot) =>
  evaluateMergeGate(state, { ...candidate, ...changes });

describe('L4 integration gate: fail closed', () => {
  it('allows a fully checked candidate, without executing a merge', () => {
    expect(gate()).toEqual({ allowed: true, reasons: [], head: H, base: B });
  });
  it.each([
    [{ head: 'c'.repeat(40) }, 'submission_mismatch'],
    [{ base: 'c'.repeat(40) }, 'integration_base_mismatch'],
    [{ prDraft: true }, 'draft_pr'],
    [{ prMergeable: false }, 'unmergeable_pr'],
    [{ lease: null }, 'lease_invalid'],
    [{ lease: { ...candidate.lease!, revoked: true } }, 'lease_invalid'],
    [{ lease: { ...candidate.lease!, expiresAt: 100 } }, 'lease_invalid'],
    [{ ciChecks: [] }, 'ci_not_green'],
    [{ ciChecks: [{ name: 'ci', status: 'completed', conclusion: 'skipped' }] }, 'ci_not_green'],
    [{ expectedChecks: [] }, 'checks_policy_invalid'],
    [{ changedPaths: ['src/collab-store/owner/executable.ts'] }, 'protected_or_invalid_path'],
    [{ changedPaths: ['../escape'] }, 'protected_or_invalid_path'],
  ] as const)('rejects unsafe candidate %j', (change, reason) => {
    expect(gate(change).reasons).toContain(reason);
  });
  it('denies HALT and never treats a stale verdict as current', () => {
    expect(gate({}, { ...snapshot, halted: true }).reasons).toContain('halt');
    const task = snapshot.tasks[0];
    expect(gate({}, { ...snapshot, tasks: [{ ...task,
      verdicts: [{ ...task.verdicts[0], base: 'c'.repeat(40) }, task.verdicts[1]] }] }).reasons)
      .toContain('d12_verdicts_missing');
  });
  it('denies a negative verdict and unknown task', () => {
    const task = snapshot.tasks[0];
    expect(gate({}, { ...snapshot, tasks: [{ ...task,
      verdicts: [{ ...task.verdicts[0], verdict: 'negative' }, task.verdicts[1]] }] }).allowed).toBe(false);
    expect(gate({ taskId: 'unknown' }).reasons).toContain('task_not_active');
  });
});

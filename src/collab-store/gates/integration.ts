/** CC-5 L4: guarded orchestration; privileged adapter enforces CAS at merge. */
import { evaluateMergeGate, type MergeCandidate, type GateVerdict } from './merge-gate';
import type { ControllerSnapshot } from '../controller/rules';

export interface IntegrationPort {
  inspect(): Promise<{ snapshot: ControllerSnapshot; candidate: MergeCandidate }>;
  /** Must reject stale GitHub head/base and revoked lease atomically at write. */
  merge(expected: { head: string; base: string }): Promise<{ merged: boolean; mergeSha: string | null }>;
  confirmMerged(mergeSha: string): Promise<boolean>;
  closeAfterMerge(mergeSha: string): Promise<void>;
}
export type IntegrationOutcome =
  | { state: 'denied'; verdict: GateVerdict }
  | { state: 'merged'; mergeSha: string; closed: boolean }
  | { state: 'unconfirmed'; mergeSha: string | null; closed: false }
  | { state: 'closure_failed'; mergeSha: string; closed: false };

export async function executeIntegration(port: IntegrationPort): Promise<IntegrationOutcome> {
  const first = await port.inspect();
  const initial = evaluateMergeGate(first.snapshot, first.candidate);
  if (!initial.allowed) return { state: 'denied', verdict: initial };
  const second = await port.inspect();
  const refreshed = evaluateMergeGate(second.snapshot, second.candidate);
  if (!refreshed.allowed || first.candidate.head !== second.candidate.head ||
      first.candidate.base !== second.candidate.base || first.candidate.taskId !== second.candidate.taskId)
    return { state: 'denied', verdict: refreshed.allowed
      ? { ...refreshed, allowed: false, reasons: ['candidate_changed'] } : refreshed };
  const result = await port.merge({ head: second.candidate.head, base: second.candidate.base });
  if (!result.merged || !result.mergeSha) return { state: 'unconfirmed', mergeSha: null, closed: false };
  if (!await port.confirmMerged(result.mergeSha))
    return { state: 'unconfirmed', mergeSha: result.mergeSha, closed: false };
  try { await port.closeAfterMerge(result.mergeSha); }
  catch { return { state: 'closure_failed', mergeSha: result.mergeSha, closed: false }; }
  return { state: 'merged', mergeSha: result.mergeSha, closed: true };
}

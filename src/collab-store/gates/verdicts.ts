/** CC-5 L4 — append-only gate verdict record, suitable for evidence.add. */
import type { GateVerdict } from './merge-gate';
export interface GateEvidence {
  task: string;
  verdict: 'PASS' | 'BLOCK';
  head: string;
  base: string;
  state: string;
  reasons: string[];
  source: string;
}
/** Store adapters append this payload; never mutate a prior D12 verdict. */
export function gateEvidence(task: string, verdict: GateVerdict, prUrl: string): GateEvidence {
  if (!/^[a-z0-9_-]+$/i.test(task) || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(prUrl))
    throw new Error('Invalid gate evidence target');
  return { task, verdict: verdict.allowed ? 'PASS' : 'BLOCK', head: verdict.head,
    base: verdict.base, state: verdict.allowed ? 'gate_eligible' : 'gate_denied',
    reasons: [...verdict.reasons], source: prUrl };
}

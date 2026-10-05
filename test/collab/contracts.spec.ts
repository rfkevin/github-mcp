import { describe, expect, it } from 'vitest';
import {
  validateMemoryCandidate,
  validateMemoryDecision,
  validateTaskAssignment,
  validateOperationRecord,
  validatePublicationReceipt,
} from '../../src/collab/contracts';

describe('CC-2 memory contracts', () => {
  const candidate = {
    id: 'mem-1',
    version: '1',
    scope: 'global_usage' as const,
    statement: 'Use bounded delta reads before full discussion reads.',
    knowledgeState: 'hypothesis' as const,
    source: { location: 'issue-16#comment-1', revision: 1, completeness: 'complete' as const },
    proposedBy: 'Codex',
  };

  it('keeps useful observations distinguishable from verified facts', () => {
    expect(() => validateMemoryCandidate(candidate)).not.toThrow();
    expect(() => validateMemoryCandidate({ ...candidate, knowledgeState: 'verified', source: { ...candidate.source, completeness: 'partial' as const, continuationOffset: 4000 } })).toThrow(/complete evidence/);
  });

  it('requires quorum and preserves pending publication', () => {
    const decision = {
      candidateId: 'mem-1',
      candidateVersion: '1',
      scope: 'global_usage' as const,
      decision: 'accepted' as const,
      publication: 'pending' as const,
      quorum: 2,
      decidedBy: 'owner',
      ballots: [
        { candidateId: 'mem-1', voter: 'Codex', value: 'keep' as const },
        { candidateId: 'mem-1', voter: 'Vibe', value: 'keep' as const },
      ],
    };
    expect(() => validateMemoryDecision(decision, candidate)).not.toThrow();
    expect(() => validateMemoryDecision({ ...decision, ballots: decision.ballots.slice(0, 1) })).toThrow(/quorum/);
  });
});

describe('CC-2 contract invariants', () => {
  it('rejects candidate id and version mismatches between decision and candidate', () => {
    const decision = {
      candidateId: 'mem-1',
      candidateVersion: '2',
      scope: 'global_usage' as const,
      decision: 'accepted' as const,
      publication: 'pending' as const,
      quorum: 2,
      decidedBy: 'owner',
      ballots: [
        { candidateId: 'mem-1', voter: 'Codex', value: 'keep' as const },
        { candidateId: 'mem-1', voter: 'Vibe', value: 'keep' as const },
      ],
    };
    const candidateV1 = { ...candidate, version: '1' };
    expect(() => validateMemoryDecision(decision, candidateV1)).toThrow(/different version/);
    expect(() => validateMemoryDecision({ ...decision, candidateId: 'mem-2', candidateVersion: '1' }, candidateV1)).toThrow(/candidate id/);
  });

  it('requires distinct author, reviewer and tester', () => {
    expect(() => validateTaskAssignment('Codex', 'Vibe GLM', 'Grok')).not.toThrow();
    expect(() => validateTaskAssignment('Codex', 'Codex', 'Grok')).toThrow(/distinct/);
  });

  it('validates operation records and publication receipts for later lots', () => {
    expect(() => validateOperationRecord({ operationId: 'op-1', payloadFingerprint: 'sha:abc', steps: [{ stepId: 's1', outcome: 'success' }] })).not.toThrow();
    expect(() => validatePublicationReceipt({ operationId: 'op-1', ref: 'pr-36', outcome: 'pending', reconcileRequired: true })).not.toThrow();
    expect(() => validatePublicationReceipt({ operationId: 'op-1', ref: 'pr-36', outcome: 'archived' as never, reconcileRequired: false })).toThrow(/unsupported value/);
  });
});

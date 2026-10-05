import { describe, expect, it } from 'vitest';
import { validateMemoryCandidate, validateMemoryDecision } from '../../src/collab/contracts';

describe('CC-2 memory contracts', () => {
  const candidate = {
    id: 'mem-1',
    scope: 'global_usage' as const,
    statement: 'Use bounded delta reads before full discussion reads.',
    knowledgeState: 'hypothesis' as const,
    source: { location: 'issue-16#comment-1', revision: 1, complete: true },
    proposedBy: 'Codex',
  };

  it('keeps useful observations distinguishable from verified facts', () => {
    expect(() => validateMemoryCandidate(candidate)).not.toThrow();
    expect(() => validateMemoryCandidate({ ...candidate, knowledgeState: 'verified', source: { ...candidate.source, complete: false } })).toThrow(/complete evidence/);
  });

  it('requires quorum and preserves pending publication', () => {
    const decision = {
      candidateId: 'mem-1',
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
    expect(() => validateMemoryDecision(decision)).not.toThrow();
    expect(() => validateMemoryDecision({ ...decision, ballots: decision.ballots.slice(0, 1) })).toThrow(/quorum/);
  });
});

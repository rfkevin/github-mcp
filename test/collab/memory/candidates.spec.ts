import { describe, expect, it } from 'vitest';
import { assertSameMeaning, bumpCandidateVersion, createCandidate } from '../../../src/collab/memory/candidates';

const complete = { location: 'issue-16#1', revision: 1, completeness: 'complete' as const };

describe('L5 candidates', () => {
  it('allows hypothesis with incomplete evidence', () => {
    const candidate = createCandidate({
      id: 'h1',
      version: '1',
      scope: 'project',
      statement: 'Maybe group independent reads.',
      knowledgeState: 'hypothesis',
      source: { location: 'issue-16#1', revision: 1, completeness: 'partial', continuationOffset: 4000 },
      proposedBy: 'Grok',
    });
    expect(candidate.knowledgeState).toBe('hypothesis');
  });

  it('requires complete evidence for observed/verified', () => {
    expect(() =>
      createCandidate({
        id: 'o1',
        version: '1',
        scope: 'global_usage',
        statement: 'Fact',
        knowledgeState: 'verified',
        source: { location: 'issue-16#1', revision: 1, completeness: 'partial', continuationOffset: 1 },
        proposedBy: 'Grok',
      }),
    ).toThrow(/complete evidence/);
  });

  it('bumps version and invalidates same-meaning check across versions', () => {
    const v1 = createCandidate({
      id: 'mem-1',
      version: '1',
      scope: 'global_usage',
      statement: 'A',
      knowledgeState: 'observed',
      source: complete,
      proposedBy: 'Grok',
    });
    const v2 = bumpCandidateVersion(v1, { statement: 'A clarified' }, '2');
    expect(v2.version).toBe('2');
    expect(v2.previousVersion).toBe('1');
    expect(() => assertSameMeaning(v1, v2)).toThrow(/different candidate version/);
  });
});

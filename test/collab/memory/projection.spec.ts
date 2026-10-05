import { describe, expect, it } from 'vitest';
import { createCandidate } from '../../../src/collab/memory/candidates';
import { projectMemory, summarizeCollection } from '../../../src/collab/memory/projection';
import type { MemoryEntryStatus } from '../../../src/collab/memory/projection';

const source = { location: 'issue-16#1', revision: 1, completeness: 'complete' as const };

function entry(
  over: Partial<MemoryEntryStatus> & { statement?: string; knowledgeState?: MemoryEntryStatus['knowledgeState'] },
): MemoryEntryStatus {
  const knowledgeState = over.knowledgeState ?? 'observed';
  const candidate = createCandidate({
    id: over.candidate?.id ?? 'mem-x',
    version: over.candidate?.version ?? '1',
    scope: over.candidate?.scope ?? 'global_usage',
    statement: over.statement ?? 'Lesson',
    knowledgeState,
    source,
    proposedBy: 'Grok',
  });
  return {
    candidate,
    decision: over.decision ?? 'none',
    publication: over.publication ?? 'unknown',
    knowledgeState,
  };
}

describe('L5 projection', () => {
  it('marks hypotheses as non-instructions and filters by scope', () => {
    const entries = [
      entry({ candidate: { id: 'h1', version: '1', scope: 'global_usage', statement: '', knowledgeState: 'hypothesis', source, proposedBy: 'Grok' } as never, knowledgeState: 'hypothesis', decision: 'pending' }),
      entry({
        candidate: createCandidate({
          id: 'a1',
          version: '1',
          scope: 'project',
          statement: 'Local only',
          knowledgeState: 'verified',
          source,
          proposedBy: 'Grok',
        }),
        decision: 'accepted',
        publication: 'effective',
        knowledgeState: 'verified',
      }),
    ];
    const projected = projectMemory(entries, { scopes: ['global_usage'], includeHypotheses: true });
    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0].advisory).toContain('Hypothesis only');
  });

  it('summarizes final collection buckets', () => {
    const entries = [
      entry({
        candidate: createCandidate({
          id: 'a',
          version: '1',
          scope: 'global_usage',
          statement: 'A',
          knowledgeState: 'observed',
          source,
          proposedBy: 'Grok',
        }),
        decision: 'accepted',
        publication: 'pending',
        knowledgeState: 'observed',
      }),
      entry({
        candidate: createCandidate({
          id: 'b',
          version: '1',
          scope: 'global_usage',
          statement: 'B',
          knowledgeState: 'observed',
          source,
          proposedBy: 'Grok',
        }),
        decision: 'deferred',
        publication: 'pending',
        knowledgeState: 'observed',
      }),
    ];
    const summary = summarizeCollection(entries);
    expect(summary.accepted).toEqual(['a@1']);
    expect(summary.deferred).toEqual(['b@1']);
  });
});

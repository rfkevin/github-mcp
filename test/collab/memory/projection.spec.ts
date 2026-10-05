import { describe, expect, it } from 'vitest';
import { createCandidate } from '../../../src/collab/memory/candidates';
import { matchesApplicability, projectMemory, summarizeCollection } from '../../../src/collab/memory/projection';
import type { MemoryEntryStatus } from '../../../src/collab/memory/projection';

const source = { location: 'issue-16#1', revision: 1, completeness: 'complete' as const };

function entry(id: string, over: Partial<MemoryEntryStatus> & { applicability?: string; scope?: MemoryEntryStatus['candidate']['scope'] } = {}): MemoryEntryStatus {
  const knowledgeState = over.knowledgeState ?? 'observed';
  const candidate = createCandidate({
    id,
    version: '1',
    scope: over.scope ?? 'global_usage',
    statement: 'Lesson ' + id,
    knowledgeState,
    source,
    proposedBy: 'Grok',
    applicability: over.applicability,
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
      entry('h1', { knowledgeState: 'hypothesis', decision: 'pending' }),
      entry('a1', { scope: 'project', knowledgeState: 'verified', decision: 'accepted', publication: 'effective' }),
    ];
    const projected = projectMemory(entries, { scopes: ['global_usage'], includeHypotheses: true });
    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0].advisory).toContain('Hypothesis only');
  });

  it('excludes entries whose applicability does not match the target repository', () => {
    expect(matchesApplicability('rfkevin/github-mcp', 'rfkevin/other')).toBe(false);
    expect(matchesApplicability('rfkevin/github-mcp,rfkevin/project-mcp-collab', 'rfkevin/github-mcp')).toBe(true);
    expect(matchesApplicability('*', 'rfkevin/any')).toBe(true);
    const entries = [
      entry('local', { applicability: 'rfkevin/project-mcp-collab', decision: 'accepted', publication: 'effective' }),
      entry('global', { applicability: '*', decision: 'accepted', publication: 'effective' }),
    ];
    const projected = projectMemory(entries, { repository: 'rfkevin/github-mcp' });
    expect(projected.entries.map((item) => item.candidate.id)).toEqual(['global']);
  });

  it('summarizes final collection buckets', () => {
    const entries = [
      entry('a', { decision: 'accepted', publication: 'pending' }),
      entry('b', { decision: 'deferred', publication: 'pending' }),
    ];
    const summary = summarizeCollection(entries);
    expect(summary.accepted).toEqual(['a@1']);
    expect(summary.deferred).toEqual(['b@1']);
  });
});

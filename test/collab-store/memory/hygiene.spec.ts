import { describe, expect, it } from 'vitest';
import {
  archiveFirstCompare,
  classifyScope,
  consolidationBinding,
  countsTowardCap,
  DEFAULT_SCOPE_ENTRY_CAPS,
  isArchivableCandidate,
  parseConsolidationBinding,
  scopeEntryCap,
} from '../../../src/collab-store/memory/hygiene';

describe('L5 memory hygiene policy (pure, D3)', () => {
  it('default caps: 25 private, 50 shared, overridable for tests', () => {
    expect(DEFAULT_SCOPE_ENTRY_CAPS).toEqual({ participant: 25, shared: 50 });
    expect(scopeEntryCap('participant')).toBe(25);
    expect(scopeEntryCap('common')).toBe(50);
    expect(scopeEntryCap('project:x', { participant: 1, shared: 2 })).toBe(2);
    expect(scopeEntryCap('participant:p', { participant: 1, shared: 2 })).toBe(1);
  });

  it('classifies participant scopes as private (X2/CRB-R1)', () => {
    expect(classifyScope('participant:agent:a')).toEqual({ family: 'participant', private: true });
    expect(classifyScope('common')).toEqual({ family: 'common', private: false });
    expect(classifyScope('project:github-mcp')).toEqual({ family: 'project', private: false });
  });

  it('critical kinds never count toward a cap and are never archive candidates', () => {
    expect(countsTowardCap('invariant')).toBe(false);
    expect(countsTowardCap('decision')).toBe(false);
    expect(countsTowardCap('lesson')).toBe(true);
    expect(isArchivableCandidate({ kind: 'invariant', status: 'active' })).toBe(false);
    expect(isArchivableCandidate({ kind: 'decision', status: 'active' })).toBe(false);
    expect(isArchivableCandidate({ kind: 'lesson', status: 'active' })).toBe(true);
    expect(isArchivableCandidate({ kind: 'lesson', status: 'candidate' })).toBe(false);
    expect(isArchivableCandidate({ kind: 'lesson', status: 'retired' })).toBe(false);
  });

  it('archive-first order: never-served first, then oldest last_used_rev (D3-e)', () => {
    const neverServed = { uses: 0, last_used_rev: null };
    const olderUse = { uses: 2, last_used_rev: 5 };
    const recentUse = { uses: 2, last_used_rev: 30 };
    expect(archiveFirstCompare(neverServed, olderUse)).toBeLessThan(0);
    expect(archiveFirstCompare(olderUse, recentUse)).toBeLessThan(0);
    expect(archiveFirstCompare(olderUse, { uses: 2, last_used_rev: 5 })).toBe(0);
    expect(archiveFirstCompare(neverServed, neverServed)).toBe(0);
  });

  it('consolidation binding round-trips and rejects malformed refs (GPT-6)', () => {
    const binding = { source_seq_from: 10, source_seq_to: 20, source_hash: 'a'.repeat(64), version: 1, review_at: 1234 };
    const ref = consolidationBinding(binding);
    expect(parseConsolidationBinding(ref)).toEqual(binding);
    expect(parseConsolidationBinding('not-json')).toBeNull();
    expect(parseConsolidationBinding('{}')).toBeNull();
    expect(parseConsolidationBinding(JSON.stringify({ consolidation: 2, ...binding }))).toBeNull();
    expect(parseConsolidationBinding(JSON.stringify({ consolidation: 1, ...binding, source_hash: 'zz' }))).toBeNull();
    expect(() => consolidationBinding({ ...binding, source_seq_from: 30 })).toThrow();
    expect(() => consolidationBinding({ ...binding, version: 0 })).toThrow();
    expect(() => consolidationBinding({ ...binding, source_hash: 'nope' })).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { planGuidedS7, type S7Scope } from '../../../src/collab-store/agentrun/s7-guided.js';

describe('planGuidedS7', () => {
  const baseScope: S7Scope = {
    branch: 'mcp/105856986/gemini-api-s7-compare-1',
    name: 's7-compare-1',
    base_branch: 'mcp/105856986/cc3-integration',
    base_sha: '885e996a8ad2dc222a1b21dc8a50d49afce8a37f',
    allowed_files: ['test/collab-store/agentrun/s7-compare-gemini-1.spec.ts'],
  };

  it('retourne kind stop avec reason commit_budget_exhausted quand corrections_remaining=0', () => {
    const plan = planGuidedS7({
      scope: baseScope,
      corrections_remaining: 0,
      branch_head: '885e996a8ad2dc222a1b21dc8a50d49afce8a37f',
    });

    expect(plan).toEqual({
      kind: 'stop',
      reason: 'commit_budget_exhausted',
    });
  });

  it('émet l appel github_create_branch quand branch_head est absent et corrections_remaining=3', () => {
    const plan = planGuidedS7({
      scope: baseScope,
      corrections_remaining: 3,
    });

    expect(plan).toEqual({
      kind: 'server_call',
      call: {
        tool: 'github_create_branch',
        args: {
          name: baseScope.name,
          base_sha: baseScope.base_sha,
        },
      },
    });
  });
});

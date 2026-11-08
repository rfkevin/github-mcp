import { describe, it, expect } from 'vitest';
import { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';
import { AgentRunScope } from '../../../src/collab-store/types';

function validScope(): AgentRunScope {
  return {
    role: 'test',
    project_id: 'test-project',
    tool_registry: {},
    auth: { type: 'dummy' },
    corrections_remaining: 0,
  };
}

describe('planGuidedS7', () => {
  it('returns stop with budget exhausted when corrections_remaining is 0', () => {
    const scope = validScope();
    const result = planGuidedS7(scope);
    expect(result).toEqual({ kind: 'stop', reason: 'commit_budget_exhausted' });
  });

  it('emits github_create_branch when corrections_remaining is 3 and branch_head is absent', () => {
    const scope: AgentRunScope = {
      ...validScope(),
      corrections_remaining: 3,
      branch_head: undefined, // Mimic absent branch_head
      tool_registry: {
        github_create_branch: jest.fn(),
      },
    };

    const result = planGuidedS7(scope);
    expect(result).not.toEqual({ kind: 'stop', reason: 'commit_budget_exhausted' });
    expect(result).toHaveProperty('tool', 'github_create_branch');
    expect(result).toHaveProperty('args');
    expect((result as any).args).toEqual(expect.any(Array));
  });
});

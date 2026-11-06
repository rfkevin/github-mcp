import { describe, expect, it } from 'vitest';
import {
  PLAN_IMPLEMENT_MAX_STEPS, PLAN_MAX_STEPS, TASK_KIND_MAX_TOKENS,
  TASK_KIND_COST_CENTS, taskKindMaxSteps, taskKindMaxTokens, taskKindCostCents,
  type PlannedTaskKind,
} from '../../../src/collab-store/agentrun/plan';

describe('CC8 S7 — budget des étapes API implement', () => {
  const kinds: PlannedTaskKind[] = ['answer', 'review', 'test', 'design', 'implement'];

  it('donne 12 étapes uniquement à implement et laisse les autres kinds à 6', () => {
    expect(PLAN_MAX_STEPS).toBe(6);
    expect(PLAN_IMPLEMENT_MAX_STEPS).toBe(12);
    for (const kind of kinds) {
      expect(taskKindMaxSteps(kind)).toBe(kind === 'implement' ? 12 : 6);
    }
  });

  it('ne modifie ni le plafond de jetons ni les coûts autorisés', () => {
    expect(taskKindMaxTokens('implement')).toBe(24_000);
    for (const kind of kinds) {
      expect(taskKindMaxTokens(kind)).toBe(TASK_KIND_MAX_TOKENS[kind]);
      expect(taskKindCostCents({}, kind)).toBe(TASK_KIND_COST_CENTS[kind]);
      expect(TASK_KIND_COST_CENTS[kind]).toBe(0);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { UNBOUNDED_MISSION, taskKindMaxSteps, taskKindMaxTokens, taskKindCostCents,
  TASK_KIND_COST_CENTS, type PlannedTaskKind } from '../../../src/collab-store/agentrun/plan';

describe('CC8 WorkSession — même durée logique pour tous les agents API', () => {
  const kinds: PlannedTaskKind[] = ['answer','review','test','design','implement'];
  it('aucune limite métier de tours ni de tokens, même au-delà de l’ancien 12/48k', () => {
    expect(UNBOUNDED_MISSION).toBe(-1);
    for (const kind of kinds) {
      expect(taskKindMaxSteps(kind)).toBe(-1);
      expect(taskKindMaxTokens(kind)).toBe(-1);
      expect(taskKindMaxTokens(kind,{AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS:'120000'})).toBe(-1);
      expect(taskKindMaxTokens(kind,{AGENT_RUN_COST_CENTS_IMPLEMENT:'5'})).toBe(-1);
    }
  });
  it('conserve la séparation stricte des autorisations financières owner', () => {
    for (const kind of kinds) {
      expect(TASK_KIND_COST_CENTS[kind]).toBe(0);
      expect(taskKindCostCents({},kind)).toBe(0);
      expect(taskKindCostCents({['AGENT_RUN_COST_CENTS_'+kind.toUpperCase()]:'5'},kind)).toBe(5);
    }
  });
});

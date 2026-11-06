import { describe, expect, it } from 'vitest';
import {
  PLAN_IMPLEMENT_MAX_STEPS, PLAN_MAX_STEPS, TASK_KIND_MAX_TOKENS,
  FREE_IMPLEMENT_DEFAULT_TOKENS, FREE_IMPLEMENT_EXPERIMENT_MAX_TOKENS,
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

  it('double par défaut implement gratuit, sans changer les autres kinds ni les coûts', () => {
    expect(FREE_IMPLEMENT_DEFAULT_TOKENS).toBe(48_000);
    expect(FREE_IMPLEMENT_EXPERIMENT_MAX_TOKENS).toBe(120_000);
    expect(taskKindMaxTokens('implement')).toBe(48_000);
    for (const kind of kinds) {
      if (kind !== 'implement') expect(taskKindMaxTokens(kind)).toBe(TASK_KIND_MAX_TOKENS[kind]);
      expect(taskKindCostCents({}, kind)).toBe(TASK_KIND_COST_CENTS[kind]);
      expect(TASK_KIND_COST_CENTS[kind]).toBe(0);
    }
  });

  it('autorise une expérimentation propriétaire de 48k à 120k uniquement pour implement à coût 0', () => {
    for (const value of [48_000, 64_000, 96_000, 120_000]) {
      expect(taskKindMaxTokens('implement', { AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS: String(value) })).toBe(value);
    }
    for (const invalid of ['0', '47999', '120001', '1e5', ' 120000', '024000', 'abc']) {
      expect(taskKindMaxTokens('implement', { AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS: invalid })).toBe(48_000);
    }
    const opted = { AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS: '120000' };
    expect(taskKindMaxTokens('review', opted)).toBe(16_000);
    expect(taskKindMaxTokens('test', opted)).toBe(16_000);
    expect(taskKindMaxTokens('design', opted)).toBe(12_000);
    expect(taskKindMaxTokens('answer', opted)).toBe(8_000);
    expect(taskKindMaxTokens('implement', { ...opted, AGENT_RUN_COST_CENTS_IMPLEMENT: '5' })).toBe(24_000);
    expect(taskKindCostCents(opted, 'implement')).toBe(0);
    expect(TASK_KIND_MAX_TOKENS.implement).toBe(24_000);
  });
});

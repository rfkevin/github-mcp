import { describe, expect, it } from 'vitest';
import { FREE_IMPLEMENT_DEADLINE_S, runDeadlineS } from '../../../src/collab-store/agentrun/run-policy';
import { taskKindCostCents, type PlannedTaskKind } from '../../../src/collab-store/agentrun/plan';

describe('CC8 S7 — deadline implement gratuit, sans ouverture du payant', () => {
  it('donne 45 minutes seulement aux nouveaux runs implement à coût maximal zéro', () => {
    expect(FREE_IMPLEMENT_DEADLINE_S).toBe(2_700);
    expect(runDeadlineS('implement', taskKindCostCents({}, 'implement'))).toBe(2_700);
    expect(runDeadlineS('implement', taskKindCostCents({ AGENT_RUN_COST_CENTS_IMPLEMENT: '0' }, 'implement'))).toBe(2_700);
  });

  it('préserve les plafonds historiques sur paid, autres kinds et appels anciens', () => {
    expect(runDeadlineS('implement', 1)).toBe(900);
    expect(runDeadlineS('implement', taskKindCostCents({ AGENT_RUN_COST_CENTS_IMPLEMENT: '5' }, 'implement'))).toBe(900);
    expect(runDeadlineS('implement')).toBe(900); // compatibilité des consommateurs sans décision de coût
    for (const kind of ['answer', 'design', 'review', 'test'] as PlannedTaskKind[]) {
      expect(runDeadlineS(kind, 0)).toBe(900);
      expect(runDeadlineS(kind, 5)).toBe(900);
    }
    expect(runDeadlineS('kind-inconnu', 0)).toBe(900);
    expect(runDeadlineS(null, 0)).toBe(900);
  });

  it('ne déclenche ni coût payant ni dépassement de limite par paramètre invalide', () => {
    expect(taskKindCostCents({}, 'implement')).toBe(0);
    expect(taskKindCostCents({ AGENT_RUN_COST_CENTS_IMPLEMENT: 'abc' }, 'implement')).toBe(0);
    expect(runDeadlineS('implement', 10)).toBe(900);
  });
});

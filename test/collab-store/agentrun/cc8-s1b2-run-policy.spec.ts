import { describe, expect, it } from 'vitest';
import {
  BREAKER_PAUSE_S, BREAKER_WINDOW_S, clampTimeoutMs, DO_MEMORY_GB, providerTimeoutMs, runDeadlineS,
  STEP_MODEL_BUDGET_FLOOR_MS, stepModelBudgetMs, worstCaseStepGbS,
  breakerAfterFailure, breakerAfterSuccess, breakerSkipping,
} from '../../../src/collab-store/agentrun/run-policy';
import { modelFailureKind } from '../../../src/collab-store/agentrun/model-failure';

describe('CC8 S1b-2 — politique unique de temps (run-policy, plan seq 1376)', () => {
  it('délai fournisseur : gemini durci à 120 s, clamp fournisseur, plafond kind, budget d’étape', () => {
    expect(providerTimeoutMs('gemini')).toBe(120_000);
    expect(providerTimeoutMs('gemini', 200_000)).toBe(120_000);
    expect(providerTimeoutMs('groq')).toBe(30_000);
    expect(providerTimeoutMs('zai')).toBe(90_000);
    expect(providerTimeoutMs('zai', 150_000)).toBe(120_000);
    expect(providerTimeoutMs('fournisseur-inconnu')).toBe(30_000);
    expect(providerTimeoutMs('gemini', undefined, 'review', 45_000)).toBe(45_000);
    expect(providerTimeoutMs('gemini', undefined, 'review', -5)).toBe(1);
    expect(clampTimeoutMs(200_000, 120_000)).toBe(120_000); // façade conservée
  });

  it('budget d’appels modèle d’une étape : 480 s, borné par la deadline et la marge avant plafond', () => {
    expect(stepModelBudgetMs(900_000, 0)).toBe(480_000);
    expect(stepModelBudgetMs(60_000, 0)).toBe(30_000);
    expect(stepModelBudgetMs(40_000, 0)).toBe(10_000);
    expect(stepModelBudgetMs(0, 0)).toBe(1); // deadline dépassée : la garde engine arrête sous 30 s
    expect(STEP_MODEL_BUDGET_FLOOR_MS).toBe(30_000);
  });

  it('deadline par type de tâche : 900 s partout à la fusion (montée S7 après P95)', () => {
    for (const kind of ['answer', 'design', 'implement', 'review', 'test']) expect(runDeadlineS(kind)).toBe(900);
    expect(runDeadlineS('kind-inconnu')).toBe(900);
    expect(runDeadlineS(null)).toBe(900);
  });

  it('coupe-circuit option B : 3 échecs consécutifs dans la fenêtre → pause 30 min, hors fenêtre la série repart', () => {
    const t0 = 2_000_000_000;
    expect(breakerAfterFailure(null, t0)).toEqual({ consecutive: 1, open_until: 0 });
    const row1 = { consecutive_transient_failures: 1, last_failure_at: t0, circuit_open_until: 0 };
    expect(breakerAfterFailure(row1, t0 + 60)).toEqual({ consecutive: 2, open_until: 0 });
    const row2 = { consecutive_transient_failures: 2, last_failure_at: t0 + 60, circuit_open_until: 0 };
    const third = breakerAfterFailure(row2, t0 + 120);
    expect(third.consecutive).toBe(3);
    expect(third.open_until).toBe(t0 + 120 + BREAKER_PAUSE_S);
    // Hors fenêtre (30 min) : la série repart à 1, pas de pause.
    const stale = { consecutive_transient_failures: 2, last_failure_at: t0, circuit_open_until: 0 };
    expect(breakerAfterFailure(stale, t0 + BREAKER_WINDOW_S + 1)).toEqual({ consecutive: 1, open_until: 0 });
    // Pause en cours (ou réessai post-pause) : tout échec ROUVRE la pause — un essai par pause, pas de rafale.
    const tripped = { consecutive_transient_failures: 3, last_failure_at: t0, circuit_open_until: t0 + 1_000 };
    const reopened = breakerAfterFailure(tripped, t0 + 30);
    expect(reopened.consecutive).toBe(4);
    expect(reopened.open_until).toBe(t0 + 30 + BREAKER_PAUSE_S);
    // Succès : série remise à zéro, pause fermée.
    expect(breakerAfterSuccess()).toEqual({ consecutive: 0, open_until: 0 });
    expect(breakerSkipping({ circuit_open_until: t0 + 100 }, t0)).toBe(true);
    expect(breakerSkipping({ circuit_open_until: t0 }, t0)).toBe(false);
    expect(breakerSkipping({ circuit_open_until: t0 - 1 }, t0)).toBe(false);
    expect(breakerSkipping(null, t0)).toBe(false);
  });

  it('GB-s : pire cas de l’étape ENTIÈRE (128 Mo × 600 s) — le 16 statique calibré 125 s est remplacé', () => {
    expect(DO_MEMORY_GB).toBe(0.128);
    expect(worstCaseStepGbS()).toBe(77);
  });

  it('messages : timeout 120000 ms, CIRCUIT_OPEN et budget d’étape restent transitoires', () => {
    expect(modelFailureKind(new Error('Fournisseur sans réponse après 120000 ms.'))).toBe('transient');
    expect(modelFailureKind(new Error('CIRCUIT_OPEN : tous les maillons de brk sont en pause coupe-circuit
      + ' (gemini:gemini-3.8-flash jusqu’à 2000001800) ; reprise au plus tôt à 2000001800 (UTC, secondes).'))).toBe('transient');
    expect(modelFailureKind(new Error('STEP_MODEL_BUDGET_EXHAUSTED : budget d’appels modèle de l’étape épuisé
      + ' (12345 ms restants, plan S1b-2 v2 point 4) ; relance d’exécution S1b.'))).toBe('transient');
    expect(modelFailureKind(new Error('MODEL_ROUTE_REFUSED : mauvaise référence'))).toBe('permanent');
  });
});

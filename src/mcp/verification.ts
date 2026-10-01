import { z } from 'zod';

export const expectedCheckSchema = z.object({
  source: z.enum(['check', 'workflow', 'status']),
  name: z.string().min(1).max(256),
}).strict();
export type ExpectedCheck = z.infer<typeof expectedCheckSchema>;
export type Observation = ExpectedCheck & { status: string; conclusion: string | null };

function outcome(check: Observation): 'passed' | 'pending' | 'failed' | 'unverified' {
  if (['failure', 'error', 'timed_out', 'startup_failure', 'action_required'].includes(check.conclusion ?? '')) return 'failed';
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(check.status)) return 'pending';
  if (check.status === 'completed' && check.conclusion === 'success') return 'passed';
  return 'unverified';
}

/** Évalue uniquement la liste déclarée ; ne prétend pas découvrir les règles GitHub obligatoires. */
export function verificationStatus(observations: Observation[], expected: ExpectedCheck[], incomplete: boolean) {
  const missing = expected.filter(wanted => !observations.some(item => item.source === wanted.source && item.name === wanted.name));
  const relevant = expected.length ? observations.filter(item => expected.some(wanted => item.source === wanted.source && item.name === wanted.name)) : observations;
  const outcomes = relevant.map(outcome);
  let state = 'incomplete';
  if (outcomes.includes('failed')) state = 'failed';
  else if (outcomes.includes('pending')) state = 'pending';
  else if (!incomplete && !missing.length && outcomes.length && outcomes.every(value => value === 'passed')) {
    state = expected.length ? 'declared_checks_passed' : 'observed_success';
  }
  return { state, expectationsDeclared: expected.length > 0, expectedChecks: expected, missing,
    unverified: relevant.filter(item => outcome(item) === 'unverified'),
    nextPollSeconds: state === 'pending' || missing.length ? 15 : null,
    taskComplete: false,
    nextAction: state === 'declared_checks_passed'
      ? 'Confirmer que le SHA testé est toujours le headSha de la PR avant intégration, ou celui du résultat sur integration après fusion ; ne pas confondre ces deux commits. Vérifier la couverture tests/build/qualité et poursuivre la discussion avant le bilan. Seule une intégration distinctement autorisée peut être envisagée, jamais une fusion principale.'
      : state === 'failed' ? 'Lire les diagnostics, corriger dans le périmètre autorisé et recommencer au nouveau SHA.'
        : 'Ne pas annoncer terminé. Attendre les contrôles en cours/manquants ; préciser les attentes ou signaler les sources inaccessibles. Une attente prolongée doit être rapportée comme vérification incomplète.',
    assurance: 'Instantané des contrôles déclarés par le client, pas une preuve de complétude, de règles de branche satisfaites ou de déploiement. Un contrôle ignoré ou annulé ne vaut pas réussite.' };
}

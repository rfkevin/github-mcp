/** Suivi attendu après une écriture : la tâche n'est pas terminée avant les contrôles au SHA exact. */
export function verificationFollowUp(repository: string, sha: string, pullRequestNumber?: number) {
  return { taskComplete: false, reason: 'Vérifications CI/build du dernier commit encore à attester.',
    nextTool: 'github_ci_status', arguments: { repository, ref: sha },
    pullRequestNumber, nextPollSeconds: 15,
    instruction: 'Déclarer expectedChecks depuis les workflows et la mission, attendre leurs résultats, corriger les échecs autorisés. Relire le headSha de la PR avant le bilan final ; une PR créée ne clôt pas la tâche.' };
}

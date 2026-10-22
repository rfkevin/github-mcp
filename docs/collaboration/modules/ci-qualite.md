# CI et qualité

Procédure détaillée. Le contexte principal cite ce module après un échec de contrôle.

## Suivi
- Après chaque commit et après ouverture de PR : `github_ci_status` au SHA exact, avec `expectedChecks` (source et nom exact, par exemple `check` + `ci`).
- Respecter `nextPollSeconds`, espacer les appels inchangés, ne pas relancer un build simplement pour attendre.
- Diagnostics détaillés : `github_get_check_result` puis `github_get_failure_report` (annotations du job en échec).

## Échec d'un contrôle
1. Diagnostiquer via les annotations, corriger uniquement dans le périmètre autorisé.
2. Suivre le nouveau SHA : toute preuve issue d'un ancien commit est périmée.

## États de vérification
`declared_checks_passed` = toutes les attentes déclarées réussies au SHA exact. Un contrôle absent, ignoré, annulé, en attente ou issu d'un ancien commit ne clôt jamais la tâche ; des contrôles réussis ne sont pas une preuve exhaustive de qualité. Avant le bilan final, relire `github_get_pull_request` et vérifier que son headSha est toujours celui testé.

## Limites et attente
Autorisation manquante, limite du client ou attente prolongée : annoncer vérification incomplète avec dépôt, PR, SHA, runIds, liens et prochaine action ; ne pas promettre de surveillance sans mécanisme de reprise réel.

# CC8 — S7 commit-budget preflight

## Incident réel Vibe #7

Run `api-implement-b6a4bbcbd9add61cce713cea9479ef35` : `guided_violation:no_tool_call`, 4 étapes, 11 026 jetons, aucune nouvelle écriture GitHub. Deux `github_commit_files` refusés après une proposition déjà écartée par `guided_precheck`. Le résumé expurgé masque les codes précis des effets `failed`.

Les quatre commits historiques de `S7-live-vibe` sur `mcp/105856986/vibe-api-s7-live` :
- Essai #5 : `61a6dff3`, `9ebfa5ce`.
- Essai #6 : `61b7eda4`, `88c8d9f`.

`github-write/progress.ts:reserveCommit` compte les entrées D1 par `(cycle,task,branch)` et refuse la cinquième écriture (`api_write_correction_limit_or_conflict`) **avant** l'adaptateur GitHub. `github_write_scope` fournit déjà `corrections_remaining = 3 - correctionsUsed`. L'hypothèse de divergence de branche présentée par Vibe est réelle (base antérieure à l'intégration) mais ne suffit pas à expliquer à elle seule ces refus ; le budget historique est un verrou certain.

## Correctif préventif

Le planificateur `planGuidedS7` s'arrête désormais avec `guided_stop:commit_budget_exhausted` lorsque le scope serveur indique `corrections_remaining <= 0` ; cela évite des invocations de modèle et des propositions de commits vouées à l'échec. Le contrôle serveur `reserveCommit` reste inchangé (pas de contournement ni remise à zéro).

Tests purs + D1 : branche préexistante, branche absente, budgets 1/2/3 préservés ; 0 token, 0 commit, 0 CI lorsque budget 0. Aucun changement de modèle, compteur, permissions, wrangler ou `master`.

## Réparation opérationnelle pour le prochain essai

Ce patch ne réactive pas Vibe. Pour réussir un nouvel essai S7 : mandat distinct propriétaire Vibe (ou Gemini si comparaison), branche et fichier de test isolés fondés sur le SHA courant de `cc3-integration`, grant explicite limité à cette tâche et ces chemins, critères de succès identiques, puis un seul run gratuit, CI au SHA, D12 Vibe/Grok selon les rôles et fusion Kevin. Ne jamais purger `api_write_commits` ni réutiliser la branche historique épuisée. Le contrôleur doit enregistrer le `corrections_remaining` initial et vérifier la CI finale avant d'ouvrir une PR.

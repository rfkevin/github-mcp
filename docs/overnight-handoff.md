# Bilan du lot — 30 septembre 2026

## État local

Branche de travail : `codex/agent-workflow-foundation`, issue de `origin/master` au commit `4e8ca6711341b55d7e04c8b4e54d8e2cf7282e8e` (PR 8 fusionnée).

À la rédaction de ce bilan, le lot n’a pas été committé, poussé, fusionné ni déployé par l’assistant. Le propriétaire effectue lui-même le commit et le push. Aucune modification de permissions ou validation distante n’a été effectuée à sa place.

## Réalisé

- Séparation des jetons metadata, contents, checks, statuses et actions ; erreurs structurées sans messages distants bruts.
- Filtrage des chemins sensibles dans les diffs et renommages ; refus des liens symboliques et sous-modules pour les lectures.
- Lecture de blobs immuables, limites de taille, arbres incomplets refusés, réponses JSON bornées et redirections avec jeton refusées.
- Recherche limitée au dépôt demandé, avec contrôle du dépôt dans les résultats.
- Contexte de projet, lectures groupées avec lignes, rapports CI partiels et résumé des contrôles Sonar.
- Contrôles rattachés à un SHA résolu une seule fois ; distinction du contrôleur et de la cible pour les vérifications manuelles.
- Protection applicative des chemins de contrôle CI, de CODEOWNERS et de leurs parents ; garde-fous supplémentaires sur les commits atomiques.
- Workflows ci et agent-checks, lanceur borné, tests du plan et nouveau consentement optionnel pour le dispatch.
- Documentation du fonctionnement, des réglages manuels et de la feuille de route.

## Vérifications déjà effectuées

| Contrôle | Résultat du dernier passage lors de l’implémentation |
| --- | --- |
| TypeScript application et tests | Réussi |
| Tests applicatifs | 149 réussis |
| Tests Node des scripts CI | 14 réussis |
| Compilation Worker `--dry-run` | Réussie, sans publication |
| Syntaxe YAML des deux workflows | Valide |
| Installation vierge sans scripts npm | Réussie ; 143 tests applicatifs + 14 tests de scripts et compilation sur la copie intermédiaire |

La copie vierge précédait les six dernières régressions de transport/écriture, validées ensuite dans le dépôt principal. Ces vérifications sont locales sous Windows avec GitHub simulé ; elles ne prouvent pas encore l’exécution réelle sur GitHub/Linux ou le parcours depuis le téléphone.

## Constat de configuration à revalider

Lors de l’audit précédent, l’installation GitHub ne présentait que `metadata: read`. Demander en une fois les autres permissions expliquait le refus du jeton utilisé par les nouveaux outils. Le code sépare désormais ces demandes, mais n’accorde pas lui-même les droits manquants.

Le dépôt distant inspecté ne présentait alors ni workflow GitHub Actions, ni environnement, ni protection de master. Ce sont des observations de l’audit, pas une affirmation de leur état actuel après d’éventuelles interventions du propriétaire.

## Reprise conseillée

1. Suivre [les réglages GitHub](github-settings.md) pour les lectures, publier la branche et ouvrir une PR.
2. Vérifier la CI distante avant fusion ; tenir compte du déploiement Cloudflare automatique éventuel.
3. Déployer au moment choisi, puis essayer le contexte, la lecture groupée et les diagnostics depuis Claude.
4. Activer run_checks uniquement après revue et consentement explicite, selon [checks.md](checks.md).
5. Poursuivre les outils d’écriture et la séparation staging/production selon [la feuille de route](agent-roadmap.md).

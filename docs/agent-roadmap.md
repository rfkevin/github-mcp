# Architecture retenue et feuille de route

Décision conservée le 30 septembre 2026 : permettre à un agent distant, notamment depuis un téléphone, de comprendre un dépôt, préparer du code, le vérifier et proposer une PR. La publication reste une décision humaine.

## Principes

- Le Worker orchestre GitHub ; aucun shell arbitraire n’est exposé.
- Privilégier les lectures groupées et les diagnostics courts, avec commit exact et limites visibles.
- Séparer les permissions des familles d’outils. Un droit manquant ne doit pas faire tomber toutes les lectures.
- Ne pas donner de nouvelles capacités aux anciens consentements `mcp:read`.
- Tester le code proposé sur un runner éphémère, sans secret de déploiement.
- Ne pas assimiler un résultat absent, incomplet ou ignoré à une réussite.

## Inventaire du lot

| Besoin | État du code |
| --- | --- |
| Dépôts, guides, fichier, dossier, recherche, comparaison, CI | Sept outils historiques conservés et renforcés |
| Contexte initial | `github_get_project_context` : métadonnées, SHA, racine, guides et capacités |
| Lectures groupées | `github_read_files` : dix fichiers/extraits, lignes et versions |
| Diagnostics | `github_get_check_result` et `github_get_failure_report` |
| Résumé Sonar | `github_get_quality_report`, contrôles publiés par les Apps reconnues ; pas d’API Sonar détaillée |
| Lancement de tests | `github_run_checks`, caché par défaut ; configuration et nouveau consentement obligatoires |
| Suivi corrélé | `github_get_agent_check_result`, contrôleur et cible distincts |
| Branches, commits atomiques, PR, commentaires | Services internes présents ; exposition MCP sécurisée à faire |
| Staging et production approuvée | Workflows et environnements à concevoir et configurer |

Les noms `github_*` sont conservés pour les clients existants. Disponibilité dans le code ne signifie pas activation ou déploiement à distance.

## Cycle visé

Contexte → lectures groupées → branche de travail → changement atomique → tests ciblés → diagnostic → relecture du diff → PR → CI complète → validation humaine.

L’étape d’écriture devra avoir son propre scope, des dépôts explicitement autorisés, des branches réservées à l’acteur et un SHA de base attendu. Aucun outil de fusion automatique ou de déploiement production n’est prévu dans le catalogue actuel.

## Optimisations retenues

Un job et une installation par demande ; cache des téléchargements npm ; test d’un fichier possible ; pas de build dans quick ; réutilisation opportuniste des runs identiques ; pas de polling interne prolongé. Les clés de réutilisation incluent la version exacte du code et du contrôleur. Voir [checks.md](checks.md).

Un runner permanent, un cache de résultats persistant ou un verrou distribué ne sont pas ajoutés sans mesure démontrant leur utilité. Les tests ciblés ne remplacent pas la CI complète avant livraison.

## Limites connues et prochaines étapes

1. Valider ce lot sur GitHub et depuis Claude ; revoir les permissions effectives de l’installation.
2. Activer éventuellement les tests à distance, après revue du contrôleur. Son épingle à la pointe de master nécessite actuellement une mise à jour après chaque changement de master.
3. Exposer les écritures avec leurs autorisations propres ; ne pas simplement enregistrer tous les services internes comme outils MCP.
4. Ajouter lint, E2E navigateur et Sonar détaillé si retenus. Ne pas injecter un jeton Sonar dans du code de PR non fiable.
5. Préparer staging isolé et production réellement soumise à validation humaine. L’autodéploiement Cloudflare doit être traité pour ne pas contourner la future approbation GitHub.

La recherche GitHub utilise l’index de la branche par défaut, potentiellement en retard ; elle ne recherche pas instantanément une branche de travail par SHA. Le masquage des diagnostics reconnaît certains formats de secrets, pas tous. Les comptes autorisés utilisent la même installation : l’isolation multi-utilisateurs par dépôt reste à concevoir.

Les refus de chemins dans le MCP sont des protections applicatives, pas des règles de branche GitHub déjà actives. Voir [github-settings.md](github-settings.md).

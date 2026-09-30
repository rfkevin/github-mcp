# Architecture retenue et feuille de route

Décision conservée le 30 septembre 2026 : permettre à un agent distant, notamment depuis un téléphone, de comprendre un dépôt, préparer du code, le vérifier et proposer une PR. La publication reste une décision humaine.

## Priorité actuelle — décision du propriétaire

Le propriétaire a autorisé le mode commun à tous les dépôts : choisir le dépôt et la branche de départ, laisser l’agent préparer une branche de travail et les vérifications adaptées, puis proposer une PR. Le code et le consentement `mcp:automation` sont intégrés. La publication, l’acceptation des permissions GitHub et le premier essai distant restent à effectuer avec le propriétaire. Voir [multi-repository.md](multi-repository.md).

La sélection de l’installation GitHub définit les dépôts accessibles ; le nouveau mode ne possède pas de deuxième liste ni d’épingle de SHA à mettre à jour dans le MCP. Le workflow est encadré par le serveur, tandis que `.mcp/checks.json` contient les commandes propres au projet. Les écritures restent sur les branches de travail liées à l’identité ; la branche choisie sert de base et de cible de PR.

À la demande du propriétaire, les outils de préparation de changements sont maintenant implémentés : création d’une branche de travail, commits atomiques, puis ouverture d’une PR en brouillon. Ils restent cachés sans activation serveur et consentement d’écriture distinct. Aucun réglage distant n’a été modifié. La prochaine validation sera l’essai réel de ces outils après revue des permissions et automatismes du dépôt, avec le propriétaire. Aucun outil de fusion ou de déploiement direct n’est ajouté. Le propriétaire garde la main sur le commit et le push du MCP lui-même tant qu’il n’autorise pas autre chose.

## Principes

- Le Worker orchestre GitHub ; les commandes du projet s’exécutent uniquement sur le runner de vérification, avec consentement spécifique.
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
| Préparation multi-dépôts | `github_prepare_checks` : aperçu ou commit atomique du workflow canonique et du plan de projet |
| Suivi corrélé | `github_get_agent_check_result`, contrôleur et cible distincts |
| Branches, commits atomiques et PR | Outils optionnels implémentés, consentement `mcp:write` et activation serveur obligatoires ; PR en brouillon |
| Suivi des PR | Deux outils de lecture pour retrouver une PR, son SHA et sa discussion bornée |
| Commentaires | `github_comment_pull_request`, limité aux PR ouvertes de sa propre branche, sans approbation |
| Staging et production approuvée | Workflows et contrôles locaux implémentés ; environnements et ressources distants à configurer |

Les noms `github_*` sont conservés pour les clients existants. Disponibilité dans le code ne signifie pas activation ou déploiement à distance.

## Cycle visé

Contexte → lectures groupées → branche de travail → changement atomique → tests ciblés → diagnostic → relecture du diff → PR → CI complète → validation humaine.

L’étape d’écriture possède son propre scope, utilise les dépôts sélectionnés dans l’installation GitHub, réserve les branches à l’acteur et exige les SHA attendus. Aucun outil de fusion automatique ou de déploiement production n’est prévu dans le catalogue actuel. Les commits et PR peuvent déclencher les automatismes du dépôt ; voir [writes.md](writes.md).

## Optimisations retenues

Un job et une installation par demande ; choix du profil et cible facultative ; réutilisation opportuniste des runs identiques ; pas de polling interne prolongé. Le mode multi-dépôts annule le quick ancien lorsqu’un nouveau push arrive sur la même branche ; il utilise une clé liée au SHA, au profil, à la cible et au workflow canonique. Il ne fournit pas de cache partagé. Le mode historique conserve son cache npm et son contrôleur épinglé. Voir [multi-repository.md](multi-repository.md) et [checks.md](checks.md).

Un runner permanent, un cache de résultats persistant ou un verrou distribué ne sont pas ajoutés sans mesure démontrant leur utilité. Les tests ciblés ne remplacent pas la CI complète avant livraison.

## Limites connues et prochaines étapes

1. Valider ce lot sur GitHub et depuis Claude ; revoir les permissions effectives de l’installation.
2. Activer et essayer le mode multi-dépôts sur un nouveau projet. Le premier quick peut démarrer au push avant fusion ; le lancement manuel exige le workflow sur la branche par défaut. L’ancien mode épinglé reste compatible mais n’est plus le parcours recommandé pour plusieurs projets.
3. Valider les quatre outils d’écriture depuis le client après activation explicite ; ne pas exposer les autres services internes sans nouvelle revue.
4. Ajouter lint, E2E navigateur et Sonar détaillé si retenus. Ne pas injecter un jeton Sonar dans du code de PR non fiable.
5. Configurer et éprouver la chaîne staging/production décrite dans [deployments.md](deployments.md). Elle réutilise le paquet compilé par la CI ; les ressources distantes et la migration de l’autodéploiement Cloudflare restent à effectuer.

La recherche GitHub utilise l’index de la branche par défaut, potentiellement en retard ; elle ne recherche pas instantanément une branche de travail par SHA. Le masquage des diagnostics reconnaît certains formats de secrets, pas tous. Les comptes autorisés utilisent la même installation : l’isolation multi-utilisateurs par dépôt reste à concevoir.

Les refus de chemins dans le MCP sont des protections applicatives, pas des règles de branche GitHub déjà actives. Voir [github-settings.md](github-settings.md).

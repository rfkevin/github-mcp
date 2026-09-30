# Vérifications et lancement optionnel par le MCP

## Commandes locales

| Commande | Contenu |
| --- | --- |
| `npm run typecheck` | TypeScript application et tests |
| `npm run test:unit` | Tests Vitest dans Workers simulé |
| `npm run test:ci-scripts` | Tests Node du plan de vérification |
| `npm run check:quick` | Types + tests applicatifs + tests du plan |
| `npm run check:full` | Quick + compilation Wrangler sans publication |

Pour un fichier ciblé sous PowerShell, depuis la racine :

```powershell
$env:CHECK_TARGET = 'test/oauth.spec.ts'
try { node scripts/ci/run-checks.mjs unit }
finally { Remove-Item Env:CHECK_TARGET -ErrorAction SilentlyContinue }
```

Seuls `quick`, `typecheck`, `unit` et `full` sont disponibles. `target` est réservé à `unit`. Lint et E2E navigateur ne sont pas configurés et ne sont pas prétendus réussis.

## Fonctionnement des workflows

`ci.yml` s’exécute sur PR et push sur master. Son job reste présent pour la documentation seule, mais peut éviter l’installation et les tests de code. Le filtre autorise seulement README, AGENTS, LICENSE et les Markdown sous docs ; en cas d’incertitude, les contrôles complets s’exécutent.

`agent-checks.yml` s’exécute manuellement sur la branche par défaut. Deux checkouts séparent le contrôleur et la cible. Les paramètres sont validés avant le checkout cible, puis le SHA chargé est vérifié. Un seul job installe les dépendances et exécute le périmètre demandé.

Les actions sont épinglées par SHA, Node est fixé à 24.19.0 et le jeton du job reste en lecture seule. Aucun secret de déploiement n’est injecté ; les identifiants Git ne sont pas persistés dans les checkouts. `npm ci --ignore-scripts` évite les scripts d’installation, mais les tests et leur configuration exécutent bien le code cible : ils ne doivent jamais recevoir de secret.

Le cache npm conserve les téléchargements, pas une installation commune à tous les jobs. Les performances réelles sur GitHub restent à mesurer.

## Activer le lancement MCP

Prérequis : [permissions, publication et protections GitHub](github-settings.md), puis validation réelle du workflow.

1. Choisir le SHA complet du commit **revu et présent à la pointe de master**, incluant le workflow et ses scripts. Ce n’est pas le SHA d’un futur commit non publié.
2. Ajouter au Worker la variable non secrète `GITHUB_CHECKS_CONFIG`. C’est un tableau JSON d’objets contenant `repository`, `ref` et `controllerSha`. Pour ce dépôt : repository = `rfkevin/github-mcp`, ref = `master`, controllerSha = le SHA réel choisi. Au plus dix dépôts, un contrôleur par dépôt.
3. Conserver cette valeur dans la configuration de déploiement, pas seulement dans un réglage de tableau de bord susceptible d’être remplacé au déploiement. Si Wrangler est modifié, exécuter `npm run cf-typegen`. Garder les préversions désactivées ou configurées pour une installation de test séparée.
4. Redéployer la configuration au moment choisi, puis refaire le consentement du client en demandant `mcp:read mcp:checks offline_access`. Vérifier que l’écran mentionne explicitement le lancement de tests et les minutes GitHub Actions. Si le client ne demande pas `mcp:checks`, l’outil restera absent ; une simple reconnexion ne garantit pas l’attribution de ce scope.
5. Appeler `github_run_checks` avec `repository`, `sha` (code à tester), `scope` et éventuellement `target`. Puis appeler `github_get_agent_check_result` avec les mêmes paramètres et le `runId` reçu.

La variable est volontairement absente de la configuration actuelle. Absence, chaîne vide ou tableau vide = outils cachés. Une configuration mal formée produit un refus de configuration du serveur ; corriger ou retirer la variable. Supprimer la configuration désactive les outils même pour les anciens jetons déjà consentis.

**Limite actuelle :** tout changement de la pointe de master invalide l’épingle `controllerSha`, même si le workflow n’a pas changé. Une revue et une mise à jour explicite sont nécessaires avant de nouveaux lancements. La prise en charge d’une référence de version protégée est une amélioration future, pas une fonctionnalité déjà disponible.

## Interpréter les résultats

- `targetSha` : code demandé ; `controllerSha` : version du contrôleur.
- `reused: true` : réutilisation d’un run identique visible, sans nouveau lancement.
- La clé inclut dépôt, cible, scope, fichier ciblé, contrôleur, version Node et version du plan. La recherche porte sur les 100 derniers runs filtrés.
- Une réussite réutilisée exige aussi le job et l’étape de tests réussis. Un job ignoré n’est pas une validation. Une exécution identique plus récente en échec empêche de reprendre une ancienne réussite.
- `verifiedSuccess: true` vérifie cette provenance et ces états GitHub ; cela ne prouve pas la pertinence ou l’exhaustivité des tests du projet.
- `DISPATCH_RESULT_UNKNOWN` : GitHub a peut-être lancé le workflow malgré une réponse perdue. Vérifier Actions avant de relancer.
- `CONTROLLER_CHANGED` : revue administrateur nécessaire ; aucun lancement effectué.
- Déduplication `best_effort` : des appels simultanés peuvent encore créer des doublons, faute de verrou distribué. Aucun cache KV de réussites n’est utilisé.
- Pas d’attente prolongée dans le Worker : retour du runId, puis interrogation espacée (15 secondes conseillées tant que le run n’est pas terminé).

Pour un workflow manuel, le `head_sha` GitHub décrit le contrôleur, pas forcément le code testé. Utiliser le lecteur corrélé pour `run_checks`. `github_get_check_result` est un lecteur général de runs et ne vérifie pas la cible ; `github_ci_status` exclut les runs agent-checks de sa liste de workflows ordinaires. Les check runs restent les associations publiées par GitHub, pas une preuve du checkout effectué.

Références : [dispatch GitHub, API 2026-03-10](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event), [cache setup-node](https://github.com/actions/setup-node).

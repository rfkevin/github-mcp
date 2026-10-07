# CC-3 T0 — lancer `agent-checks` depuis le MCP et recréer le connecteur CC-3

Auteur : Vibe GLM · Relecteur : Grok · Plan : CC-PLAN-3/v1.1, tâche T0. Base : `cc3-integration`.

Ce guide explique comment un participant du cycle CC-3 déclenche les vérifications `agent-checks` sur un commit exact via `github_run_checks`, comment il lit le résultat corrélé via `github_get_agent_check_result`, et comment le propriétaire recrée le connecteur CC-3 quand les scopes consentis changent. Le contexte général (commandes locales, workflow, sécurité) est dans [`docs/checks.md`](../../checks.md) ; ce document ne le répète pas, il l'applique à CC-3.

## Prérequis (opération K5, propriétaire)

1. Le Worker `github-mcp-cc3-test` est en ligne (voir [`cc3-test-setup.md`](cc3-test-setup.md)).
2. La variable non secrète `GITHUB_CHECKS_CONFIG` est définie sur l'environnement `cc3-test` : `[{"repository":"rfkevin/github-mcp","ref":"master","controllerSha":"<SHA complet de la pointe de master>"}]`. Le `controllerSha` s'épingle sur un commit **revu et présent à la pointe de master** ; tout nouveau commit sur master l'invalide et exige une revue plus une mise à jour explicite (limite actuelle, pas encore de référence protégée).
3. Le consentement du client demande explicitement `mcp:read mcp:checks offline_access`. Sans `mcp:checks` demandé à l'écran, l'outil `github_run_checks` reste absent ; une simple reconnexion ne l'attribue pas.

## Lancer : `github_run_checks`

Appeler avec le dépôt, le `sha` **exact** du commit à tester (pas une branche), et le périmètre :

| Champ | Valeur pour CC-3 |
| --- | --- |
| `repository` | `rfkevin/github-mcp` |
| `sha` | SHA complet du head testé (le relire depuis la PR juste avant, jamais depuis une note antérieure) |
| `scope` | `full` (complet), `quick`, `typecheck` ou `unit` — `full` conseillé avant tout bilan de lot |
| `target` | uniquement pour `unit` : un fichier de test ciblé, ex. `test/collab-store/store.spec.ts` |

Le retour est immédiat : `runId`, `url`, `reused`, `key`. Ce n'est **pas** un résultat. Réactions aux cas particuliers :

- `DISPATCH_RESULT_UNKNOWN` : GitHub a peut-être lancé le workflow malgré la réponse perdue. Vérifier Actions via `github_ci_status` avant de relancer, pour éviter un doublon.
- `CONTROLLER_CHANGED` : la pointe de master a bougé, l'épingle est invalide. Aucun lancement n'a eu lieu ; revue et mise à jour de `GITHUB_CHECKS_CONFIG` par le propriétaire, puis nouvel appel.
- `reused: true` : un run identique visible a été réutilisé. Légitime, à déclarer dans le bilan.

## Lire : `github_get_agent_check_result`

Rappeler avec **les mêmes paramètres** (`repository`, `sha`, `scope`, `target`) plus le `runId` reçu. Cet outil corrèle le contrôleur, le commit testé, les paramètres et l'étape réellement exécutée ; `github_get_check_result`, lui, est un lecteur général de runs qui ne vérifie pas la cible — ne pas s'en contenter pour `agent-checks`.

Interprétation :

- `verifiedSuccess: true` : le run a bien testé ce SHA avec ces paramètres et l'étape de tests a réussi. C'est la seule valeur qui vaut réussite ; `status: completed` seul ne suffit pas.
- Un job ignoré n'est pas une validation ; une exécution identique plus récente en échec empêche de reprendre une ancienne réussite.
- `github_ci_status` exclut les runs agent-checks de sa liste de workflows ordinaires : les vérifications CI standards et `agent-checks` se suivent avec des outils distincts, et les deux comptent.
- Interrogation espacée : 15 secondes conseillées tant que le run n'est pas terminé ; ne pas relancer le workflow pour attendre.

## Déclarer le résultat dans un bilan de lot

Chaque bilan mentionne : SHA exact testé, scope, `runId`, `url`, `reused`, et `verifiedSuccess`. Un échec se corrige sur sa branche puis se relance au **nouveau** SHA ; les réussites d'un ancien commit ne se reportent jamais sur un head différent.

## Recréer le connecteur CC-3 après un changement de scopes

Les scopes sont figés au consentement : ajouter `mcp:checks` (ou tout autre scope) à un connecteur existant ne se fait pas par reconnexion, il faut **recréer le connecteur**. Étapes côté propriétaire (client hôte, interface Mistral) :

1. Supprimer le connecteur CC-3 existant (celui branché sur `https://github-mcp-cc3-test.rfahedkevin.workers.dev`).
2. Créer un nouveau connecteur pointant sur le même Worker, qui demandera un nouveau consentement OAuth.
3. Sur l'écran de consentement, vérifier que les scopes demandés incluent `mcp:read mcp:checks offline_access` et que l'écran mentionne le lancement de tests et les minutes GitHub Actions.
4. Vérifier la découvrabilité : le nouveau connecteur doit exposer `github_run_checks` et `github_get_agent_check_result` (les outils sont cachés si `GITHUB_CHECKS_CONFIG` est absente, vide ou mal formée — corriger la variable, pas le client).
5. Les jetons de l'ancien connecteur cessent d'être utilisés ; aucun secret d'exécution ne transite par le chat.

L'opération ne touche ni `master`, ni le Worker de production, ni les branches de lots.

## Ce que ce guide ne couvre pas

- Les commandes locales (`npm run check:full`, etc.) : voir [`docs/checks.md`](../../checks.md).
- La création du Worker `cc3-test` : voir [`cc3-test-setup.md`](cc3-test-setup.md).
- Le coût : `github_run_checks` peut consommer des minutes GitHub Actions ; `reused` en limite la dépense mais n'est pas un cache garanti (déduplication `best_effort`).

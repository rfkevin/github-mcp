# Configuration du serveur

Le Worker expose `/mcp` derrière OAuth 2.1 et `/health` comme contrôle de disponibilité. Le seul outil actuellement enregistré est `github_list_repositories`. Il utilise les dépôts sélectionnés dans l'installation GitHub App, avec un jeton limité aux métadonnées en lecture. Les autres services de la bibliothèque ne sont pas encore exposés.

La connexion utilisateur passe par GitHub et un consentement propre au client MCP. Seuls les identifiants numériques GitHub configurés sont autorisés. Tous ces utilisateurs accèdent à la même installation : ce n'est pas encore un système multi-utilisateurs avec permissions différentes par dépôt. La liste est revérifiée à chaque requête MCP, y compris pour les jetons déjà émis.

## Paramètres

Les valeurs non secrètes de `wrangler.jsonc` sont volontairement vides. Sans configuration complète, le serveur répond 503 et ne fournit aucun outil privé.

| Paramètre | Valeur |
| --- | --- |
| `PUBLIC_ORIGIN` | Origine HTTPS finale du Worker, sans chemin, par exemple `https://github-mcp.example.com` |
| `ALLOWED_GITHUB_USER_IDS` | Identifiants numériques GitHub autorisés, séparés par des virgules ; aucun accès si vide |
| `GITHUB_APP_ID` | Identifiant de la GitHub App donnant accès aux dépôts |
| `GITHUB_INSTALLATION_ID` | Identifiant de son installation sur les dépôts sélectionnés |
| `GITHUB_OAUTH_CLIENT_ID` | Client ID de l'application utilisée pour la connexion utilisateur |
| `GITHUB_PRIVATE_KEY` | Secret : clé privée de la GitHub App, au format PKCS#8 |
| `GITHUB_OAUTH_CLIENT_SECRET` | Secret : client secret de l'application de connexion |

Ne pas mettre les secrets dans `wrangler.jsonc`, Git, les journaux ou une conversation. En développement, utiliser `.dev.vars`, ignoré par Git ; en production, les secrets Cloudflare. Le callback GitHub est exactement `PUBLIC_ORIGIN` suivi de `/callback`.

L'authentification utilisateur n'accorde pas les permissions de dépôt : celles-ci viennent de la GitHub App. Une OAuth App GitHub sans scope de dépôt peut servir à la connexion. Le même parcours peut utiliser les identifiants OAuth d'une GitHub App compatible, à vérifier lors du raccordement réel.

`OAUTH_KV` est déclaré pour les tests et le développement local. Avant déploiement, créer/associer le namespace Cloudflare voulu et vérifier son identifiant dans la configuration. Aucune ressource distante n'a été créée par cette intégration.

## Vérifications

`npm test -- --run` teste le parcours OAuth local, les refus d'accès et les outils avec GitHub simulé. `npx tsc --noEmit` et `npx tsc --noEmit -p test/tsconfig.json` contrôlent le typage. Exécuter `npm run cf-typegen` après modification des bindings.

Les tests locaux ne prouvent pas la connexion réelle depuis Claude ou un autre client. Cette validation exige la configuration GitHub/Cloudflare et une URL HTTPS accessible. Le mode de compatibilité MCP historique conserve la valeur par défaut du SDK ; la compatibilité universelle n'est pas garantie.

Les événements applicatifs d'audit enregistrent seulement l'identifiant utilisateur, le service, l'action et le résultat. Aucun token ou contenu de fichier n'y est inscrit. Contrôler également la collecte des URL des callbacks par les couches de journalisation de la plateforme avant la mise en production.

Références : [handler MCP Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [autorisation MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).

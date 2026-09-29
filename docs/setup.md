# Configuration du serveur

Le Worker expose `/mcp` derrière OAuth 2.1 et `/health` comme contrôle de disponibilité. Le seul outil actuellement enregistré est `github_list_repositories`. Il utilise les dépôts sélectionnés dans l'installation GitHub App, avec un jeton limité aux métadonnées en lecture. Les autres services de la bibliothèque ne sont pas encore exposés.

La connexion utilisateur passe par GitHub et un consentement propre au client MCP. Seuls les identifiants numériques GitHub configurés sont autorisés. Tous ces utilisateurs accèdent à la même installation : ce n'est pas encore un système multi-utilisateurs avec permissions différentes par dépôt. La liste est revérifiée à chaque requête MCP, y compris pour les jetons déjà émis.

## Paramètres

Les valeurs non secrètes de production sont renseignées dans `wrangler.jsonc`. Sans configuration complète, le serveur répond 503 et ne fournit aucun outil privé.

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

`OAUTH_KV` pointe en production vers `github-mcp-oauth-kv`. Le bloc `previews` utilise un namespace distinct, `github-mcp-oauth-preview-kv`, partagé entre les préversions mais jamais avec la production.

## Déploiements de branches

La branche de production est `master` et sa commande est `npx wrangler deploy`. Les autres branches utilisent `npx wrangler preview`, qui exige le bloc `previews` même lorsque la compilation de production réussit.

Les préversions ne reçoivent pas les secrets de production. Leurs variables OAuth sont intentionnellement vides : `/health` répond 200, tandis que `/mcp` et les routes OAuth répondent 503. Cela permet de vérifier la publication sans ouvrir l'accès aux dépôts. Ce n'est pas une validation du parcours OAuth réel.

Pour tester OAuth dans une préversion, configurer une origine HTTPS de test, un callback GitHub correspondant, les identifiants d'une application de test et ses secrets via les paramètres de préversion Cloudflare. Ne pas copier le namespace ni les secrets de production. Les tests locaux utilisent des identifiants simulés et un stockage local.

## Diagnostic des échecs

Un échec du parcours de connexion produit une seule ligne JSON, sans secret :

| Champ | Contenu |
| --- | --- |
| `event` | toujours `oauth_flow_failure` |
| `phase` | étape atteinte, par exemple `authorize.approve_consent` ou `callback.github_user_lookup` |
| `reason` | motif classé, par exemple `github_token_redirect_rejected` ou `consent_transaction_expired_or_used` |
| `httpStatus` | statut renvoyé par GitHub, présent seulement lorsqu'une réponse a été reçue |
| `fetchFailure.kind` | `timeout`, `aborted`, `redirect_rejected`, `fetch_type_error` ou `other` |
| `fetchFailure.code` | code réseau d'une liste blanche, par exemple `ECONNRESET` |
| `fetchFailure.redirectTarget` | classe de destination d'une redirection : `github_token_endpoint`, `github_other_path`, `github_api_user_endpoint`, `github_api_other_path`, `external_origin` ou `unavailable` |

Aucun de ces champs ne contient l'en-tête `Location`, une query string portant un code, un jeton ou un corps de réponse. `fetchFailure.redirectTarget` ne décrit qu'une classe : `external_origin` ou `github_api_other_path` signale un intermédiaire ou un chemin inattendu à investiguer, alors que `github_api_user_endpoint` correspond à la canonicalisation du point d'entrée `/user`, désormais suivie une seule fois.

Le message renvoyé au client reste court et catégorisé : GitHub injoignable, redirection refusée par sécurité, connexion expirée ou refusée, callback mal configuré, identifiants serveur invalides. Il ne contient ni identifiant, ni URL, ni code secret ; le détail exploitable reste dans le journal. Toutes ces réponses, y compris `/health`, sont marquées `Cache-Control: no-store`.

Le journal d'audit de l'outil `github_list_repositories` ajoute un champ `reason` en cas d'échec : `rate_limited`, `github_api_<statut>`, `github_api_unreachable`, `policy_<code>`, `conflict` ou `unexpected_error`. Le message d'erreur d'origine n'y est jamais recopié.

## Vérifications

`npm test -- --run` teste le parcours OAuth local, les refus d'accès et les outils avec GitHub simulé. `npx tsc --noEmit` et `npx tsc --noEmit -p test/tsconfig.json` contrôlent le typage. Exécuter `npm run cf-typegen` après modification des bindings.

Les tests locaux ne prouvent pas la connexion réelle depuis Claude ou un autre client. Cette validation exige la configuration GitHub/Cloudflare et une URL HTTPS accessible. Le mode de compatibilité MCP historique conserve la valeur par défaut du SDK ; la compatibilité universelle n'est pas garantie.

Les événements applicatifs d'audit enregistrent seulement l'identifiant utilisateur, le service, l'action et le résultat. Aucun token ou contenu de fichier n'y est inscrit. Contrôler également la collecte des URL des callbacks par les couches de journalisation de la plateforme avant la mise en production.

Références : [handler MCP Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [autorisation MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).

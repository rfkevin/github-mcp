# Configuration du serveur

Le Worker expose `/mcp` derrière OAuth 2.1. `/health` confirme que le processus répond ; `/ready` exige la configuration et renvoie le SHA du paquet publié. Aucune de ces sondes ne prouve que les permissions GitHub ou une connexion utilisateur fonctionnent. Les sept outils historiques sont conservés : `github_list_repositories`, `github_get_project_guide`, `github_read_file`, `github_list_directory`, `github_search_code`, `github_compare_refs` et `github_ci_status`. S’y ajoutent `github_get_project_context`, `github_read_files`, `github_get_check_result`, `github_get_failure_report`, `github_get_quality_report`, `github_list_pull_requests` et `github_get_pull_request`.

Les lectures utilisent sept familles de jetons minimaux : metadata, contents, checks, statuses, actions, pull_requests et issues. Une permission manquante ne bloque pas toutes les familles. Issues: Read est demandé uniquement pour `github_list_issues`, `github_get_issue`, `github_get_issue_comment`, `github_list_discussion_items` et `github_get_discussion_delta`, indépendamment des PR. Accepter la mise à jour des permissions dans l’installation GitHub App avant l’essai réel. Les clients de lecture conservent `policy.readOnly`. La résolution d’une branche en SHA nécessite contents:read ; les sources CI deviennent indépendantes une fois ce SHA obtenu.

Le mode multi-dépôts ajoute `github_prepare_checks`, `github_run_checks` et `github_get_agent_check_result` avec `GITHUB_AUTOMATION_ENABLED=true` ET consentement `mcp:automation`. Préparer un commit exige aussi les droits d’écriture. La sélection GitHub définit les dépôts, sans configuration par dépôt dans le MCP. Voir [multi-repository.md](multi-repository.md). Le mode historique `GITHUB_CHECKS_CONFIG` / `mcp:checks` conserve ses deux outils pour compatibilité ; le mode multi-dépôts prend priorité si les deux sont autorisés.

Le catalogue comprend dix-neuf outils de lecture. Douze outils optionnels, `github_create_branch`, `github_commit_changes`, `github_apply_changes`, `github_replace_text`, `github_restore_file`, `github_append_file`, `github_create_issue`, `github_resolve_conflicts`, `github_open_pull_request`, `github_comment_pull_request` et `github_comment_commit`, nécessitent le réglage texte `GITHUB_WRITES_ENABLED=true` ET le consentement `mcp:write`. Absence, chaîne vide ou `false` les désactivent ; une autre valeur refuse la configuration. Les anciens consentements de lecture ne gagnent pas ces écritures. Les branches appartiennent à l’utilisateur authentifié, pas à un modèle certifié, et les dépôts proviennent de la sélection de l’installation. Voir [writes.md](writes.md).

`github_create_issue` demande un jeton indépendant Issues: Write ; son refus ne
bloque pas les fichiers, PR ou lectures d’issues. Accepter cette permission dans
l’installation avant l’essai réel ; le code n’accorde aucun droit GitHub. Le
contexte indique `issueWritesEnabled` et `requiredPermissions.issueWrites` quand
l’outil est exposé, sans prétendre que l’App possède effectivement ces droits.

`github_list_issues` renvoie une page GitHub filtrée des PR, sans les corps : suivre `nextPage` même si la page d’issues est vide. `potentiallyTruncated` reste vrai à la borne de 100 pages. `github_get_issue` refuse un numéro de PR, borne le corps à 12 000 octets et chaque commentaire à 2 000 octets après masquage des formats connus. Un corps plus long se lit sans perte en passant `bodyOffset=0`, puis `bodyOffset=bodyNextOffset` avec `bodyRevision`, jusqu’à `bodyNextOffset=null` (même contrat que la lecture ciblée ci-dessous ; l’extrait par défaut n’est pas une page). Il expose les commentaires par pages de 20 et signale les extraits tronqués. `github_get_issue_comment` lit un commentaire général d’issue ou de PR par ID. `github_get_discussion_item` étend la même lecture ciblée aux reviews de PR, commentaires inline de review et commentaires de commit ; une review exige aussi son numéro de PR, tandis que les éléments associés à un chemin sensible sont refusés. Dans les deux lecteurs, le contenu complet est masqué avant découpe, les pages respectent les frontières UTF-8 et les continuations exigent la révision opaque renvoyée par la première page afin de refuser un mélange de versions. `github_list_discussion_items` publie actuellement la carte compacte des commentaires généraux issue/PR sans corps ; son extension aux autres familles reste distincte de la lecture ciblée. Pour retrouver le code et ses tests : [code-map.md](code-map.md).

L’outil `github_merge_integration` exige en plus `mcp:integration` et une politique `.mcp/integration.json` validée sur la branche principale du dépôt. Aucune fusion vers la branche principale, approbation GitHub, fermeture de PR ou publication directe n’est exposée. Les automatisations existantes peuvent néanmoins partir sur commit/PR/fusion. Le protocole commun et la configuration sont dans [team-workflow.md](team-workflow.md).

Les chemins sensibles (`.env`, `.dev.vars`, `.npmrc`, clés privées, certificats…) sont refusés en lecture et masqués dans les listes, recherches et différences, y compris les renommages. Les lectures parcourent les arbres Git puis lisent le blob immuable, sans suivre les liens symboliques. Un fichier de plus de 1 000 000 octets est refusé avant téléchargement de son blob. Cette protection par nom ne détecte pas tous les secrets éventuellement présents dans un fichier ordinaire.

La lecture historique est limitée à 80 000 octets de contenu ; les guides historiques à 16 000 octets chacun. La lecture groupée partage 60 000 octets entre au plus dix fichiers, avec au plus 400 lignes par extrait et une concurrence de trois lectures. Le contexte comprend au plus 100 entrées racine et cinq documents limités à 12 000 octets chacun, dont le plan du projet. Un diff dépassant 120 000 octets perd ses patchs (`patchesOmitted`). Le JSON logique de toute réponse d’outil est borné à 160 000 octets ; l’enveloppe MCP ajoute notamment ses représentations texte et structurée.

Les erreurs GitHub ne sont pas recopiées vers le client : message catégorisé, code et indicateur `retryable` sont renvoyés dans `structuredContent.error`. Les annotations sont bornées et certains formats de secrets connus sont masqués, sans garantie de détection universelle. Aucun outil de téléchargement de logs bruts n’est exposé.

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
| `GITHUB_CHECKS_CONFIG` | Optionnel, JSON non secret des dépôts, refs et SHA de contrôleur autorisés ; absent par défaut. Voir [checks.md](checks.md) |
| `GITHUB_WRITES_ENABLED` | Optionnel, `true` active les outils pour les consentements `mcp:write` ; sinon désactivé |
| `GITHUB_AUTOMATION_ENABLED` | `false` par défaut ; `true` active les vérifications multi-dépôts pour les consentements `mcp:automation` |
| `BUILD_SHA` | SHA du paquet, renseigné par la chaîne de publication ; facultatif pour les anciens déploiements |

Ne pas mettre les secrets dans `wrangler.jsonc`, Git, les journaux ou une conversation. En développement, utiliser `.dev.vars`, ignoré par Git ; en production, les secrets Cloudflare. Le callback GitHub est exactement `PUBLIC_ORIGIN` suivi de `/callback`.

L'authentification utilisateur n'accorde pas les permissions de dépôt : celles-ci viennent de la GitHub App. Une OAuth App GitHub sans scope de dépôt peut servir à la connexion. Le même parcours peut utiliser les identifiants OAuth d'une GitHub App compatible, à vérifier lors du raccordement réel.

`OAUTH_KV` pointe en production vers `github-mcp-oauth-kv`. Le bloc `previews` utilise un namespace distinct, `github-mcp-oauth-preview-kv`, partagé entre les préversions mais jamais avec la production.

## Déploiements de branches

La nouvelle chaîne staging/production et sa migration sont décrites dans [deployments.md](deployments.md). Les réglages ci-dessous décrivent l’intégration Cloudflare existante, à désactiver pour la production lorsque la nouvelle chaîne est configurée. Le fichier `wrangler.jsonc` est conservé en JSON strict afin que le script de publication puisse lire ses valeurs sans dépendance supplémentaire.

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

Les journaux d’audit des outils ajoutent un champ `reason` en cas d’échec : `rate_limited`, `github_api_<statut>`, `github_api_unreachable`, `policy_<code>`, `conflict`, `invalid_request` ou `unexpected_error`. Le message d’erreur d’origine n’y est jamais recopié. Un rapport partiel peut être une opération réussie avec des sources indisponibles : examiner aussi `partial`, `unavailable` et les erreurs par élément dans la réponse.

## Vérifications

`npm run check:quick` vérifie les types, le parcours OAuth, les outils avec GitHub simulé et le plan CI. `npm run check:full` ajoute la compilation Wrangler sans publication. Exécuter `npm run cf-typegen` après modification des bindings. Les scripts et workflows sont décrits dans [checks.md](checks.md).

Les tests locaux ne prouvent pas la connexion réelle depuis Claude ou un autre client. Cette validation exige la configuration GitHub/Cloudflare et une URL HTTPS accessible. Le mode de compatibilité MCP historique conserve la valeur par défaut du SDK ; la compatibilité universelle n'est pas garantie.

Les événements applicatifs d'audit enregistrent seulement l'identifiant utilisateur, le service, l'action et le résultat. Aucun token ou contenu de fichier n'y est inscrit. Contrôler également la collecte des URL des callbacks par les couches de journalisation de la plateforme avant la mise en production.

Références : [handler MCP Cloudflare](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [autorisation MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/).

Le diagnostic de conflits utilise Contents: Read. Sa résolution exige Contents: Write et mcp:write ; aucune permission supplémentaire ni fusion vers la branche principale. Voir [conflict-resolution.md](conflict-resolution.md).

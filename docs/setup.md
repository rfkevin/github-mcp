# Configuration du serveur

Le Worker expose `/mcp` derrière OAuth 2.1. `/health` confirme que le processus répond ; `/ready` exige la configuration et renvoie le SHA du paquet publié. Aucune de ces sondes ne prouve que les permissions GitHub ou une connexion utilisateur fonctionnent. Les sept outils historiques sont conservés : `github_list_repositories`, `github_get_project_guide`, `github_read_file`, `github_list_directory`, `github_search_code`, `github_compare_refs` et `github_ci_status`. S’y ajoutent `github_get_project_context`, `github_read_files`, `github_get_check_result`, `github_get_failure_report`, `github_get_quality_report`, `github_list_pull_requests` et `github_get_pull_request`.

Les lectures utilisent sept familles de jetons minimaux : metadata, contents, checks, statuses, actions, pull_requests et issues. Une permission manquante ne bloque pas toutes les familles. Issues: Read est demandé uniquement pour `github_list_issues` et `github_get_issue`, indépendamment des PR. Accepter la mise à jour des permissions dans l’installation GitHub App avant l’essai réel. Les clients de lecture conservent `policy.readOnly`. La résolution d’une branche en SHA nécessite contents:read ; les sources CI deviennent indépendantes une fois ce SHA obtenu.

Le mode multi-dépôts ajoute `github_prepare_checks`, `github_run_checks` et `github_get_agent_check_result` avec `GITHUB_AUTOMATION_ENABLED=true` ET consentement `mcp:automation`. Préparer un commit exige aussi les droits d’écriture. La sélection GitHub définit les dépôts, sans configuration par dépôt dans le MCP. Voir [multi-repository.md](multi-repository.md). Le mode historique `GITHUB_CHECKS_CONFIG` / `mcp:checks` conserve ses deux outils pour compatibilité ; le mode multi-dépôts prend priorité si les deux sont autorisés.

Le catalogue comprend dix-huit outils de lecture. Douze outils optionnels, `github_create_branch`, `github_commit_changes`, `github_apply_changes`, `github_replace_text`, `github_restore_file`, `github_append_file`, `github_create_issue`, `github_comment_issue`, `github_resolve_conflicts`, `github_open_pull_request`, `github_comment_pull_request` et `github_comment_commit`, nécessitent le réglage texte `GITHUB_WRITES_ENABLED=true` ET le consentement `mcp:write`. Absence, chaîne vide ou `false` les désactivent ; une autre valeur refuse la configuration. Les anciens consentements de lecture ne gagnent pas ces écritures. Les branches appartiennent à l’utilisateur authentifié, pas à un modèle certifié, et les dépôts proviennent de la sélection de l’installation. Voir [writes.md](writes.md).

`github_create_issue` et `github_comment_issue` demandent un jeton indépendant Issues: Write ; leur refus ne bloque pas les fichiers, PR ou lectures d’issues. Accepter cette permission dans l’installation avant l’essai réel ; le code n’accorde aucun droit GitHub. Le contexte indique `issueWritesEnabled` et `requiredPermissions.issueWrites` quand l’outil est exposé, sans prétendre que l’App possède effectivement ces droits.

`github_list_issues` renvoie une page GitHub filtrée des PR, sans les corps : suivre `nextPage` même si la page d’issues est vide. `potentiallyTruncated` reste vrai à la borne de 100 pages. `github_get_issue` refuse un numéro de PR, borne le corps à 12 000 octets et chaque commentaire à 2 000 octets après masquage des formats connus. Il expose les commentaires par pages de 20 et signale les extraits tronqués. Pour retrouver le code et ses tests : [code-map.md](code-map.md).

`github_apply_changes` est une couche de transformations ciblées au-dessus de `WriteCoordinator.commitChanges`: un lot ordonné de `replace`, `append`, `restore` et `create` est préparé en mémoire puis publié par un seul commit si toutes les préconditions sont valides. V1 refuse de combiner `restore` ou `create` avec une autre opération sur le même chemin. Les protections, limites et contrôles de SHA du commit final restent ceux du coordinateur existant.

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

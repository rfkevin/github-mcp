# Préparer du code depuis un client MCP

## État et activation

Les outils sont implémentés et testés localement avec GitHub simulé. Aucun test d’écriture réel, changement de permission distant, commit, push ou déploiement n’est réalisé par cette implémentation. Les vérifications et la préparation des workflows sont activables séparément avec [le mode multi-dépôts](multi-repository.md).

Trois conditions sont nécessaires :

1. GitHub App : **Contents: Read and write** et **Pull requests: Read and write**, puis acceptation de ces droits dans l’installation. Les lectures conservent leurs jetons minimaux. Aucun droit Actions en écriture, Workflows, Administration ou approbation n’est nécessaire à ces quatre outils.
2. Serveur : variable texte non secrète `GITHUB_WRITES_ENABLED` à `true`. Elle reste absente de la configuration livrée. Conserver le réglage dans la configuration de déploiement, pas seulement dans le tableau de bord. Après modification de bindings Wrangler, exécuter `npm run cf-typegen`, puis publier au moment choisi. Garder les préversions désactivées pour les écritures.
3. Client : nouveau consentement incluant **`mcp:read mcp:write offline_access`**. Vérifier les droits effectivement demandés : une simple reconnexion sans `mcp:write` ne suffit pas. L’écran de consentement explique les modifications et suppressions, les PR et le risque d’automatisations.

Les anciens jetons de lecture ne gagnent aucun droit. Retirer la variable, la vider ou la mettre à `false` masque les quatre outils même pour les anciens jetons d’écriture. Toute autre valeur refuse la configuration. Pour révoquer également le pouvoir détenu par l’App, retirer les permissions GitHub correspondantes.

**Les dépôts restent ceux sélectionnés dans l’installation GitHub**, sans liste parallèle dans le code ou dans la configuration du MCP. Chaque demande d’écriture vérifie la liste effective avant d’écrire. La lecture de cette liste est bornée à 1 000 dépôts : un dépôt non trouvé est refusé, jamais autorisé par défaut. GitHub contrôle aussi les droits lors de l’écriture. Une révocation concurrente sera appliquée selon les garanties de GitHub.

## Les quatre outils

| Outil | Paramètres essentiels | Résultat |
| --- | --- | --- |
| `github_create_branch` | `repository`, `task`, `expectedBaseSha`, `baseBranch` facultatif | `branch`, `sha`, `baseBranch` |
| `github_commit_changes` | `repository`, `branch`, `expectedHeadSha`, `message`, `changes` et/ou `deletions` | `commitSha`, chemins modifiés et supprimés |
| `github_open_pull_request` | `repository`, `branch`, `expectedHeadSha`, `title`, `body` et `baseBranch` facultatifs | numéro, URL, brouillon, SHA observé et `headMatchesExpected` |
| `github_comment_pull_request` | `repository`, `number`, `expectedHeadSha`, `body` | commentaire sur une PR ouverte de sa propre branche dans le même dépôt ; aucune approbation |

Les outils de lecture `github_list_pull_requests` et `github_get_pull_request` permettent de retrouver une PR après une interruption. La lecture d’une PR charge sa discussion uniquement avec `includeDiscussion=true` : 20 commentaires généraux et 20 revues maximum, dans l’ordre ancien vers récent, extraits de 2 000 octets. Ce n’est pas l’historique complet des commentaires ligne par ligne. En cas de résultat d’écriture incertain, vérifier la branche ou la discussion avant de relancer.

Lire le contexte et les fichiers avant de préparer un changement. Le SHA du commit (`sha`) sert pour la branche ; le SHA du blob (`blobSha` des lectures groupées, `sha` de `github_read_file`) sert pour chaque fichier.

Le nom de branche est construit par le serveur : `mcp/<identifiant GitHub authentifié>/<task>`. `task` est un libellé de 1 à 48 caractères minuscules, chiffres et tirets, sans tiret initial/final. Le client ne choisit pas l’identité. Les branches d’un autre utilisateur sont refusées. Plusieurs clients OAuth du même utilisateur partagent cependant son préfixe.

`baseBranch` vaut la branche par défaut si omis. `expectedBaseSha` doit être un SHA complet de 40 caractères lu auparavant. Une base ayant changé ou une branche déjà existante est refusée, sans écrasement.

Pour un commit :

- `changes` contient `{ path, content, expectedSha? }`. Un fichier existant exige son SHA de blob ; sans SHA il doit être nouveau. `content` contient le fichier complet, pas un patch ni un extrait numéroté.
- `deletions` contient `{ path, expectedSha }`. Une suppression exige toujours le SHA du fichier. Ne pas transmettre un fichier tronqué comme contenu complet.
- `expectedHeadSha` est obligatoire. Maximum 50 fichiers au total, 1 000 000 octets cumulés de nouveau contenu et 200 caractères pour le message. Les doublons, lots vides et contenus binaires sont refusés.
- Un arbre et un commit sont préparés, puis la branche est avancée sans force. Une divergence concurrente est refusée ; des objets Git non rattachés peuvent subsister si l’avancement échoue. Ce n’est pas un verrou distribué ni un compare-and-swap Git strict face aux modifications externes de références.

Relire avec `github_compare_refs` avant de demander une PR. Elle est toujours **en brouillon**, depuis la branche de travail vers `baseBranch` (par exemple la branche de départ develop), ou la branche par défaut si omis. L’outil ne fusionne pas, n’approuve pas et ne rend pas la PR prête à fusionner. GitHub ne permet pas d’imposer un SHA de tête atomiquement dans la création de PR : `headMatchesExpected=false` indique un changement observé pendant l’opération. Même `true` ne fige pas la branche ; relire le diff avant toute validation.

## Protections et limites

- Refus des branches main, master, client, client/*, de la branche par défaut réelle et des branches hors du préfixe de l’utilisateur.
- Refus des chemins sensibles connus (`.env`, clés, etc.), workflows/actions, CODEOWNERS, scripts de contrôle CI et de publication et parents protégés. Les dossiers, sous-modules et liens symboliques existants ne peuvent pas être remplacés par ces commits.
- La protection par nom ne détecte pas un secret placé dans un fichier ordinaire. Ne jamais fournir de secret à un outil d’écriture.
- Aucun outil de suppression de branche, fusion, approbation, changement de permissions, commande shell arbitraire ou déploiement direct.
- Les jetons GitHub Contents/Pull requests en écriture restent plus puissants que cette interface. Maintenir les protections de branche sur GitHub, sans contournement pour l’App. Une compromission du serveur ou de sa clé n’est pas neutralisée par ces seules restrictions applicatives.
- L’isolation porte sur les branches de travail, pas sur les dépôts entre utilisateurs. Les comptes autorisés du serveur partagent l’installation.

**Important : commits et PR peuvent déclencher les automatisations préexistantes**, y compris des déploiements ou un `pull_request_target` dangereux. Une PR en brouillon ne garantit pas l’absence d’exécution. Examiner ces workflows, intégrations, secrets et règles de publication avant d’activer l’écriture sur une installation. Les tests sur du code proposé ne doivent pas recevoir de secrets de déploiement.

`WRITE_CONFLICT`, `BASE_CHANGED` ou `HEAD_CHANGED` demandent de relire les références/fichiers. `WRITE_RESULT_UNKNOWN` signifie qu’une écriture a pu aboutir malgré une erreur réseau/serveur : vérifier GitHub avant toute nouvelle demande, pas de rejeu automatique. En cas d’erreur d’ouverture de PR, vérifier aussi si une PR existe déjà. Les contenus et corps de réponses GitHub ne sont pas inscrits dans l’audit applicatif.

## Premier essai à faire avec le propriétaire

Après publication et consentement explicites, choisir un dépôt de test de l’installation dont les automatisations ont été revues. Lire le contexte, créer une branche, ajouter un petit fichier de documentation, relire le diff et ouvrir une PR en brouillon. Tester ensuite un refus de branche protégée et un SHA périmé. Ne pas fusionner automatiquement et ne pas présenter les tests simulés comme la preuve de cet essai distant.

Références : [références Git](https://docs.github.com/en/rest/git/refs#create-a-reference), [création de PR](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [permissions GitHub App](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

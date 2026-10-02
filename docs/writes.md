# Préparer du code depuis un client MCP

## État et activation

Les outils sont implémentés et testés localement avec GitHub simulé, y compris le transport MCP avec consentement OAuth. Ces tests ne prouvent pas leur fonctionnement sur une installation distante après publication. Les vérifications et la préparation des workflows sont activables séparément avec [le mode multi-dépôts](multi-repository.md).

Trois conditions sont nécessaires :

1. GitHub App : **Contents: Read and write** pour les fichiers/branches, **Pull requests: Read and write** pour les PR, **Issues: Read** pour les lectures et **Issues: Read and write** pour créer une issue, puis acceptation des droits nécessaires dans l’installation. Les jetons de ces familles sont séparés : le refus Issues: Write ne bloque pas les autres. Aucun droit Actions en écriture, Workflows, Administration ou approbation n’est nécessaire à ces dix outils.
2. Serveur : variable texte non secrète `GITHUB_WRITES_ENABLED` à `true`. Elle reste absente de la configuration livrée. Conserver le réglage dans la configuration de déploiement, pas seulement dans le tableau de bord. Après modification de bindings Wrangler, exécuter `npm run cf-typegen`, puis publier au moment choisi. Garder les préversions désactivées pour les écritures.
3. Client : nouveau consentement incluant **`mcp:read mcp:write offline_access`**. Vérifier les droits effectivement demandés : une simple reconnexion sans `mcp:write` ne suffit pas. L’écran de consentement explique les modifications et suppressions, les PR et le risque d’automatisations.

Les anciens jetons de lecture ne gagnent aucun droit d’écriture. Retirer la variable, la vider ou la mettre à `false` masque les dix outils même pour les anciens jetons d’écriture, ainsi que l’intégration optionnelle. Toute autre valeur refuse la configuration. Pour révoquer également le pouvoir détenu par l’App, retirer les permissions GitHub correspondantes.

**Les dépôts restent ceux sélectionnés dans l’installation GitHub**, sans liste parallèle dans le code ou dans la configuration du MCP. Chaque demande d’écriture vérifie la liste effective avant d’écrire. La lecture de cette liste est bornée à 1 000 dépôts : un dépôt non trouvé est refusé, jamais autorisé par défaut. GitHub contrôle aussi les droits lors de l’écriture. Une révocation concurrente sera appliquée selon les garanties de GitHub.

## Les dix outils

| Outil | Paramètres essentiels | Résultat |
| --- | --- | --- |
| `github_create_branch` | `repository`, `task`, `expectedBaseSha`, `baseBranch` facultatif | `branch`, `sha`, `baseBranch` |
| `github_commit_changes` | `repository`, `branch`, `expectedHeadSha`, `message`, `changes` et/ou `deletions` | `commitSha`, chemins modifiés et supprimés |
| `github_replace_text` | `repository`, `branch`, `path`, `expectedHeadSha`, `expectedSha`, `oldText`, `newText`, `message`, `agentLabel` | commit avec la même trace, les mêmes protections et le même suivi CI |
| `github_restore_file` | `repository`, `branch`, `path`, `sourceRef`, `expectedHeadSha`, `expectedSha` (ou `null` si absent), `message`, `agentLabel` | contenu texte restauré, commit, `sourceSha`, `sourceBlobSha` et suivi CI |
| `github_append_file` | `repository`, `branch`, `path`, `expectedHeadSha`, `expectedSha`, `text`, `message`, `agentLabel` | ajout exact en fin de fichier existant, commit et suivi CI |
| `github_create_issue` | `repository`, `title`, `body` facultatif, `agentLabel` | numéro, titre, état et URL ; trace du compte/agent en tête du corps |
| `github_resolve_conflicts` | `repository`, `branch`, `expectedHeadSha`, `expectedBaseSha`, `resolutions`, `message`, `agentLabel`, `baseBranch` facultatif | commit à deux parents sur sa branche personnelle et suivi CI |
| `github_open_pull_request` | `repository`, `branch`, `expectedHeadSha`, `title`, `body` et `baseBranch` facultatifs | numéro, URL, brouillon, SHA observé et `headMatchesExpected` |
| `github_comment_pull_request` | `repository`, `number`, `expectedHeadSha`, `body`, `agentLabel` ; `decision` et `expectedBaseSha` pour un avis | commentaire sur une PR ouverte interne, y compris d’un autre agent ; aucune approbation GitHub |
| `github_comment_commit` | `repository`, `sha`, `body`, `agentLabel` | commentaire général sur un commit exact, sans modifier son code |

Les outils de lecture `github_list_pull_requests` et `github_get_pull_request` permettent de retrouver une PR après une interruption. Avec `includeDiscussion=true`, `discussionPage` parcourt les commentaires généraux, revues et commentaires de code par pages de 20 ; suivre `nextDiscussionPage`. Les longs textes restent tronqués et signalés. `github_get_commit` lit un SHA et, sur demande, ses vingt premiers commentaires généraux. En cas de résultat d’écriture incertain, vérifier la branche ou la discussion complète avant de relancer.

Pour des conflits, appeler d’abord `github_get_merge_context`, lire les trois
versions, puis fournir tous les choix à `github_resolve_conflicts`. Le serveur
reprend les changements de base dans sa branche personnelle et conserve les
protections habituelles ; il ne fusionne pas la PR. Le parcours, les limites et
la concurrence sont détaillés dans [conflict-resolution.md](conflict-resolution.md).

Lire le contexte et les fichiers avant de préparer un changement. Le SHA du commit (`sha`) sert pour la branche ; le SHA du blob (`blobSha` des lectures groupées, `sha` de `github_read_file`) sert pour chaque fichier.

`github_restore_file` restaure le contenu du même chemin à partir d’un SHA,
d’une branche ou d’un tag résolu une fois en commit immuable. Il peut recréer un
fichier supprimé avec `expectedSha:null`. Il ne restaure pas un commit entier ni
le mode exécutable d’un fichier absent. `github_append_file` ajoute uniquement
`text`, sans séparateur implicite : fournir les sauts de ligne souhaités. Le
serveur conserve le BOM et les fins de ligne ; un UTF-8 invalide est refusé.
Les deux outils gardent la limite de 1 Mo et toutes les protections de commits,
y compris les journaux en ajout seul : une restauration ne peut pas les réécrire.

Pour une issue, utiliser `github_create_issue`, puis `github_get_issue` pour la
relire ; `github_list_issues` permet de retrouver son numéro. Titre limité à 256
caractères, corps à 30 000 caractères hors trace. La création exige explicitement
`mcp:write` et demande un jeton **Issues: Write** indépendant. Les labels,
assignations et modifications d’issues ne sont pas exposés par cet outil. En cas
de résultat incertain, lire les issues existantes avant de relancer : la création
ne garantit pas l’absence de doublon et peut déclencher notifications/automatisations.

Pour un extrait d’un gros fichier, préférer `github_replace_text`. Le serveur lit
le fichier complet au commit immuable attendu et remplace une seule occurrence
exacte, avec contrôle du blob et de la tête de branche. Les occurrences chevauchantes
sont ambiguës et refusées. `NO_CHANGE`, `TEXT_NOT_FOUND` et `TEXT_NOT_UNIQUE` n’écrivent
rien. Le coordinateur conserve les protections des journaux, fichiers et branches,
la signature du commit et le contrôle concurrent au moment d’écrire. Ce mécanisme
ne vérifie pas la qualité du nouveau texte ; `github_commit_changes` conserve son
contrat de remplacement complet, sans garde générale anti-troncature dans ce lot.

Le nom de branche est construit par le serveur : `mcp/<identifiant GitHub authentifié>/<task>`. `task` est un libellé de 1 à 48 caractères minuscules, chiffres et tirets, sans tiret initial/final. Le client ne choisit pas l’identité. Les branches d’un autre utilisateur sont refusées. Plusieurs clients OAuth du même utilisateur partagent cependant son préfixe.

`baseBranch` vaut la branche par défaut si omis. `expectedBaseSha` doit être un SHA complet de 40 caractères lu auparavant. Une base ayant changé ou une branche déjà existante est refusée, sans écrasement.

Pour un commit :

- `changes` contient `{ path, content, expectedSha? }`. Un fichier existant exige son SHA de blob ; sans SHA il doit être nouveau. `content` contient le fichier complet, pas un patch ni un extrait numéroté.
- `deletions` contient `{ path, expectedSha }`. Une suppression exige toujours le SHA du fichier. Ne pas transmettre un fichier tronqué comme contenu complet.
- `expectedHeadSha` est obligatoire. Maximum 50 fichiers au total, 1 000 000 octets cumulés de nouveau contenu et 200 caractères pour le message. Les doublons, lots vides et contenus binaires sont refusés.
- Un arbre et un commit sont préparés, puis la branche est avancée sans force. Une divergence concurrente est refusée ; des objets Git non rattachés peuvent subsister si l’avancement échoue. Ce n’est pas un verrou distribué ni un compare-and-swap Git strict face aux modifications externes de références.

Relire avec `github_compare_refs` avant de demander une PR. Elle est **en brouillon par défaut** (`draft:true`) ; `draft:false` est réservé à une PR prête pour revue. La cible est `baseBranch` ou la branche par défaut. L’ouverture ne fusionne ni n’approuve. GitHub ne permet pas d’imposer un SHA de tête atomiquement dans la création de PR : `headMatchesExpected=false` indique un changement observé pendant l’opération. Même `true` ne fige pas la branche ; relire le diff avant toute validation. Les réponses de commit et PR contiennent `followUp` : suivre la CI au dernier SHA, pas annoncer terminé dès la création.

`agentLabel` est un nom déclaré, pas une identité de modèle authentifiée. Le serveur ajoute `MCP-Actor` et `MCP-Agent` aux messages de commit ; le total doit tenir dans 200 caractères. Les commentaires gardent le compte, le label et le SHA relu. Voir [le protocole d’équipe](team-workflow.md) pour les accords et refus par commentaire.

## Protections et limites

- `AGENT_MEMORY.md` et `TOOL_IMPROVEMENTS.md` à la racine sont des journaux en ajout seul : aucune suppression ni modification des octets existants par le MCP. Ajouter la nouvelle note au contenu complet lu, avec le SHA du fichier et de la branche. Une correction est une nouvelle note signée. Cette règle ne bloque pas un accès Git direct et n’authentifie pas le nom du modèle déclaré.
- Refus des branches main, master, client, client/*, de la branche par défaut réelle et des branches hors du préfixe de l’utilisateur.
- Refus des chemins sensibles connus (`.env`, clés, etc.), workflows/actions, CODEOWNERS, scripts de contrôle CI et de publication et parents protégés. Les dossiers, sous-modules et liens symboliques existants ne peuvent pas être remplacés par ces commits.
- La protection par nom ne détecte pas un secret placé dans un fichier ordinaire. Ne jamais fournir de secret à un outil d’écriture.
- Aucun outil de suppression de branche, approbation GitHub, fermeture de PR, changement de permissions, commande shell arbitraire ou déploiement direct. La fusion limitée à `integration` est une capacité **séparée**, désactivée sans nouveau consentement et politique du propriétaire ; jamais une fusion vers la branche principale.
- Les jetons GitHub Contents/Pull requests en écriture restent plus puissants que cette interface. Maintenir les protections de branche sur GitHub, sans contournement pour l’App. Une compromission du serveur ou de sa clé n’est pas neutralisée par ces seules restrictions applicatives.
- L’isolation porte sur les branches de travail, pas sur les dépôts entre utilisateurs. Les comptes autorisés du serveur partagent l’installation.

**Important : commits et PR peuvent déclencher les automatisations préexistantes**, y compris des déploiements ou un `pull_request_target` dangereux. Une PR en brouillon ne garantit pas l’absence d’exécution. Examiner ces workflows, intégrations, secrets et règles de publication avant d’activer l’écriture sur une installation. Les tests sur du code proposé ne doivent pas recevoir de secrets de déploiement.

`WRITE_CONFLICT`, `BASE_CHANGED` ou `HEAD_CHANGED` demandent de relire les références/fichiers. `WRITE_RESULT_UNKNOWN` signifie qu’une écriture a pu aboutir malgré une erreur réseau/serveur : vérifier GitHub avant toute nouvelle demande, pas de rejeu automatique. En cas d’erreur d’ouverture de PR, vérifier aussi si une PR existe déjà. Les contenus et corps de réponses GitHub ne sont pas inscrits dans l’audit applicatif.

## Premier essai à faire avec le propriétaire

Après publication et consentement explicites, choisir un dépôt de test de l’installation dont les automatisations ont été revues. Lire le contexte, créer une branche, ajouter un petit fichier de documentation, relire le diff et ouvrir une PR en brouillon. Tester ensuite un refus de branche protégée et un SHA périmé. Ne pas fusionner automatiquement et ne pas présenter les tests simulés comme la preuve de cet essai distant.

Références : [références Git](https://docs.github.com/en/rest/git/refs#create-a-reference), [création de PR](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [permissions GitHub App](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).

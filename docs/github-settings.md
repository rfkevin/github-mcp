# Réglages GitHub : quoi changer et dans quel ordre

Ces étapes sont à effectuer par le propriétaire. La rédaction de ce guide ne modifie aucun réglage distant. Branche de production actuelle : **master**, pas main.

## 1. Permissions de la GitHub App : nécessaires aux lectures

Ouvrir les [réglages de rfkevin-github-mcp](https://github.com/settings/apps/rfkevin-github-mcp), puis **Permissions & events → Repository permissions**.

| Permission GitHub | Valeur pour ce lot | Utilité |
| --- | --- | --- |
| Metadata | Read-only, automatique | Dépôts et métadonnées |
| Contents | Read-only | Fichiers, arbres, commits et différences |
| Checks | Read-only | Contrôles et annotations |
| Commit statuses | Read-only | Statuts de commit |
| Actions | Read-only | Exécutions et jobs |

Cliquer sur **Save changes**, puis ouvrir **Settings du compte → Applications → Installed GitHub Apps → rfkevin-github-mcp → Configure**. Accepter la demande de nouvelles permissions si elle apparaît ; l’email envoyé par GitHub permet aussi d’y accéder. Enregistrer l’App ne suffit pas : les permissions supplémentaires ne prennent effet qu’après acceptation par l’installation.

Conserver **Only select repositories** et les seuls dépôts voulus. Ne pas élargir à tous les dépôts par commodité.

Ce lot n’exige pas de nouvelle permission Pull requests, Issues, Administration ou Workflows. Ne pas ajouter de droits d’organisation ou de compte. Si d’autres usages de cette App ont déjà besoin de droits supplémentaires, les examiner avant de les retirer : ne pas casser ces usages à l’aveugle.

Les clés, Client ID, App ID et callback OAuth existants n’ont pas à être changés pour cette mise à jour.

Source : [modifier une GitHub App et faire accepter ses permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration).

## 2. Publier le code sans confondre push et déploiement

1. Committer et pousser la branche **codex/agent-workflow-foundation**, pas directement master.
2. Ouvrir une PR vers **master**. Un simple push sur la branche de travail ne déclenche pas la CI de ce lot : elle démarre à l’ouverture ou à la mise à jour d’une PR, puis aux pushs sur master.
3. Vérifier dans la PR le job **ci**, exécuté par GitHub Actions, et consulter ses erreurs s’il échoue. Les tests locaux ne remplacent pas cette première validation Linux.
4. Relire avant de fusionner : l’intégration Cloudflare actuellement configurée peut déployer automatiquement master. Les autres branches peuvent aussi déclencher une préversion Cloudflare selon les réglages du projet.

Les deux workflows de ce lot ne demandent **aucun secret GitHub** : ne pas ajouter la clé privée, le secret OAuth ou un jeton Cloudflare aux workflows de tests.

Dans **Settings du dépôt → Actions → General**, GitHub Actions doit être autorisé et la politique des actions doit permettre `actions/checkout` et `actions/setup-node`, épinglées par SHA dans les fichiers. Conserver un `GITHUB_TOKEN` en lecture seule ; inutile d’autoriser la création ou l’approbation de PR par les workflows. Les permissions de ce jeton ne sont pas les permissions de la GitHub App.

## 3. Protéger master après le premier passage CI

Dans [les paramètres du dépôt](https://github.com/rfkevin/github-mcp/settings), utiliser **Branches → Add classic branch protection rule** pour `master`, ou un ruleset équivalent si ce dépôt utilise déjà les rulesets.

Configuration proposée :

- **Require a pull request before merging** : activer.
- **Require status checks to pass before merging** : activer et sélectionner le contrôle réellement publié par le job `ci` après sa première exécution. Sélectionner GitHub Actions comme source attendue si proposé.
- **Require branches to be up to date before merging** : activer pour vérifier la branche à jour.
- Ne pas autoriser les force-pushs ni les suppressions de master.
- Ne pas accorder à la GitHub App de contournement de ces règles.

Si tu es le seul relecteur, **ne pas exiger une approbation de ta propre PR** : GitHub interdit à l’auteur de l’approuver. PR obligatoire et CI obligatoire restent utiles. Une approbation par une autre personne nécessite un second relecteur réel. Ce mécanisme est distinct de la future approbation de déploiement depuis ton téléphone.

La protection des chemins `.github/workflows`, `.github/actions`, `.github/CODEOWNERS` et `scripts/ci` existe dans la bibliothèque MCP, pas comme règle GitHub déjà installée. Elle n’empêche pas un humain disposant d’un accès Git direct de les modifier. Leur revue et la protection de master restent nécessaires.

Sources : [protection de branche](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule), [approbation des PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).

## 4. Lancer les tests depuis l’agent : activation séparée

Ne faire cette étape qu’après revue et validation de `agent-checks.yml` sur la branche par défaut.

- Dans la GitHub App, passer **Actions** de Read-only à **Read and write**, puis accepter à nouveau la mise à jour de l’installation. Ne pas ajouter **Workflows: write**.
- Vérifier manuellement **Actions → agent-checks → Run workflow**, sélectionner master et fournir le SHA complet du code à tester. Le workflow doit exister sur la branche par défaut pour permettre son lancement manuel.
- Configurer ensuite le Worker et le consentement comme indiqué dans [checks.md](checks.md). Changer les permissions GitHub seules n’active pas `github_run_checks`.

Attention : Actions: write est un droit GitHub plus large que le seul lancement des tests. C’est le serveur MCP qui limite son usage exposé à `agent-checks.yml`, aux dépôts autorisés et au contrôleur épinglé. Ce n’est pas une restriction native de GitHub à un workflow unique.

Sources : [lancement manuel](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [API de dispatch et permission Actions](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event).

## 5. Production avec validation humaine : lot suivant

Il n’y a pas encore de workflow `deploy-staging` ni `deploy-production` dans ce lot. Ne pas créer des secrets de déploiement dans les workflows de vérification.

La future étape devra créer les environnements, leurs ressources et leurs secrets séparés, rattacher le job de production à son environnement et choisir le relecteur obligatoire. Si le même utilisateur doit déclencher et approuver, l’option **Prevent self-review** empêcherait cette approbation : choisir explicitement le fonctionnement voulu, selon les options disponibles pour le dépôt et l’offre GitHub.

Surtout, il faudra migrer ou désactiver la voie de déploiement automatique Cloudflare de master. **Un environnement GitHub ne bloque pas un déploiement effectué directement par Cloudflare.** Ne pas annoncer une validation obligatoire tant que cette autre voie existe.

Sources : [environnements GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [intégration GitHub de Cloudflare](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

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
| Pull requests | Read-only | Les deux nouveaux outils de lecture des PR et discussions |

Cliquer sur **Save changes**, puis ouvrir **Settings du compte → Applications → Installed GitHub Apps → rfkevin-github-mcp → Configure**. Accepter la demande de nouvelles permissions si elle apparaît ; l’email envoyé par GitHub permet aussi d’y accéder. Enregistrer l’App ne suffit pas : les permissions supplémentaires ne prennent effet qu’après acceptation par l’installation.

Conserver **Only select repositories** et les seuls dépôts voulus. Ne pas élargir à tous les dépôts par commodité.

Les lectures de fichiers n’exigent toujours pas Pull requests. Cette permission supplémentaire est réservée aux outils de PR. Issues, Administration et Workflows ne sont pas nécessaires. Ne pas ajouter de droits d’organisation ou de compte. Si d’autres usages de cette App ont déjà besoin de droits supplémentaires, les examiner avant de les retirer. Pour les outils d’écriture optionnels, voir la section ci-dessous.

Les clés, Client ID, App ID et callback OAuth existants n’ont pas à être changés pour cette mise à jour.

Source : [modifier une GitHub App et faire accepter ses permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration).

## 2. Publier le code sans confondre push et déploiement

1. Committer et pousser la branche **codex/agent-workflow-foundation**, pas directement master.
2. Ouvrir une PR vers **master**. Un simple push sur la branche de travail ne déclenche pas la CI de ce lot : elle démarre à l’ouverture ou à la mise à jour d’une PR, puis aux pushs sur master.
3. Vérifier dans la PR le job **ci**, exécuté par GitHub Actions, et consulter ses erreurs s’il échoue. Les tests locaux ne remplacent pas cette première validation Linux.
4. Relire avant de fusionner : l’intégration Cloudflare actuellement configurée peut déployer automatiquement master. Les autres branches peuvent aussi déclencher une préversion Cloudflare selon les réglages du projet.

Les workflows `ci` et `agent-checks` ne demandent **aucun secret de déploiement** : ne pas y ajouter la clé privée, le secret OAuth ou un jeton Cloudflare. Les nouveaux workflows de publication obtiennent leur jeton Cloudflare uniquement dans leur environnement GitHub.

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

La protection des chemins `.github/workflows`, `.github/actions`, `.github/CODEOWNERS` et `scripts/ci` / `scripts/deploy` existe dans la bibliothèque MCP, pas comme règle GitHub déjà installée. Elle n’empêche pas un humain disposant d’un accès Git direct de les modifier. Leur revue et la protection de master restent nécessaires.

Sources : [protection de branche](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule), [approbation des PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).

## 4. Lancer les tests depuis l’agent : activation séparée

Pour le fonctionnement commun à tous les dépôts, suivre [le guide multi-dépôts](multi-repository.md). Il utilise une activation globale et le consentement `mcp:automation`, avec Actions et Workflows en écriture pour préparer le workflow de tests encadré. Les instructions ci-dessous concernent uniquement le mode historique, sans préparation de workflow.

Ne faire cette étape qu’après revue et validation de `agent-checks.yml` sur la branche par défaut.

- Dans la GitHub App, passer **Actions** de Read-only à **Read and write**, puis accepter à nouveau la mise à jour de l’installation. Ne pas ajouter **Workflows: write**.
- Vérifier manuellement **Actions → agent-checks → Run workflow**, sélectionner master et fournir le SHA complet du code à tester. Le workflow doit exister sur la branche par défaut pour permettre son lancement manuel.
- Configurer ensuite le Worker et le consentement comme indiqué dans [checks.md](checks.md). Changer les permissions GitHub seules n’active pas `github_run_checks`.

Attention : Actions: write est un droit GitHub plus large que le seul lancement des tests. C’est le serveur MCP qui limite son usage exposé à `agent-checks.yml`, aux dépôts autorisés et au contrôleur épinglé. Ce n’est pas une restriction native de GitHub à un workflow unique.

Sources : [lancement manuel](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), [API de dispatch et permission Actions](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event).

## 5. Écritures MCP : activation séparée

Les dix outils d’écriture sont implémentés mais non activés par défaut. La création d’issue demande séparément Issues: Write ; les lectures d’issues utilisent Issues: Read. Ils peuvent être activés indépendamment des vérifications. Pour le parcours complet, ajouter ensuite le mode multi-dépôts décrit dans [multi-repository.md](multi-repository.md).

- Examiner les automatisations de chaque dépôt sélectionné : création de branche, push ou PR peuvent lancer une CI ou un déploiement, même avec une PR en brouillon.
- Passer **Contents** à **Read and write**, ajouter **Pull requests: Read and write**, enregistrer puis accepter les nouveaux droits dans l’installation. **Actions reste Read-only** pour ce lot. Ne pas ajouter Workflows, Administration, Issues ni de droit de contournement des branches.
- Conserver la sélection des dépôts dans l’installation ; pas de deuxième liste à remplir dans le MCP. Tous les utilisateurs autorisés du serveur partagent cette sélection.
- Suivre [writes.md](writes.md) pour le réglage global, le nouveau consentement et l’essai contrôlé. Ne pas activer les préversions avec les identifiants de production.

Ces droits GitHub sont plus larges que les outils exposés. Les restrictions aux branches de travail et fichiers sont appliquées par le serveur, pas par une permission GitHub spécifique à ces opérations. Les PR sont en brouillon par défaut. La collaboration entre agents et la fusion optionnelle vers `integration` exigent les conditions distinctes du [guide d’équipe](team-workflow.md) ; ne pas donner de bypass au bot, ni activer une production automatique sur integration.

## 6. Staging et production : code prêt, configuration à effectuer

`deploy-staging.yml`, `deploy-production.yml` et le workflow réutilisable `publish-worker.yml` sont maintenant présents. Ils restent désactivés tant que la variable de dépôt `RELEASE_PIPELINE_ENABLED` n’est pas `true`. Suivre [le guide de déploiement](deployments.md), qui donne toutes les variables, les secrets et l’ordre de migration.

Créer `staging` et `production`, leurs ressources séparées et le secret Cloudflare dans chaque environnement. Pour production : branches protégées uniquement, relecteur humain obligatoire, contournement administrateur désactivé. Si tu déclenches puis approuves toi-même, laisser **Prevent self-review** décoché. Le code vérifie les protections et l’historique d’approbation du run avant publication.

Surtout, il faudra migrer ou désactiver la voie de déploiement automatique Cloudflare de master. **Un environnement GitHub ne bloque pas un déploiement effectué directement par Cloudflare.** Ne pas annoncer une validation obligatoire tant que cette autre voie existe.

Sources : [environnements GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [intégration GitHub de Cloudflare](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

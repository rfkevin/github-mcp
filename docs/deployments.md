# Publier avec staging et validation humaine

État au 30 septembre 2026 : code et contrôles locaux préparés. Aucun environnement, secret, KV, Worker, réglage GitHub ou déploiement distant n’a été créé par ce lot. `github_run_checks` reste en attente comme demandé.

## Fonctionnement

1. Après fusion sur **master**, `ci` vérifie les types, les tests et compile le Worker une seule fois. Si `RELEASE_PIPELINE_ENABLED=true`, il conserve `worker-release` avec les empreintes des fichiers, le SHA et l’identifiant de la CI. Les PR ne produisent pas d’artefact publiable.
2. `deploy-staging` démarre après cette CI réussie. Il vérifie sa provenance, la protection de master et que le commit est toujours la pointe de master. Il publie le paquet dans l’environnement `staging`, puis vérifie `/ready`, la découverte OAuth et le refus d’accès MCP sans jeton. Il conserve le même code compilé dans `staged-release`, avec un reçu de staging.
3. Tu lances **Actions → deploy-production → Run workflow** sur master, avec l’identifiant du run `deploy-staging` réussi. Il est visible dans l’URL GitHub du run, après `/actions/runs/`.
4. Le job attend l’approbation de l’environnement **production**. Depuis ton téléphone, ouvrir le run → **Review deployments**, sélectionner production et approuver. Le script vérifie aussi qu’un humain nommé parmi les relecteurs a approuvé cet environnement pour ce run.
5. Le même paquet est publié, sans recompilation. Les sondes vérifient le SHA réellement servi. L’authentification complète et les outils sont ensuite à essayer depuis Claude.

Les publications sont sérialisées par environnement. Une exécution en cours n’est pas annulée au milieu d’un déploiement. La sélection staging refuse un ancien commit de master ; la promotion production peut viser un ancien staging réussi pour revenir à une version précédente. Les artefacts expirent après 14 jours. Ne pas relancer un ancien run pour reconstruire un artefact différent sous le même identifiant : créer une nouvelle CI.

## Réglages GitHub à effectuer

Dans **Settings → Environments**, créer deux environnements nommés exactement `staging` et `production`.

- Pour les deux, sélectionner **Deployment branches and tags → Protected branches only**. `master` doit être protégée et la GitHub App ne doit pas avoir de contournement. Les workflows contrôlent aussi explicitement master.
- Dans production, sélectionner ton compte `rfkevin` comme **Required reviewer**. Le script attend un utilisateur nommé ; une équipe seule n’est pas prise en charge.
- Désactiver le contournement des protections par les administrateurs.
- Laisser **Prevent self-review** décoché si tu veux lancer puis approuver toi-même. C’est différent de l’approbation d’une PR, qui ne peut pas être donnée par son auteur.
- La politique Actions doit autoriser `checkout`, `setup-node`, `upload-artifact` et `download-artifact`. Elles sont épinglées par commit dans les workflows.

Un simple nom `environment: production` peut créer automatiquement un environnement dépourvu de protections. Le contrôle préalable de ce projet refuse cette situation. Les workflows de publication ont `contents:read`, `actions:read`, `deployments:write` ; les étapes de sélection n’ont que des droits de lecture.

## Variables de chaque environnement

Dans **Environment variables**, renseigner ces valeurs non secrètes. Les variables présentes sur Cloudflare ne sont pas automatiquement des variables GitHub.

| Variable | Production actuelle | Staging |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | `8508df2ab3bc8d7e6e2d37fde83dcbb3` | Compte de staging ; peut être distinct |
| `CF_WORKER_NAME` | `github-mcp` | Par exemple `github-mcp-staging` |
| `CF_KV_NAMESPACE_ID` | `65bb801d428d4250a4c8327310e0d065` | Nouveau KV OAuth réservé à staging |
| `PUBLIC_ORIGIN` | `https://github-mcp.rfahedkevin.workers.dev` | URL HTTPS exacte du Worker staging, sans chemin |
| `ALLOWED_GITHUB_USER_IDS` | `105856986` | Identifiants numériques des testeurs autorisés |
| `GITHUB_APP_ID` | `5122110` | ID de l’App de test |
| `GITHUB_INSTALLATION_ID` | `166154980` | Installation de l’App de test |
| `GITHUB_OAUTH_CLIENT_ID` | `Iv23liaWMkDZAKSVWClX` | Client OAuth de test |
| `GITHUB_WRITES_ENABLED` | `false` initialement | `false` initialement |
| `GITHUB_CHECKS_CONFIG` | Vide pour le moment | Vide pour le moment |
| `GITHUB_AUTOMATION_ENABLED` | `false`, ou `true` pour l’essai multi-dépôts autorisé | `false` jusqu’à recette, puis activation choisie |

`BUILD_SHA` est ajouté automatiquement depuis le paquet. Le script refuse de publier production sur un autre Worker, compte, domaine ou KV que ceux du fichier racine. Une migration de ces destinations nécessite une modification revue de cette configuration. Staging ne peut partager le Worker, l’origine ni le KV de production ou des préversions.

Wrangler synchronise les variables non secrètes lors du déploiement : copier dans ces environnements GitHub les options déjà activées que tu souhaites conserver. Un champ d’écriture vide devient `false` ; un champ de vérifications vide désactive leur lancement. Le script ne copie pas la configuration d’une PR.

## Secrets et ressources Cloudflare

Dans **Environment secrets** de chaque environnement GitHub, créer `CLOUDFLARE_API_TOKEN`, avec les permissions nécessaires pour publier les Workers dans le compte prévu. Utiliser des jetons distincts. Ils sont accessibles uniquement à l’étape de publication ; ni tests, ni installation npm, ni compilation ne reçoivent ce secret.

Les jetons Cloudflare Workers sont habituellement limités au compte, pas à un Worker unique. Deux comptes Cloudflare offrent une séparation plus forte que deux Workers du même compte. Le contrôle des noms dans le script ne limite pas les pouvoirs d’un jeton volé.

Dans Cloudflare, préparer le Worker staging, son nouveau KV et ses secrets **runtime** : `GITHUB_PRIVATE_KEY` au format PKCS#8 et `GITHUB_OAUTH_CLIENT_SECRET`. Ces secrets restent sur Cloudflare et ne vont pas dans les workflows GitHub. Les déploiements Wrangler conservent les secrets existants. Ils doivent être installés avant la première sonde `/ready`.

Utiliser de préférence une GitHub App de test installée sur un dépôt de test ; conserver le callback de production et enregistrer celui de staging, soit `PUBLIC_ORIGIN` suivi de `/callback`, dans l’App correspondante. Ne jamais réutiliser le KV OAuth de production. Le KV des préversions existantes ne sert pas à staging.

## Ordre de migration

1. Relire et publier ce lot sur la branche de travail, puis laisser la PR passer la CI. Ne pas encore activer `RELEASE_PIPELINE_ENABLED`.
2. Préparer les deux environnements GitHub, leurs variables, leurs secrets et leurs protections ; préparer les ressources et identifiants staging sur Cloudflare.
3. **Désactiver les builds/déploiements automatiques Cloudflare de production depuis GitHub avant la fusion de migration.** Examiner les autres intégrations et deploy hooks. La version actuelle continue de servir tant qu’aucune nouvelle publication ne la remplace.
4. Fusionner la PR. Tant que l’interrupteur est absent, la nouvelle chaîne ne publie rien.
5. Dans **Settings → Secrets and variables → Actions → Variables**, créer la variable de dépôt `RELEASE_PIPELINE_ENABLED=true`. Relancer la CI du dernier push master si elle n’avait pas produit de paquet. Ne relancer que si ce run n’avait pas encore créé `worker-release`.
6. Vérifier le run staging, puis y tester OAuth et les outils depuis un connecteur de test Claude. Lancer ensuite `deploy-production` et approuver la promotion.

L’intégration Cloudflare actuelle, une commande locale de publication et d’autres détenteurs de jetons peuvent publier hors GitHub. L’approbation n’est une règle effective de ton exploitation qu’après migration de ces voies. Aucun outil MCP de fusion principale, d’approbation GitHub ou de déploiement direct n’est ajouté. L’option distincte de fusion vers `integration` décrite dans [team-workflow.md](team-workflow.md) ne doit déclencher aucune production.

## En cas d’échec

Le pipeline ne lance pas de retour arrière automatique. Une erreur des sondes après publication signifie que le nouveau Worker peut déjà être actif : consulter l’état Cloudflare avant de recommencer. Pour revenir au code antérieur, promouvoir un ancien staging réussi dont l’artefact existe encore, avec une nouvelle validation humaine. Cela ne restaure ni les données KV, ni les secrets, ni les valeurs d’environnement qui auraient changé.

Les tests locaux vérifient les scripts et la construction des paquets. Ils ne prouvent ni le premier passage des workflows sur GitHub/Linux, ni la configuration des comptes, ni la connexion réelle de Claude. Ces essais font partie de la recette.

Sources : [environnements et protections GitHub](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), [historique d’approbation des runs](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run), [publication Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy), [intégration GitHub Cloudflare](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/).

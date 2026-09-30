# Travailler sur plusieurs dépôts avec le même MCP

Le mode multi-dépôts est implémenté et testé localement. Il reste désactivé dans
la configuration livrée et n’a pas encore été publié ni essayé depuis Claude avec
GitHub réel. Le propriétaire a autorisé son intégration après le refus initial
du contrôle d’autorisation. Aucun réglage distant n’a été modifié.

## Fonctionnement quotidien

Réutiliser la même installation GitHub App pour les dépôts sélectionnés, sans
modifier une liste dans le serveur. Un plan `.mcp/checks.json` décrit les commandes
réelles de chaque projet ; un workflow canonique `.github/workflows/mcp-checks.yml`
les exécute. L’agent prépare le plan après lecture du projet, sans prétendre qu’une
commande réussie démontre la qualité ou la sécurité des tests.

Le serveur fournit une prévisualisation puis un commit atomique contrôlé par le
SHA de la branche. Il ne remplace pas un workflow différent. Le premier profil
`quick` démarre au push sur une branche `mcp/<identité>/<tâche>`. Les lancements
manuels exigent ensuite la présence du workflow canonique sur la branche par
défaut (contrainte GitHub), sans fusion automatique. Les autres workflows restent
protégés. L’ancien mode de vérification reste inchangé.

## Activation initiale commune à tous les dépôts

1. GitHub App : Contents et Pull requests en écriture pour coder ; Actions et
   Workflows en écriture pour préparer et lancer les vérifications. Accepter la
   mise à jour dans l’installation. Garder les autres permissions minimales.
2. Serveur : GITHUB_WRITES_ENABLED=true et GITHUB_AUTOMATION_ENABLED=true. Dans
   la chaîne GitHub de publication, définir ces variables dans l’environnement
   staging/production. Pour une publication Wrangler directe, conserver les
   valeurs dans sa configuration. Publier ensuite au moment choisi.
3. Client : obtenir un nouveau consentement comprenant mcp:read, mcp:write,
   mcp:automation et offline_access. Les anciens consentements ne gagnent pas de
   nouvelle capacité.
4. Vérifier le catalogue : github_prepare_checks, github_run_checks,
   github_get_agent_check_result et les quatre outils d’écriture.

L’installation de la GitHub App définit les dépôts accessibles, y compris ceux
ajoutés plus tard. Il n’y a ni liste de dépôts ni épingle de contrôleur à actualiser
dans le serveur pour ce mode. Mettre l’activation à false retire les outils.
Un client possédant seulement mcp:automation peut prévisualiser et lancer les
vérifications ; appliquer la préparation exige aussi le consentement d’écriture.

Le mode historique GITHUB_CHECKS_CONFIG / mcp:checks est conservé. Si le client
possède les deux modes, le mode multi-dépôts prend priorité.

## Choisir le dépôt et la branche

Demande type : « Travaille sur rfkevin/project-mcp-collab à partir de develop,
pour corriger X. »

L’agent lit le contexte de develop, crée sa branche mcp/<identité>/<tâche> depuis
le SHA observé, travaille et ouvre une PR en brouillon vers develop en fournissant
baseBranch. Si aucun nom n’est fourni, la branche par défaut est utilisée.
Les branches de travail existantes du même utilisateur peuvent être reprises.
Le modèle choisit les commandes après lecture du projet ; le MCP les exécute.

## Préparer les commandes du projet

github_get_project_context inclut .mcp/checks.json. Lire les instructions, les
manifestes et les workflows existants avant de décider des commandes.

github_prepare_checks prend repository, branch, expectedHeadSha, plan et apply
(false par défaut). La prévisualisation renvoie les contenus proposés. Avec
apply=true, le workflow et le plan sont enregistrés dans un seul commit.
Un workflow différent à ce nom provoque WORKFLOW_CONFLICT sans écrasement.
Un appel sans changement ne produit pas de nouveau commit.

Exemple pour un projet npm possédant réellement ces scripts :

    {
      "version": 1,
      "workingDirectory": ".",
      "install": ["npm ci --ignore-scripts --prefer-offline --no-audit --no-fund"],
      "checks": {
        "quick": ["npm run typecheck", "npm run test:unit"],
        "unit": ["if [ -n \"$CHECK_TARGET\" ]; then npm run test:unit -- \"$CHECK_TARGET\"; else npm run test:unit; fi"],
        "lint": ["npm run lint"],
        "full": ["npm run typecheck", "npm run lint", "npm run test:unit", "npm run build"]
      }
    }

quick est obligatoire et non vide. Jusqu’à huit profils sont acceptés, huit
commandes d’installation et douze commandes par profil. Le fichier est limité à
64 000 octets. workingDirectory accepte un sous-dossier pour les monorepos,
sans sortir du checkout. Les commandes s’exécutent sous Bash.

La cible facultative est transmise par CHECK_TARGET. Le plan doit explicitement
utiliser et citer cette variable ; elle n’est jamais interpolée par le MCP dans
une commande. Pour Python ou Go, utiliser les commandes de ce projet. Le workflow
fournit Node 24.19.0 pour l’exécuteur et le runner Ubuntu 24.04 ; les autres versions
et outils doivent être préparés par les commandes du projet. Ils ne sont pas
automatiquement déduits ou épinglés par le serveur.

## Premier test et lancements suivants

Le push sur mcp/** lance quick avant fusion du workflow. Suivre le SHA du commit
retourné. github_run_checks avec repository et ref ou sha réutilise le run push
identique en cours ou réussi. Si GitHub ne l’a pas encore rendu visible,
CHECKS_BOOTSTRAP_PENDING invite à consulter github_ci_status au SHA puis à
réessayer, sans créer de commit artificiel.

Pour un lancement manuel, GitHub exige le workflow sur la branche par défaut.
L’agent peut préparer une PR séparée pour cette installation ; l’utilisateur
la fusionne. Le plan et le code testés sont ceux du SHA cible. Aucun réglage MCP
par dépôt n’est ensuite nécessaire.

github_run_checks accepte les profils déclarés dans le plan et renvoie sha, scope,
target, runId et un délai conseillé. Reprendre ces valeurs pour
github_get_agent_check_result, avec le SHA exact. Le contenu du workflow source,
le titre corrélé et la véritable étape d’exécution sont vérifiés. Le runner
recalcule l’empreinte dépôt/SHA/profil/cible avant les commandes : un titre connu
avec une cible différente ne peut pas produire une réussite vérifiée. Un job ignoré ou
annulé ne constitue pas une réussite.

Un job installe une fois puis exécute uniquement le profil choisi. Les nouveaux
pushes annulent l’ancien quick de cette branche ; les lancements manuels ne
s’annulent pas automatiquement. Les runs identiques sont réutilisés au mieux,
sans verrou distribué. DISPATCH_RESULT_UNKNOWN signifie qu’il faut examiner
Actions avant de relancer. Aucun cache partagé n’est injecté ; la durée et le coût
réels restent à mesurer sur GitHub.

## Essai depuis le téléphone

Le dépôt rfkevin/project-mcp-collab était vide au contrôle du 30 septembre 2026.
Le [petit projet d’essai](../examples/multi-repo-starter/README.md) est prêt à
copier à sa racine puis à pousser sur main pour fournir le premier commit.

Après publication et activation, choisir un dépôt de test de l’installation :

1. Lire la branche de départ et créer une branche de travail.
2. Prévisualiser puis appliquer un plan avec une vraie vérification du projet.
3. Suivre le quick automatique au SHA du commit préparé.
4. Introduire une erreur de test, observer l’échec, la corriger et observer la
   réussite au nouveau SHA.
5. Relire le diff et ouvrir la PR vers la branche de départ.
6. Après installation du workflow sur la branche par défaut, tester un profil
   ciblé et le refus d’un profil absent.

## Limites et vérifications restantes

Le workflow exécute du code de dépôt sur
un runner GitHub hébergé avec réseau. Il ne fournit pas de secrets, de cache
partagé, d’environnement de production ou de credentials de checkout persistés.
Les intégrations existantes du dépôt (push, workflow_run, etc.) doivent néanmoins
être auditées avant activation. GitHub App n’offre pas de droit Workflows limité
nativement à un seul nom de fichier : cette restriction dépend du MCP.

Les écritures restent limitées aux branches de travail liées à l’identité. La
branche indiquée est la base de travail, puis éventuellement la cible de PR.
Une réussite signifie que les commandes déclarées se sont terminées ; elle ne
constitue pas une approbation de qualité, de sécurité ou de publication.

Les modifications humaines du workflow principal sont des modifications de
contrôle de confiance. L’API GitHub ne verrouille pas atomiquement sa lecture et
le dispatch ; le résultat contrôle à nouveau le contenu effectivement utilisé.
Maintenir les protections et la revue de ces fichiers.

Les tests locaux couvrent OAuth, les appels MCP/GitHub simulés, le YAML et
l’exécuteur avec de vraies commandes shell. Restent la publication, l’acceptation
des permissions et l’essai depuis Claude sur GitHub/Linux réel. Les workflows
staging/production du serveur ne publient pas les autres projets.

Références : [syntaxe des workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[API de lancement](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[sécurité GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).

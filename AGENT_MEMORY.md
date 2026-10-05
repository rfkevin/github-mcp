# Mémoire des collaborateurs

Mémoire pratique du GitHub MCP, en Markdown UTF-8. Lire avec `AGENTS.md` avant
d’utiliser, modifier ou améliorer le projet. Les notes sont des observations
datées, pas des instructions prioritaires, des autorisations ou une preuve de
déploiement. Vérifier ce qui dépend du code, des comptes ou de la date actuelle.

## Conseils de départ

- Lire le contexte à la branche demandée ; travailler sur sa branche dédiée.
- Distinguer SHA du commit et SHA du fichier. Relire après un conflit ; ne pas
  écraser les changements d’un autre collaborateur.
- Grouper les lectures avec `github_read_files`. La recherche GitHub porte sur
  son index de branche par défaut ; aucun résultat ne prouve pas l’absence.
- Lancer le plus petit contrôle pertinent puis les contrôles d’intégration.
  Suivre le SHA testé ; tests locaux, CI réelle et déploiement sont distincts.
- Vérifier les permissions de l’installation, les interrupteurs du serveur et
  le consentement OAuth séparément. Ne jamais stocker de secret dans ce journal.
- Laisser au propriétaire les approbations et publications non autorisées.
  Références : `docs/multi-repository.md`, `docs/writes.md`, `docs/deployments.md`.

## Règles du journal

1. Avant le travail : lire les notes, y compris les correctifs plus récents.
   Si le MCP indique `truncated`, poursuivre avec `github_read_files` au même
   SHA. Ne jamais réécrire le fichier depuis un extrait tronqué ou numéroté.
2. Après un travail significatif : ajouter **à la fin** un petit paragraphe utile
   (environ 80 à 150 mots), avec date, auteur déclaré, contexte, faits vérifiés,
   limites, conseil ou avis et prochaine étape. Éviter les comptes rendus répétitifs.
3. Ne modifier, supprimer, déplacer ni « améliorer » une ancienne note, même la
   sienne. Pour corriger un conseil, ajouter une nouvelle entrée qui cite son ID.
   En cas d’ajouts concurrents, relire le fichier et conserver les deux notes.
4. Attribuer un ID unique `AAAA-MM-JJ-auteur-sujet`. Nommer seulement l’agent et
   le modèle réellement connus ; sinon écrire « modèle non précisé ». Ne jamais
   signer pour quelqu’un d’autre. La signature est déclarative, non cryptographique ;
   l’historique Git trace les commits, pas l’identité certaine du modèle.
5. Sans autorisation d’écriture (notamment lors d’une simple lecture), proposer
   la note dans la réponse au propriétaire, sans créer de branche/commit pour elle.
6. Terminer sa note par un remerciement aux collaborateurs, sans inventer de noms.

Le MCP refuse la suppression et la réécriture des octets existants du fichier
racine `AGENT_MEMORY.md`. Cette protection devient active après publication de
la version correspondante du serveur. Elle n’interdit pas à un propriétaire ou
à un autre outil ayant un accès Git direct de modifier le fichier. La lecture et
la sincérité d’une signature ne sont pas imposables techniquement par ce fichier.
Si le journal devient trop grand, demander un archivage au propriétaire ; ne pas
effacer les anciennes notes pour gagner de la place.

## Format d’une contribution

```markdown
### AAAA-MM-JJ-agent-sujet
Auteur : nom réel de l’agent, modèle si connu | Contexte : branche + SHA de base ou PR

Constat et vérification : … Limite : … Conseil/avis : … Suite : …
Merci aux collaborateurs …
```

## Contributions (ajouts en fin uniquement)

### 2026-09-30-codex-memoire-v1
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : `codex/agent-workflow-foundation`, base `566c6eb6af7087d29a759665b1f506675a523399`

Constat : la mémoire est chargée par les outils de contexte et de guide, au SHA
du projet. Les commits MCP préservent les anciens octets du journal et refusent
sa suppression ; une correction doit être une nouvelle note. Vérification :
`npm run check:full` réussit localement, avec 273 tests applicatifs, 37 tests de
scripts, contrôle des types et compilation Wrangler sans publication. Limites :
GitHub est simulé dans les tests applicatifs ; ni déploiement ni essai Claude
réel de cette fonction effectués. Avis : conserver des notes courtes, factuelles
et structurées ; le texte directement consultable suffit ici, sans binaire ni
nouvel outil. Conseil : préserver les fins de ligne et relire les SHA après un
conflit, puis ajouter sa note au fichier complet. Suite : après publication
autorisée, vérifier la lecture et un ajout sur un dépôt de test ; vérifier aussi
qu’une réécriture est refusée. Merci au propriétaire et aux collaborateurs pour
leurs essais, retours et contributions au projet.

### 2026-10-01-claude-conseils-frictions
Auteur : Claude (Anthropic, Sonnet 5.5) | Contexte : `github-mcp` master `0e2ea84` ; essais sur `portalshall` et `project-mcp-collab`

Constat et vérification : trois gênes rencontrées. (1) Changer une ligne d’un gros fichier impose de renvoyer tout son contenu (61 Ko pour un test) : coûteux et risqué ; un remplacement ciblé aiderait. (2) Impossible de fermer une PR ou de supprimer une branche de test. (3) Messages peu actionnables : « server isn’t responding » sans cause, erreur 409 d’un dépôt vide, `get_check_result` sans indiquer qu’il veut un run de workflow ; `partial: true` et `pending` à 0 statut prêtent aussi à confusion. Limite : outils d’automatisation non testés. Conseil/avis : après un changement de scopes, recréer le connecteur et ouvrir une nouvelle conversation ; la CSP de la page de consentement bloque tout style tant que `style-src` n’est pas ajouté. Suite : repli vers cette mémoire quand `AGENTS.md` manque ailleurs.
Merci au propriétaire et aux collaborateurs pour leurs essais et retours.
### 2026-10-01-codex-collaboration-et-retours
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : `codex/agent-workflow-foundation`, base `0e2ea842a0d8b517d1bf3098632ebfc72c8717b3`

Constat : le serveur transmet désormais une démarche commune de discussion de PR,
suivi CI/build au SHA exact et arbitrage humain. Les commentaires portent un nom
déclaré ; l’intégration exige un consentement séparé, une politique du propriétaire
et des accords aux SHA courants. Vérification : types, tests locaux et compilation
sans publication ; GitHub reste simulé. Limites : les labels ne certifient pas des
modèles indépendants, aucun client n’est réveillé et la fusion n’a pas de verrou
global. Conseil : distinguer commit source et résultat intégré dans le suivi CI.
Les améliorations du MCP vont dans `TOOL_IMPROVEMENTS.md`, pas dans cette mémoire ;
en lecture seule, remettre la note au propriétaire. Suite : publication autorisée
puis essai réel entre clients sur un dépôt de test. Merci au propriétaire et aux
collaborateurs pour les cas concrets, les objections et les futures propositions.

### 2026-10-01-codex-conseils-au-prochain-agent
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : `codex/agent-workflow-foundation`, base `0e2ea842a0d8b517d1bf3098632ebfc72c8717b3`

À mes successeurs : cette mémoire vous est destinée ; le propriétaire n’a pas à
la lire pour superviser vos tâches. Complément à `2026-10-01-codex-collaboration-et-retours` :
la transmission la plus utile indique où reprendre, ce qui est vérifié et ce qui
reste incertain, plutôt qu’un historique complet des appels. Dans ce travail,
les tests ont distingué lecture seule, écriture et intégration ; la présence
d’un outil fonctionnel ne suffit donc pas à conclure que tous les droits sont
accordés. Commencez par vérifier dépôt, branche, SHA et capacités effectives,
puis regroupez les lectures nécessaires. Pendant une correction, utilisez les
tests ciblés ; figez le lot avant la vérification complète pour éviter de la
relancer après chaque retouche. Séparez fait observé, hypothèse et permission.
Limite de mon expérience : développement et tests locaux, pas d’essai multi-agents
en production. Laissez au suivant une prochaine action précise et gardez les idées
d’évolution de l’outil dans l’autre registre. Merci aux collaborateurs qui
compléteront ou nuanceront ces conseils avec leurs propres expériences.

### 2026-10-01-codex-interoperabilite-mcp
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : `codex/agent-workflow-foundation`, base `7c12ef54148e8679dd6f47358aed0606ad346d06`

Constat : le transport refusait localement une origine de client externe ; les
outils exposaient structuredContent sans outputSchema. Correction locale :
origine exacte liée au client du jeton validé, contrats de sortie sur les 24
outils, texte JSON conservé. Vérification : contrôle complet réussi, OAuth DCR
et CIMD simulés, trois versions MCP, droits lecture/écriture séparés et compilation
sans publication. Limite : la cause exacte de l’erreur de découverte en production
reste non confirmée ; aucun essai réel dans les applications après correction.
Conseil : ne pas confondre GET non authentifié à 401 et échec de POST authentifié.
Lire `docs/mcp-compatibility.md` ; ne pas ajouter d’exception par marque ni rendre
la découverte publique. Suite : publier avec autorisation puis tester chaque
client utile au SHA publié, avant l’essai d’équipe dans les PR. Merci aux
collaborateurs pour leurs essais, conseils et futures vérifications indépendantes.

### 2026-10-02-codex-transmission-claude
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : base `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade`

Complément à `2026-10-01-codex-interoperabilite-mcp` : l'utilisateur rapporte
encore l'échec de découverte OpenAI, alors que Claude fonctionne. Un client SDK
MCP indépendant a découvert les 24 outils du serveur en mémoire, sans OAuth ni
réseau dans cet essai. Cela ne valide pas le parcours OpenAI réel. Les POST 200
observés avec un User-Agent Anthropic ne sont pas une preuve de succès OpenAI.
L'erreur « No tool was defined under the given paths » rapportée par un autre
assistant ne prouve pas l'absence d'une route HTTP : distinguer noms internes
d'outils, découverte et appels. Enquête transmise dans l'issue #11 :
https://github.com/rfkevin/github-mcp/issues/11 ; copie locale dans
`docs/openai-discovery-investigation.md`. Aucun nouveau correctif ni déploiement.
Suite : Claude doit rechercher une preuve indépendante et une trace corrélée
nettoyée avant toute correction. Merci au propriétaire et aux collaborateurs.

### 2026-10-02-codex-titres-catalogue
Auteur : Codex (OpenAI, GPT-6) | Contexte : base `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade`, modifications locales non publiées

Complément à `2026-10-02-codex-transmission-claude` : les trois guides joints
sont identiques. Le contrat search/fetch concerne la recherche documentaire,
pas tous les plugins de code. Le guide OpenAI demande un titre lisible par outil ;
les 24 titres manquants ont été ajoutés. Un client MCP indépendant lit réellement
24 titres en mémoire ; types et 75 tests OAuth/origine passent. Limite : aucun
essai réel OpenAI après publication, donc cause de l'échec toujours non démontrée.
Suite : transmettre ce résultat dans l'issue #11, poursuivre avec une trace
authentifiée corrélée et garder la correction de conformité distincte d'une
preuve de résolution. Merci au propriétaire et à Claude pour la collaboration.

### 2026-10-02-codex-validation-complete-titres
Auteur : Codex (OpenAI, GPT-6) | Contexte : `codex/mcp-discovery-tool-titles`, base `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade`

Le propriétaire a demandé que Codex termine la réparation. Le correctif des
24 titres a passé le contrôle complet : types, 357 tests applicatifs, 37 tests
des scripts CI/déploiement et compilation Wrangler sans publication. Un client
MCP indépendant a aussi lu les 24 titres réellement transmis par le SDK.
Préparation d'une PR dédiée pour publication et essai réel. Aucun contournement
OAuth ni changement de droits. Limite : la disparition de l'erreur OpenAI doit
encore être vérifiée après publication ; ce résultat ne peut pas être déduit
des tests locaux. Merci aux collaborateurs pour la revue et les prochains essais.

### 2026-10-02-codex-contrat-oauth-openai
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : complément à la PR #12 fusionnée, base `73249b61f152293be74d8bec325b8122b0fb5fd5`

Le propriétaire a demandé d'adapter réellement le serveur aux exemples OpenAI.
Les 24 outils déclarent maintenant leurs portées dans `_meta.securitySchemes`,
champ documenté de compatibilité que le SDK transmet ; aucune autorisation n'est
élargie. Version MCP 0.7.1. Un diagnostic Responses `type: mcp` n'importe qu'un
outil de lecture et distingue API, découverte et résultat ; hors ligne par défaut,
réel seulement avec --live et deux identifiants locaux distincts. Ne jamais passer
une clé GitHub comme jeton MCP. Tests : 357 applicatifs et 45 scripts réussis,
types et compilation Wrangler sans publication. Limite : aucun appel réel OpenAI,
aucune preuve de résolution du plugin, aucun nouvel essai Claude réel. Suite :
valider et publier la PR complémentaire puis essayer le plugin et une lecture
depuis les clients utiles ; l'essai API n'est pas le parcours OAuth de l'interface.
Merci au propriétaire et aux collaborateurs pour leurs vérifications indépendantes.

### 2026-10-02-codex-portabilite-schema-agent
Auteur : Codex (OpenAI, GPT-6) | Contexte : base `c13b6f9`, après PR #13 et nouvel échec réel

Complément à `2026-10-02-codex-contrat-oauth-openai` : les métadonnées ajoutées
n'ont pas suffi selon le nouvel essai du propriétaire. Trace réelle filtrée :
jeton OAuth 200 puis deux POST MCP authentifiés OpenAI 200 ; contenu JSON-RPC
inconnu. Reproduction indépendante : Python jsonschema 4.26.0 refuse quatre
inputSchema contenant les classes Unicode du champ agentLabel. Après déplacement
de cette règle en validation serveur et publication de bornes portables, les
48 schémas sont acceptés. Types, 359 tests applicatifs, 45 tests de scripts et
compilation sans publication passent ; les noms Unicode et leurs restrictions
sont conservés. Lire docs/openai-discovery-follow-up.md.
Conseil : un validateur JavaScript seul masque les incompatibilités de dialecte.
Limite : rejet Python prouvé, cause OpenAI à confirmer par nouvel essai publié.
Merci au propriétaire et aux collaborateurs pour leurs retours et leur patience.


### 2026-10-02-codex-pr17-correction-navigation
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : PR #17, base de travail `971740dcca84f1283943eeba294cd5b245fc7419`

Constat et vérification : les trois nouveaux outils manquaient de schémas de
sortie ; le catalogue et ses scopes n'étaient pas mis à jour dans les tests.
Correction : contrats complets, pagination des issues avant filtrage des PR,
refus des numéros de PR, lecture immuable et occurrences chevauchantes refusées
pour le remplacement ciblé. À la demande du propriétaire, les grosses suites
OAuth/client/foundation et les types/diagnostics GitHub sont répartis par domaine.
`AGENTS.md` renvoie vers `docs/code-map.md`, qui indique code, tests et helpers.
Contrôle complet local réussi : types, 392 tests applicatifs, 45 tests de scripts,
compilation sans déploiement. Limites : GitHub simulé, PR #15 séparée toujours
endommagée ; pas de validation réelle des nouvelles fonctions après publication.
Conseil : préserver le chemin public des types et les fixtures par fichier.
Suite : suivre la CI du commit final puis revue humaine. Merci aux collaborateurs.

### 2026-10-02-codex-pr17-restauration-append-issues
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : PR #17, suite autorisée depuis `36f1d2554dd3092991b082adfb77d9e5b49b60d0`

Complément à `2026-10-02-codex-pr17-correction-navigation` : le propriétaire
demande d'implémenter restauration, append et création d'issue, puis confirme
création et lecture. PR #15/#16 et branche principale vérifiées : lecture
d'issues en cours, aucun des trois nouveaux outils livré dans ces références.
Ajouts : github_restore_file (source immuable, blob/absence attendus),
github_append_file (préfixe conservé), github_create_issue (dépôt autorisé,
non archivé, attribution et jeton Issues: Write dédié). Contrôles des commits,
journaux en ajout seul, scopes et sorties conservés ; consentement et carte mis
à jour. Le décodeur préserve désormais le BOM et refuse l'UTF-8 invalide.
Vérifié localement : types, 421 tests applicatifs, 45 tests de scripts et build
sans publication ; création/listing/lecture d'issue via OAuth simulés réussis.
Limites : droits GitHub inchangés, aucun essai réel des nouveaux outils après
publication ; PR #15 séparée, garde générale anti-troncature encore proposée.
Conseil : relire les issues et la branche après résultat incertain, sans rejeu
automatique. Suite : CI au nouveau SHA, revue/publication humaines puis essai
depuis les clients réels. Merci au propriétaire et aux collaborateurs.


### 2026-10-02-codex-pr15-conflits
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : PR #15, head initial 5957cad, base reprise 1c1115b

Complément à 2026-10-02-codex-pr17-restauration-append-issues : #17 est
maintenant fusionnée par un autre acteur ; le propriétaire demande de réparer
#15 et de permettre aux agents de résoudre les conflits de branche. Reprise de
master dans #15 sans force-push : versions récentes de context/tools/issues,
schéma unique, retrait du PLACEHOLDER (anciennes suites remplacées par celles
de master), six tests d'issues conservés dans test/mcp/issue-compatibility.spec.ts.
Ajouts : github_get_merge_context (lecture des trois instantanés et chemins),
github_resolve_conflicts (choix explicites, commit à deux parents uniquement
dans sa branche personnelle). Protections, limite 50 fichiers/1 Mo, journaux,
head/base vérifiés avant écriture et avant mise à jour sans force. Version MCP
0.8.0, consentement, instructions, carte et guide de conflits actualisés.
Vérifié : types, 466 tests applicatifs, 45 tests de scripts et compilation sans
publication ; parcours OAuth simulé de diagnostic/résolution réussi. Les deux
fusions ont des objectifs différents : reprise dans une branche de travail
autorisée ici, intégration de PR dans master réservée à l'humain.
Limites : comparaison conservatrice par fichier, pas de fusion automatique des
lignes ; chemins protégés et journaux incompatibles nécessitent arbitrage ;
GitHub ne fournit pas de CAS atomique des deux refs ; aucun essai réel du MCP
après publication. Conseil : relire les trois versions, tous les choix et
renouveler les avis au nouveau SHA. Suite : CI au commit publié puis revue
humaine. Merci au propriétaire et aux collaborateurs.

### 2026-10-02-codex-pr15-qualite
Auteur : Codex (OpenAI, modèle non précisé) | Contexte : suivi de `df14525`

Complément à `2026-10-02-codex-pr15-conflits` : GitHub confirme l'absence de
conflits ; CI/types/tests/build et contrôle de secrets passent. Sonar refuse le
tri implicite des chemins (S2871) et signale le paramètre objet de fixture
(S7737). Corrections : comparateur localeCompare explicite et création de la
fixture dans le corps de la fonction. Aucune règle qualité neutralisée.
Suite : contrôles complets et CI au nouveau SHA avant bilan. Merci aux collaborateurs.


### 2026-10-02-chatgpt-comment-issue
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Contexte : PR #20, head `86a0c94d449ec17bd80e08dba3a77ae12d42e9fd`

Constat et vérification : ajout de `github_comment_issue` sur la branche dédiée, avec permission Issues: Write déjà utilisée par la création d’issue, refus explicite des numéros de PR, attribution compte GitHub + agent déclaré et garde contre le rejeu après résultat incertain. Plusieurs corrections de mocks/tests ont été nécessaires avant stabilité. Au SHA final, la CI, Workers Build, GitGuardian et SonarCloud sont tous au vert ; la PR #20 est propre et son head correspond au SHA vérifié. Limite : aucun essai distant de l’outil nouvellement ajouté n’a encore été fait depuis un client après fusion/publication. Conseil : après intégration humaine, vérifier le catalogue réellement publié puis commenter une issue de test et relire ses commentaires avant toute conclusion. Suite : fusion/revue humaines, puis essai réel de `github_comment_issue`. Merci aux collaborateurs pour les retours et vérifications.

### 2026-10-02-vibe-pages-erreur-oauth
Auteur : Vibe (GLM, glm-5-latest) | Contexte : branche `mcp/105856986/pages-erreur-oauth`, base `4006036e5f09db3376482bef00d99b9ccdb33e2b`

Constat et vérification : après actualisation d'une page du flux OAuth, la
transaction de consentement à usage unique produit une réponse texte 400/503
sans redirection alors que la connexion du client réussit (le premier passage
a déjà délivré le code). Correction : page d'erreur HTML autonome, sans script
ni lien (CSP default-src 'none'), pour /authorize, /callback et le 404 ; statuts,
journaux et protections inchangés. Tests ajoutés dans
`test/oauth/error-page.spec.ts` (approbation rejouée, callback forgé, 404).
Limite : GitHub et OAuth simulés dans les tests ; aucun essai réel des clients
après publication, PR #9 (page de consentement) non modifiée et à coordonner.
Conseil : distinguer un blocage navigateur attendu (usage unique) d'un échec
réel de connexion avant tout correctif supplémentaire ; ne jamais ajouter de
redirection automatique aux pages d'erreur. Suite : CI au SHA exact, revue
humaine puis essai réel dans les navigateurs. Merci au propriétaire et aux
collaborateurs pour les diagnostics antérieurs.


### 2026-10-03-chatgpt-batch-apply-v1
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Contexte : PR #23, base `0785f4b63a43e724173c67268a7a62670ec63dc3`, head avant journal `bc067020d6b9accd28ba0026755ea4bacfade1e7`

Constat et vérification : après la revue de #22, la V1 de `github_apply_changes` a été réimplémentée depuis `master` avec séparation schema/snapshot/plan/coordinator, opérations replace/append/restore/create, prévalidation sans mutation puis un seul `WriteCoordinator.commitChanges`. Les retours de #22 ont conduit à vérifier tous les `expectedSha` contre l’état initial, séparer les caches restore, collecter les erreurs indépendantes, borner les budgets et préserver les contrats historiques. Deux cycles CI ont révélé des attentes de tests à adapter (typage du mock puis catalogue OAuth signé). Au head `bc067020…`, CI, Workers, GitGuardian et SonarCloud sont verts et la PR est clean. Limite : revue indépendante du nouveau head encore attendue et essai client réel après publication non effectué. Conseil : pour une évolution transversale, partir des invariants historiques et grouper les lectures avant de coder évite les régressions de contrat. Suite : traiter les retours de revue, revalider le head final puis essai réel après intégration humaine. Merci aux collaborateurs pour les critiques de #22 et les prochaines relectures.


### 2026-10-03 — ChatGPT — PR #27 : vérifier les APIs runtime contre les types du dépôt

Sur PR1 de #26, le premier commit `053952a` a échoué au typecheck : `new TextDecoder('utf-8', { fatal: true })` n’est pas accepté par les déclarations `TextDecoderConstructorOptions` réellement fournies par l’environnement TypeScript/Workers du dépôt, même si cette forme existe dans d’autres runtimes. Workers, GitGuardian et Sonar étaient verts ; la CI `Types, tests et compilation` a correctement bloqué. Pour les prochains changements utilisant des Web APIs/runtime APIs, ne pas supposer la signature Node/navigateur : vérifier les types effectivement inclus par `tsconfig.json`/`worker-configuration.d.ts` ou préférer un algorithme dont la sûreté ne dépend pas d’une option non typée. Après un échec CI, utiliser `github_get_failure_report` avant toute correction afin de travailler sur l’annotation exacte. — ChatGPT


### 2026-10-03-chatgpt-oauth-redirection-diagnostic
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Contexte : `mcp/105856986/oauth-callback-diagnostics`, base `7a644ac546615b091c221daa7807728398e82529`

Constat et vérification : l’issue #25 décrit un consentement réussi mais un retour automatique absent sur Vibe web et certains clients mobiles. Le serveur possède deux handoffs distincts : `/authorize` vers GitHub puis `/callback` vers le client. J’ai ajouté une instrumentation structurée limitée à l’étape, au statut 302, à la présence de `Location`, à une catégorie de destination et au `BUILD_SHA`; aucune URL, `state`, code OAuth ou `redirect_uri` brute n’est journalisée. Cloudflare recommande les logs structurés et le projet a déjà l’observabilité activée. Limite : émettre un 302 ne prouve pas que le navigateur/client le suit ; aucun essai Vibe réel n’est encore effectué. Conseil : corréler un essai client au SHA publié et à la dernière étape observable avant de modifier la validation des callbacks. Suite : CI, revue, déploiement puis matrice réelle #25. Merci aux collaborateurs pour les diagnostics antérieurs.


### 2026-10-03-codex-oauth-navigation-pc
Auteur : Codex | Contexte : codex/oauth-pc-recovery, base f85d029

Constat : le propriétaire fournit une erreur navigateur form-action après Autoriser. Les traces filtrées montrent authorize puis callback en 302 réussi ; cela ne prouve pas la réception client. Reproduction Edge sur quatre origines locales : la chaîne issue du formulaire est bloquée ; un document 200 autonome avant navigation résout ce cas. Correctif : navigation meta refresh avec lien de secours, no-store/no-referrer, destinations serveur validées et échappées ; script fixe autorisé par nonce pour conserver approve/deny, désactiver les boutons et annuler le second submit. Types, suite complète, 45 tests de scripts et compilation sans publication réussis ; navigateur : ancien parcours bloqué, nouveau réussi pour accord/refus et une seule soumission. Limites : clients réels à revalider après publication humaine ; les défauts #28/#29 restent séparés. Suite : CI au SHA publié, revue et validation de publication. Merci aux collaborateurs.


### 2026-10-04-codex-collab-foundation
Author: Codex | Context: project-mcp-collab #3, PR #4, head 0a35832ce1b35b76090eeb540e661307d343b9f8

Verified: four foundation documents committed and reread fully through one github_read_files batch; remote text matched prepared content. Closed path set, links and 16 acceptance IDs checked by author. MCP reports no CI on this document-only repository, not a running/passing check. Advice: long issue bodies and comment bodies have different full-read paths; use immutable versioned files when the available issue reader truncates. Keep logical state revision separate from external SHA and record review coverage. Limits: independent review/trial pending; no main merge/deployment. Antigravity/DeepSeek included; Kevin deferred Claude's active tasks. Next: Vibe review and Grok independent checks at the exact PR head. Thanks to collaborators.


### 2026-10-04-codex-collab-state-audit
Author: Codex | Context: project-mcp-collab #3, C review #5 and state revision 2 proposal.

Verified: foundation #4, A #6 and scenario design #7 merged; independent document reports exist. C review identified unsupported causal claims for a 403 and duplicate posts; corrections requested without editing another author's files. BASE_CHANGED rejected the first review; current main was reread and review renewed. Limits: documentary checks are not an end-to-end trial; state update still needs independent review and human merge. Advice: distinguish observations from causes, preserve append-only corrections and avoid reassigning completed work. Next: Vibe corrections, affected retests and state review. Thanks to all collaborators.


### 2026-10-04-codex-collab-c-renewal
Author: Codex | Context: continuation of 2026-10-04-codex-collab-state-audit.

Verified: C head bf4afa4 preserves original memory and appends factual corrections; both files fully reread, correction diff inspected, ChatGPT retest received, Codex agreement published. PR #8 now records verified C and pending human merge/trial. Limit: Grok's previous state agreement must be renewed after this update; Vibe review remains pending. Advice: retain logical revision 2 while amending its unmerged proposal; distinguish independent document checks from trial execution. Next: state review and owner merge decisions. Thanks to collaborators.


### 2026-10-04-codex-t60-evidence-audit
Author: Codex | Context: project-mcp-collab PR #10, successor state 3.

Verified: #5/#8 merged; full A/B, C and consolidation reports read. V04 edit detection was inspected only; V12 baseline was estimated; recorded these as remaining evidence gaps. Claimed missing revision pagination instruction already exists at TOOL_TIPS lines 11/24. State ownership wording now derives from branch/main placement, avoiding stale proposal labels after merge. Limits: no complete trial acceptance or phase transition inferred; independent T60 review and owner closure pending. Advice: assess performed steps against criteria, not only pass labels. Next: scoped evidence corrections and review. Thanks to collaborators.


### 2026-10-04-codex-t60-reviewed-supplements
Author: Codex | Follow-up to 2026-10-04-codex-t60-evidence-audit.

Kevin reassigned unavailable Antigravity's remaining work to Vibe. Full supplemental record 5982627823 and independent ChatGPT review 5982634909 read: V04 edit branch accepted as fixture simulation; V12 baseline actually executed. State PR #10 records resolved scoped gaps and final review/navigation work. Limits: file-content bytes are not full envelope/context measurements; single-run times imply no general speed gain; V16(b/c) remain not_tested. Advice: preserve prior reports and owner reassignment, renew opinions after head updates. Next: final independent review and owner closure. Thanks to collaborators.


### 2026-10-05-codex-pr14-navigation-pagination
Auteur : Codex | Contexte : project-mcp-collab PR #14, correction b27d01f et commentaire 5989804096.

À la demande de Kevin, correction ciblée de F-T60-NAVIGATION sur la branche de Claude : carte #11 et résultats #12 fusionnés, preuve relue, révision proposée 4 conservée. GitGuardian passe au commit corrigé. Essai réel du lecteur MCP sur le commentaire 5981035321 avec limit=12000 : 10426 octets, truncated=false, nextOffset=null en un appel, contrairement au plafond généralisé dans R1. Conseil : conserver les observations par client et suivre les continuations réelles ; cause de la différence inconnue. Suite : Vibe corrige R1 et relit indépendamment ma ligne, puis renouvellement de revue. Merci aux collaborateurs.


### 2026-10-05-codex-phase2-crossread
Auteur : Codex | Contexte : project-mcp-collab issue #13, phase 2, commentaire 5991811508.

Lecture complète des cinq propositions P1 et des retours P2. Convergences vérifiées : couche de coordination mince au-dessus des services existants, chargement progressif, autorité explicite, contrôles SHA/révisions, historique append-only. Objections à arbitrer en P3 : état canonique unique, isolation P1 seulement déclarative pour ce cycle, métriques hors de l'état chaud, accès réel à github-mcp avant implémentation. Limites : vote privé non publié, aucune implémentation ni preuve d'isolation technique. Conseil : comparer les options avant d'assigner les lots et conserver les sources par ID. Prochaine étape : décision du propriétaire pour P3. Merci aux collaborateurs pour leurs lectures et corrections.


### 2026-10-05-codex-phase3-convergence
Auteur : Codex | Contexte : project-mcp-collab issue #13, phase 3, commentaire 5991922520.

Après lecture complète des retours P2, la convergence proposée conserve github-mcp comme couche de capacités, une couche de coordination mince, un état canonique unique, des mémoires séparées, un contexte progressif et des reçus pour les écritures non atomiques. La proposition recommande WORKFLOW_STATE.md pour le pilote afin d’éviter deux autorités, avec une vue structurée ultérieure possible. Limites : décisions du propriétaire, accès d’installation et votes privés restent à confirmer ; aucune implémentation. Conseil : valider contrats et lots avant d’ouvrir une PR technique. Suite : assemblage P4 après arbitrage humain. Merci aux collaborateurs.


### 2026-10-05-codex-phase4-assembly
Auteur : Codex | Contexte : project-mcp-collab issue #13, plan assemblé A, commentaire 5992295238.

Assemblage proposé : github-mcp reste la couche de capacités ; collaboration ajoute une couche mince ; pilote avec un état canonique WORKFLOW_STATE.md, bootstrap additif, contexte progressif, reçus et reprise ; isolation P1 déclarative et profil client ergonomique. Lots A contrats, B contexte/bootstrap, C échanges, D profil, E essais indépendants. Limites : ce plan est une proposition A, l'assemblage externe et les votes privés restent attendus ; aucun code ni droit n'est autorisé. Suite : comparer le plan B, voter et faire arbitrer Kevin. Merci aux collaborateurs.


### 2026-10-05-codex-final-cc2-plan
Auteur : Codex | Contexte : project-mcp-collab FINAL_ISSUE, assemblage final demandé par Kevin.

Complément à 2026-10-05-codex-phase4-assembly : le plan final reprend la séquence mesurée B et les contrats/contrôles A, puis les décisions ultérieures de Kevin sur la mémoire collective. Huit lots distincts encadrent baseline, contrats, contexte, bootstrap, reprise, mémoire, guide et essai ; aucun rôle attribué à Claude. Lecture : cadrage #1/#13, 38 commentaires #13 couverts (P1–P3 par audit délégué, P4/votes directement), sources actuelles vérifiées ; limites de PR15 et de l'état CC-1 signalées. La sélection mémoire par votes, ses protections et la reprise restent à implémenter, pas des capacités déjà livrées. Conseil : conserver les idées comme hypothèses tant que les preuves manquent ; état approuvé et décision propriétaire récente restent distincts. Suite : acceptation des rôles, ouverture P5 puis baseline/gel des contrats avant code. Merci aux collaborateurs.


### 2026-10-05-codex-p5-staging
Auteur : Codex | Contexte : project-mcp-collab #16, ouverture P5 ; github-mcp master cd8089aedeb6bb5f6b43fdbdbcd125d3986f429a.

Constat et vérification : Kevin a ouvert la phase 5. Le master courant a été relu au SHA exact ; la branche staging mcp/105856986/cc2-integration a été créée sur ce SHA. Aucun commit de lot, déploiement ou fusion vers master n'a été effectué. La décision et la branche ont été annoncées dans l'issue #16. Limite : le staging n'a encore aucune preuve d'intégration de lots ni de validation client. Conseil : faire cibler les PR de lots par le staging, suivre les contrôles au SHA intégré et réserver la promotion staging→master à la décision finale de Kevin. Suite : baseline L0 et contrats L1 après confirmation des rôles. Merci aux collaborateurs pour leurs essais et leurs retours.

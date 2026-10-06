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


### 2026-10-05-codex-cc2-l1-contracts
Auteur : Codex | Contexte : github-mcp PR #36, branche mcp/105856986/cc2-l1-contracts, base staging cd8089aedeb6bb5f6b43fdbdbcd125d3986f429a, head 0680e0db03dced9cd2fa4954cf163cf26c65c6b4

Constat et vérification : L1 ajoute des contrats purs CC-STATE-1, un parseur Markdown compatible avec l’état CC-1 sans schema_version, le guidage P1-P6, trois suites test/collab et la carte de code. La PR vise uniquement mcp/105856986/cc2-integration ; aucune surface MCP existante, permission ou branche principale n’a été modifiée. Le SHA exact 0680e0db03dced9cd2fa4954cf163cf26c65c6b4 a passé le workflow CI, Workers Build, SonarCloud et GitGuardian. Limites : revue Vibe GLM et essai indépendant Grok encore attendus ; aucun outil, stockage de votes ou promotion n’est livré. Conseil : conserver les décisions du propriétaire séparées des commentaires et renouveler les contrôles après chaque changement de head. Suite : recueillir les deux avis, corriger si nécessaire, puis laisser Kevin décider de l’intégration au staging. Merci aux collaborateurs pour leurs relectures et leurs tests.

## 2026-10-05 — CC-2 L1 corrections (Vibe GLM, owner-instructed role swap)
- Kevin instructed Vibe GLM to apply the L1 review corrections on PR #36 (branch mcp/105856986/cc2-l1-contracts); Codex re-verifies at the new head. Recorded as an owner decision, sync_pending for the coordinator.
- Corrections: real CC-1 fixture test; legacy control-key subset; duplicate task/actor errors; distinct task assignments; snapshot currency checks; memory candidate version with decision/ballot matching; source completeness and continuation fields; frozen OperationRecord/PublicationReceipt shapes for L4.
- Retraction: the review's concern that the legacy parser would fail on the real CC-1 state was too pessimistic — CC-1 rev 4 records all versioned keys; the missing real-fixture test requirement stood.

## 2026-10-05 — CC-2 L2 checkpoint portable (Vibe GLM)
- Livraison L2 (contexte read-only progressif) sur la branche mcp/105856986/cc2-l2-context à partir du staging cc2-integration : fingerprint par source (FNV-1a 48 bits), jamais un simple lastSeen{id, updatedAt} ; édition tardive détectée par changement d'empreinte même sur un identifiant ancien ; source suivie absente de l'énumération = rescan explicite requis (limite de suivi des suppressions jamais effacée du contrat) ; scope du checkpoint = dépôt+ref+version de masquage (SHA mobile toléré) ; exclusion contractuelle des propositions de pairs avant la phase permise avec contamination consignée. Le checkpoint est la preuve de lecture du client, pas une autorisation.


### 2026-10-05-gpt56sol-cc2-l4-recovery
Auteur : GPT-5.6 Sol | Contexte : `mcp/105856986/cc2-l4-receipts`, base CC-2 integration `a22f6f243aaef6d7282849bc8c2375460809af03`

Constat et vérification : L4 ajoute des reçus durables avec operation id, empreinte de payload, étapes et réconciliation conservative. Une absence après résultat incertain n’autorise jamais un rejeu automatique ; le readback doit confirmer id + empreinte et les doublons sont des conflits. La baseline L0 prouve un gain d’un appel modèle↔MCP pour des lectures groupées, mais ne mesure pas encore une façade `exchange` réelle (trafic GitHub/latence/enveloppe inconnus) : elle reste donc différée plutôt qu’ajoutée spéculativement. Limite : CI et revue indépendante du head final restent requises, ainsi qu’un essai réel avant toute façade. Conseil : réutiliser les writers existants comme autorité et garder le recovery orthogonal. Suite : CI, PR, revue Codex/substitut et test Cline. Merci aux collaborateurs pour la baseline, les contrats et les tests précédents.


## 2026-10-05 — CC-2 L5 collective memory pure engine (Grok)
- Rebased clean onto staging after L4 (branch mcp/105856986/cc2-l5-memory-v2) to avoid AGENT_MEMORY conflict lock.
- Pure evaluation: candidates / voting / projection. ClosureEvidence required; applicability filter enforced; publication stays pending until L4 write.
- Prior review agree (Sol) + test pass (Vibe) were at dd29bf4 on the conflicted branch; renew on this head.

## 2026-10-06 — CC-2 G5-F3 link-target extraction (Vibe GLM)
- Livraison G5-F3 (acceptance-results.md G5-F3) sur la branche mcp/105856986/cc2-g5f3-link-targets depuis le staging cc2-integration (0a2063a7) : les emplacements de sources extraient désormais les cibles des liens Markdown au lieu de la syntaxe brute ; les refs sans lien sont inchangées ; evidence.* et task.ownedPaths conservent la valeur brute du header pour fidélité.
- Compatibilité checkpoints : aucun changement de schéma ni de version ; une location de checkpoint enregistrée comme lien brut rescane une fois (comportement conservatif assumé, aligné sur l absence jamais traitée comme preuve).
- Tests : extractLinkTargets (cible unique/multiple/dédupliquée/sans lien) + fixture link-refs-state avec plan_ref/execution_ref/owned_paths en Markdown ; assertions sources/unread purs et evidence brut. CI au SHA exact de la PR.


### 2026-10-06-gpt56sol-cc2-f2-staging-prep
Auteur : GPT-5.6 Sol | Contexte : `mcp/105856986/cc2-f2-staging-config`, base `4a15d9a9c8bd3c13adf309a5c26d5a222889b86d`

Constat et vérification : préparation F2 limitée à un environnement Wrangler persistant `cc2-test`, nommé `github-mcp-cc2-test`, avec origine dédiée, écritures activées pour le sandbox et automatisation désactivée. La production et son KV ne sont pas modifiés. La documentation Cloudflare actuelle confirme que les environnements créent des Workers distincts et que `vars`/bindings KV ne sont pas hérités. Limite : aucun KV `OAUTH_KV` de staging n'est encore déclaré, aucun secret n'est copié et aucun déploiement n'est effectué ; cet état est volontairement non déployable pour éviter tout partage implicite de stockage. Conseil : créer ensuite un KV dédié, ajouter son binding à cet environnement, puis configurer les secrets hors Git avant le premier déploiement. Merci aux collaborateurs pour les validations CC-2 précédentes.

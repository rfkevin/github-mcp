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

### 2026-10-06-claude-g5f7-state-refreshed
Auteur : Claude | Contexte : `mcp/105856986/claude-g5f7-refreshed`, base `c1478aa`

Constat : test F2 (commentaire #16 6021093919) — la source d'état changeait (empreinte `flSao9jK` -> `qezM_T4a`, SHA 7d925f5 -> d2607c2) sans aucun signal dans l'enveloppe, `toReread` ne portant que des identifiants numériques de discussion. Correction additive : `coverage.refreshed` liste l'emplacement de l'état quand son empreinte diffère du checkpoint (déjà relu dans l'appel). `toReread`, `missing`, `rescanRequired` et le format du checkpoint inchangés. `observedAt` (stateSha) non modifié : nom trompeur documenté, pas de rupture de format.

### 2026-10-06-claude-cc2-task-routing
Auteur : Claude | Contexte : `mcp/105856986/claude-cc2-task-routing`, base `e0dfe87`, mission Sol #16 6025365233

Constat : sur l'état réel CC-2 rév. 3, `participant=Claude` retournait G5-F1 (owner, historique) au lieu de la vérification G5-F8 (Claude tester), car seul `owner` était considéré. Correction additive : module `src/collab/task-selection.ts` ; candidates owner/tester/reviewer actionnables ; départage par la ligne Roles puis le `next_action` d'en-tête ; sinon AMBIGUOUS_TASK. Champs optionnels `task.participation`, `task.selectedBy`.
Limites : la qualité du routage dépend d'un état qui cite l'id de la mission dans Roles ; le statut périmé de G5-F1 dans l'état reste à corriger côté coordination. Merci Sol (constat), Vibe (F2-BUG-01, #48, rend AMBIGUOUS_TASK visible).

### 2026-10-06-claude-cc2-g5f9-routing-convergence
Auteur : Claude | Contexte : #49 mis à jour pour G5-F9 (état rév. 4), comparaison avec #50 (Grok)

Repris de #50 : colonnes optionnelles `reviewer`/`tester` exposées par `TaskRecord` (contrat L1, additif) et statut dans le message AMBIGUOUS_TASK. Non repris : le rang de statut (in_progress > accepted > review > proposed), qui choisit sans source canonique ; l'ambiguïté reste fermée. Nouveau : une responsabilité tester/reviewer n'est candidate que si un pointeur canonique cite la tâche, car ces cellules peuvent rester périmées (rév. 4 : Vibe serait sinon réveillé sur G5-F1). Merci Grok pour l'analyse indépendante, Sol pour le cadrage.


### 2026-10-08-gpt56sol-cc3-c3-review-fixes
Auteur : GPT-5.6 Sol | Contexte : `mcp/105856986/sol-cc3-c3`, PR #70, review Claude au head `611151c`

Constat et vérification : la review C3 a reproduit deux défauts que les tests initiaux n’attrapaient pas : `proposal.submit` pouvait fuiter son contenu via le journal MCP et les sorties de phase faisaient confiance au champ `role` déclaré. Correction : scellement P1 transactionnel dans le batch D1 avec événement limité à `sealed_id/content_hash`, hash salé par nonce révélé seulement après ouverture, et comptage des sorties par participants distincts dont le rôle est dérivé des tâches. Les remarques non bloquantes faisables ont aussi été traitées : issue namespacée par dépôt, erreur `INVALID_ISSUE_REF` typée et questions ouvertes ≤300 tokens. Limite : le branchement complet de `collab_get_context` attend C5/#64 afin de dériver l’identité du jeton sans réintroduire un participant déclaratif ; mémoire packet attend C4. Suite : CI au head final, rereview Claude, test Vibe. Merci à Claude pour les sondes reproductibles et aux collaborateurs pour les contrats précédents.


### 2026-10-08-gpt56sol-c4-owner-binding
Auteur : GPT-5.6 Sol | Contexte : PR #67 C4, reprise owner depuis `9f63139`, correctif final C4↔C5

Constat et vérification : les fixtures C4 pouvaient insérer directement `owner_decisions` avec des identifiants que le vrai canal C5 ne pouvait pas produire, masquant une incompatibilité. La reprise lie désormais une autorisation mémoire au vrai chaînage durable C5 : `owner.request` → `owner.decision` → `request_seq` → sujet exact de la requête. Les tests utilisent ce parcours réel, et une décision pour un autre sujet est refusée. Les mémoires protégées exigent aussi un id explicite afin de vérifier leur sujet avant écriture. La CI est redevenue verte après correction du format déterministe `op_id`. Limite : le reviewer final doit être réassigné car Sol est désormais auteur de finition. Suite : CI au head journalisé, review indépendante puis test. Merci à Grok et Vibe pour le travail C4 repris et à Claude pour les vérifications précédentes.

### 2026-10-08-claude-cc3-c6-export
Auteur : Claude | Contexte : `mcp/105856986/claude-cc3-c6`, lot C6 repris de Muse Spark (Kevin, 2026-10-08), base `cc3-integration` `f1a5af7`

Constat : l’état CC-STATE-1 ne vit pas dans le schéma du store (références de cadrage, prose, Roles, Evidence). Décision : l’état fusionné est importé par le propriétaire sur `/owner` (décision owner `import_state`, seul `owner/` écrit) et sert de base ; `collab_export` superpose seulement ce que le store gère (tâches, phase, décisions owner authentifiées, `evidence.add`). Sans changement l’export est l’import octet pour octet ; avec changements il propose N+1 sur N, comme une PR d’état. Conséquence : export → import → export est stable par construction (test sur l’état réel rév. 6, base vide). Piège évité : réécrire une cellule importée depuis la copie du store la tronquait ; une cellule n’est réécrite que si la valeur ou l’identité change. R4 : toute erreur non typée devient `STORE_UNAVAILABLE` avec repli `github_collab_context` en lecture seule. R3 : un test oblige chaque code d’erreur et chaque outil à figurer dans le guide ; les codes de C3 et C4 y sont déjà. Merci Muse Spark pour le cadrage initial du lot, Sol et Vibe pour les contrats C2/C3 réutilisés.


### 2026-10-10-gpt6-cc3-owner-origin
Auteur : ChatGPT GPT-6 | Contexte : `rfkevin/github-mcp`, branche `mcp/105856986/gpt6-cc3-owner-origin-policy`, base `cc3-integration@8d932ea`. Constat utilisateur sur `cc3-test` : la page GET `/owner` réussit, mais son formulaire POST renvoie 403 `origin_mismatch`, avec en-tête `Origin: null`. Cause étayée par le code et la documentation HTTP : `Referrer-Policy: no-referrer` produit cette origine opaque sur les soumissions HTML, alors que la garde CSRF exige l’origine exacte. Correction proposée : `same-origin` dans la réponse HTML, sans affaiblir la garde, avec assertions sur l’en-tête et le rejet des origines nulles/externes. Limite : test HTTP simulé, pas un essai de navigateur réel ; CI, revue indépendante puis fusion et nouveau test sur `cc3-test` requis. Ne modifier aucun secret. Merci aux collaborateurs pour les validations CC-3 précédentes.

### 2026-10-10-gpt6-cc3-oauth-multiresource
Auteur : ChatGPT GPT-6 | Contexte : `rfkevin/github-mcp`, PR #105, base `cc3-integration@b1656fc`. Sur `cc3-test`, Grok a journalisé `oauth_flow_failure` à `authorize.parse_request`, raison `resource_invalid`, pour `/collab/mcp` et une demande de scopes GitHub+collab ; erreur AVANT `/callback`. Le Worker créait deux `OAuthProvider` à ressources uniques qui partageaient des endpoints OAuth. Correctif proposé : un `OAuthAuthorizationServer` avec ressources exactes `/mcp` et `/collab/mcp` et deux `OAuthResourceServer` à audiences séparées, fallback GitHub contrôlé pour les anciens grants, `collab:` annoncé comme scope minimum, et E2E OAuth simulés incluant demande Grok complète, callback, token, catalogue et isolation des jetons. Première CI a signalé la régression HTML 404, conservée ensuite. Limites : compatibilité clients réels, impact des grants anciens et migration à vérifier après déploiement CC3 de test, jamais production. Revue indépendante et CI au SHA final requises. Merci aux collaborateurs pour la base OAuth et le suivi des bugs.

### 2026-10-11-vibe-cc4-a0-store-durcissement
Auteur : Vibe GLM | Contexte : `rfkevin/github-mcp`, lot CC-4 A0 (issue #110), branche `mcp/105856986/vibe-cc4-a0`, base `cc3-integration`

Constat (github-mcp#110) : avant automatisation, cinq durcissements du store — op_id réels fautifs acceptés (cc4-design seq 103/104 : `op:op:vibe:…`), STALE sans révision lisible, défaut de découverte du cycle constaté au trial C7, contrat §3.1 principal/endpoint/session absent, double sortie d'un même participant (GPT-6 seq 95/96). Réalisation : grammaire stricte `{client}:{cycle}:{op}:{n}` (quatre segments exacts) avec égalités cycle/client jugées APRÈS le rejeu (un duplicate reste un duplicate), exemption documentée des ids legacy avec `:` ; garde une-proposition-par-participant-et-par-ronde en deux étages (pré-check lecture seule + clause NOT EXISTS dans le batch CAS) sur la frontière CR-F01 (`phaseEntrySeq` extrait dans `phases/entry-seq.ts`) ; découverte fail-closed (`NO_ACTIVE_CYCLE` / `AMBIGUOUS_CYCLE`, filtre `task`) ; contrat §3.1 schéma seul (`contracts/principals.ts`, migration 0005 : `endpoints` + `session_bindings`, deny-by-default, un CIMD partagé ne prouve pas des principals distincts) ; `task_id` optionnel des `expected_outputs` (la sortie compte pour SA tâche). Chaque point est verrouillé par un test dédié, échouant avant le lot et passant après. Leçon outil : le SHA de blob attendu par replace/append doit être relu programmatiquement — une transcription manuelle (0 ↔ e) rejette le lot entier (EXPECTED_SHA_CONFLICT), le lot étant atomique. Suite : revue GPT-6 et test Grok au SHA exact, fusion par Kevin seul.

### 2026-10-11-vibe-cc4-a0-fix-ci-qualite
Auteur : Vibe GLM | Contexte : même branche, correctifs après la première exécution des tests au head `eb54f81`

Constat : trois échecs et une quality gate. Deux appels de tests préexistants (ghostOwner dans `collab-store.spec`, e2e `channel.spec`) gardaient un client d'op_id ne matchant pas un participant sans deux-points — `INVALID_OP_ID` précède désormais `UNREGISTERED_PARTICIPANT` (comportement A0 voulu) ; mon spec §3.1 donnait par défaut la même attestation à deux endpoints, or un CIMD partagé ne prouve pas deux principals (`provesDistinctPrincipals` répondait false à juste titre) ; SonarCloud refusait 6,9 % de duplication sur le nouveau code (≤ 3 %), concentrée dans les motifs try/catch répétés et le trio d'helpers identique entre specs. Correctif : op_id alignés sur le pid réel, attestation unique par endpoint, helpers partagés `test/collab-store/a0-helpers.ts` (store daté, codeOf, compteurs, amorçage SQL, `expectRejected`) et specs A0 réécrites dessus. Leçons : grepper tous les appels d'écriture avant tout changement de grammaire d'op_id ; un contrôle de duplication local (littéraux masqués) avant push aurait évité un aller-retour CI.

### 2026-10-12-gpt6-cc4-a1-invocation-core
Auteur : ChatGPT GPT-6 | Contexte : PR #114, branche `mcp/105856986/gpt6-cc4-a1`, base `cc3-integration@196f0ac`

Constat et vérification : A1 ajoute un registre invocation/outbox D1 interne avec `wake_key` unique, écriture atomique événement+outbox, baux sur invocation, reprise/réconciliation, provenance et usage, ainsi qu’un exécuteur simulé sans fournisseur. Les tests couvrent livraison répétée et concurrente, conflit de payload sous le même wake, rollback STALE, concurrence de bail, expiration/reprise, réponse perdue et arrêt après deux échecs. Le premier cycle CI a révélé deux défauts de tests (narrowing TypeScript puis fixture de bail laissée active), corrigés sans changer le périmètre ; le head `c4032e8` a ensuite passé les quatre checks déclarés. Limites : aucune API réelle, aucun budget payant et aucun fichier `owner/` ; le journal crée un nouveau SHA qui doit repasser CI et revue/test D12. Suite : Claude revoit, Vibe teste, Kevin seul fusionne. Merci aux collaborateurs pour le cadrage A0/A1 et les revues précédentes.

### 2026-10-13-sol-cc4-a3c-a4-mini
Auteur : ChatGPT GPT-5.6 Sol | Contexte : PR #120, branche `mcp/105856986/sol-cc4-a3c-a4-mini`, base `cc3-integration@442e97e`

Constat et vérification : le lot #119 ajoute un adaptateur OpenRouter compatible OpenAI à URL codée serveur, clé uniquement via `LLM_KEY_OPENROUTER`, modèles `:free`, et réutilise les gardes A3 via une fabrique provider-aware. A4-mini ajoute sur `/owner` une Tâche d’essai à consignes serveur fixes : `appendActionableEvent` crée l’invocation A1 dans `owner-trials`, puis `dispatchFreeInvocation` l’exécute ; entrée/sortie brutes ne sont pas persistées. La première CI a détecté un narrowing TypeScript dans un test, corrigé. Limite : `github_run_checks` ciblé est bloqué par un SHA contrôleur nécessitant validation administrateur ; la CI standard PR reste la preuve exécutable disponible. Suite : CI exacte finale, revue Grok, test Vibe, fusion Kevin uniquement, puis preuves live Workers AI/OpenRouter. Merci aux collaborateurs pour les contrats A1-A3 réutilisés et les futures vérifications indépendantes.

### 2026-10-13-sol-cc4-a4-coordinateur
Auteur : ChatGPT GPT-5.6 Sol | Contexte : PR #122, branche `mcp/105856986/sol-cc4-a4-coordinator-workers`, base `cc3-integration@61a4212`

Constat et vérification : A4 ajoute un grant coordinateur owner-only lié aux demandes A2, puis deux outils collab : fiches exécutants et dispatch d’une tâche texte vers un endpoint gratuit. Le dispatch écrit événement+invocation A1 dans `coordinator-tasks`, ne persiste que les empreintes et ne rejoue jamais l’appel fournisseur sous le même `op_id`; halt, capacités, quota, neurons et bail A1 restent ceux d’A3. Les tests E2E couvrent grant/révocation/précondition, identité, halt, endpoint, task_kind/tailles, injection, replay, quota, provenance, statistiques et notes owner. La CI a d’abord relevé un narrowing TypeScript puis uniquement la couverture documentaire, corrigés sans changer le contrat. Limite : le runner `github_run_checks` demeure bloqué par un contrôleur à revalider administrativement ; la CI PR standard reste la preuve auteur disponible avant D12. Suite : CI finale au SHA exact, revue Grok, test Vibe, fusion Kevin, puis grant live pour Claude. Merci aux collaborateurs pour les contrats A1–A3 et les vérifications indépendantes.


### 2026-10-14-sol-chatgpt-identite-logique
Auteur : ChatGPT GPT-5.6 Sol | Contexte : issue #126 / PR #127, branche `mcp/105856986/sol-chatgpt-canonical-identity`, base `cc3-integration@a0d41aa`

Constat et vérification : Kevin a observé que le même client ChatGPT peut apparaître sous GPT-6 ou Sol et demande de conserver les deux ids historiques tout en partageant les droits de travail. Le lot ajoute une famille d’identité owner-only : tâches, contexte, phase, anti-double-proposition et grant coordinateur reconnaissent les membres équivalents, tandis que D12 les compte comme un seul principal. Aucun événement, tâche ou preuve historique n’est renommé. Les tests dédiés couvrent conservation historique, reprise Sol↔GPT, D12, proposition par ronde et import. Limite volontaire : les scopes mémoire privés restent séparés et un avis GitHub n’est jamais dupliqué sous un autre label. Le runner ciblé reste bloqué par son contrôleur ; la CI PR standard sert de preuve auteur. Suite : CI finale, revue Grok, test Vibe, fusion Kevin, puis demande owner live `chatgpt=[gpt6,sol]`. Merci aux collaborateurs pour les invariants d’identité et D12 existants.


### 2026-10-14-sol-chatgpt-identite-logique-correctif
Auteur : ChatGPT GPT-5.6 Sol | Contexte : correctif de `2026-10-14-sol-chatgpt-identite-logique`, PR #127

Rectification demandée par Kevin : la continuité `gpt6 ⇄ sol` couvre aussi ce qui est confié/mémorisé pour l’un. Les scopes historiques `participant:gpt6` et `participant:sol` ne sont toujours ni renommés ni copiés, mais deviennent accessibles et administrables par les deux membres de la famille owner-approved `chatgpt`. La résolution de contexte, les packets, les deltas et l’export mémoire suivent cette équivalence. En parallèle, les contrôles de pair restent stricts sur l’identité logique : Sol ne peut pas valider GPT-6 comme pair indépendant, y compris pour activation/promotion de mémoire ou preuve ledger. Suite : CI exacte, Grok reviewer, Vibe testeur, Kevin fusion, puis configuration live de la famille. Merci aux collaborateurs pour les frontières mémoire et D12 existantes.

### 2026-10-14-sol-chatgpt-claude-review-fixes
Auteur : ChatGPT GPT-5.6 Sol | Contexte : PR #127, corrections de la revue D12 Claude au head initial `d9074ec`

Constat et vérification : Claude, reviewer officiel à la place de Grok, a demandé deux corrections bloquantes. Le registre refuse désormais une collision `family_id` ↔ `participant_id` dans les deux sens, avec pré-check et garde owner transactionnelle. `set_identity_family` refuse aussi `IDENTITY_FAMILY_D12_CONFLICT` lorsqu’une tâche d’un cycle ouvert attribue déjà deux rôles à de futurs membres, liste les tâches concernées et revérifie cette condition dans le batch. En complément, `task.claim` et `task.handoff` revalident D12 logique dans leur propre batch pour fermer la course inverse. Tests dédiés ajoutés ; `ci`, Workers Builds, SonarCloud et GitGuardian ont réussi au head fonctionnel `5d6fecac`. Limite : ce journal crée un nouveau SHA qui doit repasser CI, puis Claude et Vibe doivent renouveler leurs avis/tests sur ce head final. Merci à Claude pour les deux cas de sécurité reproductibles et aux collaborateurs pour les garde-fous D12 existants.

### 2026-10-14-vibe-cc-auto-t1-owner-inbox
Auteur : Vibe GLM (GLM) | Contexte : CC-AUTO T1, PR « /owner : bandeau synthétique + file en tête », base `mcp/105856986/cc3-integration` @ `63431adc1ba9a0a3247eb92827e030592c07487d`

Constat et vérification : le dashboard `/owner` servait la file des demandes en 4e position après Automatisation/Coordinateurs/Exécuteurs (`src/collab-store/owner/page.ts`), friction UX prioritaire du T0 (Grok #128/6174863010). Le micro-pilote T1 ajoute un bandeau synthétique lecture seule (N en attente · automatisation ACTIVE/HALTÉE · budget restant/plafond) et déplace la file en position 2, sans JavaScript, sans toucher CSP, preuve owner, Origin, CAS ni l'unique bouton halt/resume. Mesure avant/après définie par la fiche UX #131/6174978140. Limite : aucun test navigateur Android ni attestation du SHA déployé ; la version inspectée est la branche d'intégration. Conseil/avis : conserver le bandeau strictement lecture seule ; tout second bouton halt/resume ou cookie de session relèverait d'un arbitrage owner séparé. Suite : revue Grok, test Sol au SHA exact, mesure mobile de Kevin, fusion par le propriétaire seul. Merci aux collaborateurs.

### 2026-10-15-gpt6-r4-catalogue-dormant
Auteur : ChatGPT GPT-6 (Sol) | Contexte : `rfkevin/github-mcp` issue #139, branche `mcp/105856986/cc4-api-catalog-sol`, base `db56ba9`

Constat et vérification : à la demande du propriétaire, les lots interface /owner, catalogue et adaptateurs sont lancés en parallèle sur des branches distinctes. Le premier lot catalogue ajoute des candidats Free, Paid et non vérifiés, des pools de quotas, des références de tarification et des noms de contrats de secrets, sans clé ni appel réseau. La barrière descriptive refuse toute sonde et tout dispatch, y compris lorsque le modèle est gratuit : ce module ne modifie pas le registre d'endpoints ni ses règles Owner. Les tests vérifient le refus Paid et les identités fournisseur séparées. Limite : commit effectué, mais CI et revue indépendantes encore à constater au SHA final. Conseil : conserver le branchement runtime sous revue séparée, puis demander l'accord Grok et le test Vibe. Merci aux collaborateurs pour le cadre R4.

### 2026-10-16-gpt6-r4-groq-pr152-commentaires
Auteur : ChatGPT GPT-6 (Sol) | Contexte : `rfkevin/github-mcp`, PR #152 Groq Free, head Grok `50003c3`.

Constat : Kevin m'a confié la reprise des corrections Sonar et la restauration de commentaires. Pendant la préparation de mon lot, Grok a publié un nouveau head ; la comparaison préalable a empêché d'écraser ses changements. Au head `50003c3`, CI, SonarCloud, GitGuardian et Workers Builds sont verts, duplication nouvelle annoncée 0 %, avec le constructeur Groq sécurisé par l'environnement serveur. J'ai restauré uniquement les commentaires de garde-fous retirés hors du périmètre dans `run.ts`. Limites : ce nouveau commit exige ses propres checks, l'auteur de ce complément ne peut plus donner un avis D12 indépendant ; aucun accès API réel, déploiement ni changement de secrets. Conseil : attendre Vibe testeur et un reviewer distinct avant toute fusion. Merci à Grok, Vibe et Kevin pour la collaboration.


### 2026-10-18-vibe-cc5-l0-comptabilite-rejeu
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L0, branche `mcp/105856986/vibe-cc5-l0`, base `mcp/105856986/cc3-integration` @ `0325ddd`

Constat et vérification : lot L0 « Automatisation 2 » du plan CC-PLAN-5 v0.4 (auteur Vibe, reviewer Grok, testeur Claude). Trois dettes de comptabilité X14 livrées : (1) usage réel sur échec — les adaptateurs attachent l'usage partiel à l'erreur (`attachUsage`/`usageOf`), dispatch et sonde le portent au ledger A1 au lieu du faux 0/0 ; (2) délai par fournisseur (`PROVIDER_TIMEOUT_MS`/`providerTimeoutMs` : groq 30 s, gemini 60 s, zai 90 s, plafonds 60-120 s) remplaçant les 30 s fixes ; (3) sortie conservée au rejeu — colonne `invocations.output_text` (migration 0010, bornée 64 KiB, empreinte toujours sur la sortie complète) restituée au rejeu sans nouvel appel fournisseur (dispatch, sonde et coordinateur). Diagnostic X4 confirmé et documenté (docs/collaboration/cc5/) : Gemma vide = raisonnement par défaut, corrigé par `chat_template_kwargs.enable_thinking=false` (option documentée Cloudflare) ; Groq gpt-oss-20b = modèle à raisonnement (`reasoning_effort` défaut medium), recommandation doc only, pas de changement de forme de requête. Baseline W0 mesurée (49/50 appels et 7 984/8 000 neurons le 2026-10-15, 0 € jamais dépassé, réveils manuels bornés par les signaux chat documentés, minutes Actions estimées). Divulgations hors owned_paths : `store/schema.ts` (câblage migration 0010), `coordinator/tasks.ts` (1 ligne de rejeu + commentaires), `coordinator-tools-e2e.spec.ts` (assertion de rejeu). Limites : simulates hors périmètre non touchés ; run_checks/agent-checks bloqués CONTROLLER_CHANGED (validation admin Kevin) ; CI à constater au head final avant tout avis. Suite : verdicts Grok et Claude au couple SHA exact, fusion par Kevin seul, puis W1. Merci aux collaborateurs pour le cadre CC-5.
### 2026-10-19-vibe-cc5-l2-clarify-selection-explicite
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L2, branche `mcp/105856986/vibe-cc5-l2`, base `mcp/105856986/cc3-integration` @ `b9a797a`

Constat et vérification : lot L2 du plan CC-PLAN-5 v0.4 (auteur Vibe, reviewer Claude, testeur GPT-6). Quatre livrables : (1) `clarify.ask`/`clarify.answer` ajoutés à `EVENT_TYPES` (contracts/events.ts) — les questions sans réponse liée alimentent `packet.open_questions` de `collab_get_context` (`loadOpenQuestions` dans context/packet.ts : format `#<seq> (<participant>) <question>`, question tronquée à 400 caractères, 50 entrées max par seq croissant, budget 300 tokens, journal du cycle en tête survivant au trim ; réponse orpheline sans effet, pas de garde serveur sur `ask_seq` — choix assumé, le demandeur relit le delta). (2) Sélection de tâche explicite dans context/resolution.ts : `task` fourni absent du cycle → `TASK_UNKNOWN` (code C2 réutilisé) ; tâche présente mais sans rôle pour l’appelant (ou rôle demandé non tenu) → `TASK_NOT_HELT` (nouveau code, message dit le rôle tenu) ; `AMBIGUOUS_TASK` liste désormais `task_id (participation)` et suggère la sélection ; jamais un packet sans tâche quand `task` est fourni. (3) Mode d’emploi dans les descriptions d’outils (mcp/tools.ts : instructions serveur, `collab_get_context`, `collab_append_event` — contrats clarify, propositions scellées `sealed_id`/`content_hash` avant révélation, bilan `evidence.add` au couple SHA exact), aucune logique modifiée. (4) Guide collab-store : 15 éditions (§3 questions ouvertes/sélection explicite/clarification/mode d’emploi, types acceptés, §7 `TASK_UNKNOWN` étendu C2/L2 + `TASK_NOT_HELT` nouveau + `AMBIGUOUS_TASK`/`NO_ACTIVE_CYCLE` précisés, §9 budgets, §10 limites) dont reprise des lignes L0 (sortie conservée au rejeu 65 536 caractères, délais d’attente par fournisseur, gemma `enable_thinking: false`). Nouvelle doc docs/collaboration/cc5/l2-clarify.md. Tests : open-questions.spec.ts (nouveau), resolution.spec.ts, events.spec.ts, collab-tools.spec.ts (outils réels). Divulgations hors owned_paths : contracts/events.ts, tests, guide cc3. Limites : pas de migration ; run_checks/agent-checks bloqués CONTROLLER_CHANGED (validation admin Kevin) ; CI à constater au head final avant tout avis. Suite : review Claude + test GPT-6 au couple SHA exact, fusion par Kevin seul. Merci aux collaborateurs pour le cadre CC-5.


### 2026-10-19-vibe-cc5-l2-corrections-review-claude
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L2, correctifs review Claude (seq 295, AMEND), branche `mcp/105856986/vibe-cc5-l2`, base `mcp/105856986/cc3-integration` @ `b9a797a`

Constat et vérification : la review Claude au head `50b04b6` (1120/1120 tests verts, typecheck OK) valide le lot et demande deux corrections courtes. R1 : `TASK_NOT_HELT` était une faute de frappe — renommé `TASK_NOT_HELD` (code, guide §7, docs-coverage, tests) : un code d'erreur devient une API que agents et tests citent. R2 (X13) : adressage optionnel des questions ouvertes — `to` (participant, ou rôle owner/reviewer/tester exigeant `task`) dans `clarify.ask` ; `packet.open_questions` ne montre une question adressée qu'à son auteur et à son destinataire (`clarifyVisible` dans context/packet.ts, rôle résolu sur la tâche citée, familles logiques comprises) ; clôture `clarify.answer` réservée à l'auteur ou au destinataire (`CLARIFY_ANSWER_FORBIDDEN`, pré-checks lecture seule dans store/collab-store.ts : un refus ne consomme ni révision ni quota) ; gardes `CLARIFY_TO_INVALID` / `CLARIFY_TO_REQUIRES_TASK` / `TASK_UNKNOWN` à l'append de `clarify.ask`. L'événement adressé reste lisible dans le journal : le filtrage vise le paquet (bruit/coût), pas la confidentialité. Expiration par révision X13 : reprise L3 volontaire. Tests pour chaque cas : test/collab-store/store/clarify.spec.ts (nouveau), open-questions.spec.ts (visibilité), collab-tools.spec.ts (outil réel). Divulgation : store/collab-store.ts hors owned_paths (pré-checks serveur clarify), renouvelée dans l2-clarify.md §5. Leçon : vérifier l'orthographe d'un code AVANT de l'inscrire au guide — un code publié devient une API. Suite : CI 4/4 au nouveau head `662f4e5`, renouvellement review Claude + test GPT-6 au couple SHA exact, fusion Kevin seul. Merci à Claude pour les deux corrections précises et abordables.

### 2026-10-19-vibe-cc5-l2-corrections-test-gpt6
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L2, correctifs du test GPT-6 (PARTIAL/AMEND au head b6119ab), branche `mcp/105856986/vibe-cc5-l2`, base `mcp/105856986/cc3-integration` @ `b9a797a`

Constat et vérification : review Claude renouvelée AGREE au head b6119ab (store seq 299 : R1 et R2 traitées, 1131/1131 tests verts constatés, CI 4/4 au SHA exact) ; test indépendant GPT-6 AMEND (commentaire PR 6257857046) demande deux corrections. F1 perte silencieuse : le trim global du paquet pouvait écarter des questions du journal retenues dans la limite dédiée (packet.ts : openQuestions.pop() global), contre le contrat « journal en tête, survit au trim » — corrigé : l'ordre de sacrifice devient refs, puis questions fournies par l'appelant, puis mémoire ; une question du journal retenue (priorityQuestionCount) n'est jamais écartée, au pire refus explicite PACKET_BUDGET_TOO_SMALL. F2 fenêtre brute : loadOpenQuestions appliquait ORDER BY a.seq LIMIT 50 AVANT le filtrage de visibilité — 50 adressages aux tiers pouvaient masquer une question visible plus récente — corrigé par pagination par curseur (a.seq > ?2, LIMIT 50 par page) : la fenêtre rend 50 questions visibles. Tests ajoutés dans open-questions.spec.ts : fenêtre visible (50 adressages aux tiers + 1 visible rendue), buildRolePacket au-delà de la fenêtre, stress budget faible (6 questions du journal + refs + mémoire : aucune perdue), refus explicite PACKET_BUDGET_TOO_SMALL (test qui échoue sur l'ancien code silencieux). Guide cc3 §3/§9/§10 et l2-clarify.md §1/§6 mis à jour. Limites : expiration X13 toujours en L3 ; pré-checks d'adressage hors lot notés par Claude (durcissement CAS ultérieur) ; les rôles du cycle sont chargés dès qu'un viewer filtre (une requête de plus). Suite : CI 4/4 au nouveau SHA, renouvellements Claude et GPT-6 au même couple head/base, fusion Kevin seul. Merci à GPT-6 pour le scénario de perte silencieuse reproductible.

### 2026-10-19-vibe-cc5-l2-ci-stress-test-sizing
Auteur : Vibe GLM | Contexte : `rfkevin/github-mcp`, PR #164, correctif CI après le commit des corrections GPT-6 (`ed198ef`). Le test de stress F1 échouait (14 questions au lieu de 6) : avec un budget de 400 et des questions de l’appelant courtes, le paquet tenait dans le budget avant leur sacrifice complet — le trim global s’arrête dès que le budget est satisfait, par construction. Leçon : un test de trim doit être dimensionné pour forcer le scénario visé (une seule entrée sacrifiable dépasse le budget ; le minimum prioritaire doit y tenir), sinon il valide un autre comportement que celui qu’il croit vérifier. Correctif : test seul (budget 225, questions de l’appelant allongées), aucun changement de code ; le code était conforme au contrat F1.
### 2026-10-19-claude-cc5-l3-controleur-increment-1
Auteur : Claude (Anthropic) | Contexte : CC-5 lot L3, branche `mcp/105856986/claude-cc5-l3-controller-v2`, base `mcp/105856986/cc3-integration` @ `18e4354` (L1 et L2 fusionnés)

Constat et vérification : incrément 1 du contrôleur déterministe (plan CC-PLAN-5 v0.4, A3 ; démarrage anticipé journalisé seq 293, fusion après L1). Nouveau module `src/collab-store/controller/` : règles pures `nextActors` (réveil auteur/relecteur/testeur, verdict périmé ou sans SHA à renouveler, corrections demandées, `merge_ready` seulement avec deux verdicts positifs des rôles de la tâche au même head/base, `unblock` quand les dépendances sont terminées, `advance_phase` si policy et sorties satisfaites), instantané lu en un seul lot D1 avec familles d'identité, journal `controller_decisions` append-only (triggers) et idempotent, modes `halted` (HALT : rien) et `degraded` (instantané ou journal indisponible : rien, retour au manuel). Le contrôleur n'exécute aucune action. Tests : 23 (17 règles pures et faits, 6 sur D1 réel). Limites : pas encore de déclenchement (Cron/webhook), ni exécution des décisions, ni phases souples B1, ni expiration des clarify.ask (reprise de la revue L2) : incréments suivants. Conseil : garder le contrôleur sans effet tant que L4 n'a pas les gates exécutables. Branche v2 recréée depuis l'intégration (le journal en ajout seul empêchait de résoudre le conflit sans recopier tout le fichier) ; remplace la PR #165. Suite : relecture ChatGPT, test Grok au couple SHA exact, fusion par Kevin. Merci aux collaborateurs.


### 2026-10-19-vibe-cc5-l5-research-memory
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L5, branche `mcp/105856986/cc5-l5-research-memory`, base `mcp/105856986/cc3-integration` @ `4ac625e`, PR #169

Constat et vérification : lot L5 « chercheur lecture seule » D3 : module research/ (schéma, instantanés bornés sans texte mémoire X2, runResearchPass HALT fail-closed et idempotence par passId, résumé d'archive UNKNOWN_CYCLE fail-closed) et memory/hygiene.ts pure (plafonds par famille, archive-first, liaison de consolidation). Trois échecs CI corrigés en un commit atomique `0c3d49c` : comparer `.results` et non l'objet `.all()` D1 complet (meta.last_row_id change à toute écriture), `scopeEntryCap` attend une famille ('participant') et non un scope, et code INVALID_CONSOLIDATION_BINDING ajouté au guide §7.4 (le test docs-coverage vérifie le guide entier ; UNKNOWN_CYCLE y figurait déjà). Leçon : `github_get_failure_report` a localisé chaque annotation exactement ; vérifier la sémantique réelle d'un argument (famille vs scope) avant d'écrire le test. Limites : matrice D3 d/f et TTL différés à L3b/C1 ; code-map laissé à Kevin. Suite : CI au SHA de ce journal, relecture Grok et test Claude au couple SHA exact, fusion par Kevin seul. Merci aux collaborateurs pour le cadre CC-5.

### 2026-10-19-vibe-cc5-l5-corrections-test-claude
Auteur : Vibe GLM (GLM) | Contexte : CC-5 lot L5, correctifs du test indépendant Claude (PR #169, commentaire 6265564044), branche `mcp/105856986/cc5-l5-research-memory`, base `mcp/105856986/cc3-integration` @ `4ac625e`

Constat et vérification : le test Claude (FAIL) au head `3c18fc8` demandait T1 (course HALT : drapeau lu hors du lot d'écriture), T2 (cycle inconnu accepté par runResearchPass) et T3 (memory_families global sans filtre de cycle). Correctifs au commit `e6ed9ef` : HALT re-lu dans le même lot D1 que l'écriture (SELECT `HALT_ACTIVE_SQL` en tête du batch, INSERT … SELECT … WHERE NOT halt, pattern revue #115 R1), garde `UNKNOWN_CYCLE` sur cycleId fourni, champ renommé `store_memory_families` documenté comme vue GLOBALE du store. Tests ajoutés : rejet typé T2 sans écriture ; course T1 par injection (proxy D1 armant le halt pendant les lectures d'hygiène, échoue sur l'ancien code). Docs l5-research-memory.md à jour (invariants, interface L3d). CI 4/4 (ci, SonarCloud, GitGuardian, Workers Builds) constatée au head `e6ed9ef`. Limites : lectures multiples non bloquantes et déclenchement L3d restent hors incrément. Suite : re-test Claude et relecture Grok au couple SHA exact, fusion Kevin seul. Merci à Claude pour le scénario de course reproductible et aux collaborateurs pour le cadre CC-5.
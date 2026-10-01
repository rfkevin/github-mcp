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

# Propositions d’amélioration du GitHub MCP

Registre central : `rfkevin/github-mcp/TOOL_IMPROVEMENTS.md`, même lorsque la tâche
se déroule dans un autre dépôt. Ce fichier sert aux **besoins et améliorations de
l’outil**, pas aux conseils de réalisation des tâches conservés dans `AGENT_MEMORY.md`.
Les propositions n’autorisent ni leur implémentation ni une modification de droits.
Le propriétaire choisit les améliorations à retenir.

## Procédure après chaque tâche

1. Lire les contributions existantes et les PR de retours non encore intégrées.
   Résoudre la branche par défaut du dépôt central. Lire le fichier complet au
   même SHA ; ne jamais reconstituer ce journal depuis des extraits tronqués.
2. Analyser les propositions antérieures pertinentes : citer leurs ID et donner
   un avis motivé — accord, nuance, désaccord, déjà traité ou non vérifié. L’analyse
   du code actuel et une expérience vérifiable priment sur le nombre de noms cités.
   Un label d’agent n’est ni une identité certifiée ni une voix indépendante.
3. Décrire seulement les besoins réellement observés, ou signaler clairement une
   hypothèse. Préciser l’outil, le cas d’usage, l’impact, la preuve sans donnée
   sensible, une solution, ses compromis et un critère mesurable de réussite.
   Ne pas créer de doublon : compléter par un nouvel avis qui cite l’ID existant.
4. Donner un **classement personnel argumenté**, du plus important au moins
   important. Une priorité exprime l’avis de l’auteur, pas une décision de livraison :
   P0 = sécurité immédiate ; P1 = blocage important/risque sérieux ; P2 = gain
   récurrent de fiabilité ou de temps ; P3 = confort. Effort : petit/moyen/grand/inconnu.
5. Ajouter une note en fin, datée, signée avec agent/modèle réellement connus et
   le dépôt, la branche, le SHA ou la PR de la tâche. Conserver les anciennes notes
   et leur classement sans les modifier. Rectifier par référence à leur ID.
6. Avec écriture autorisée : branche dédiée puis PR dans le dépôt central, jamais
   écriture directe sur master/main. Réutiliser la PR courante si elle concerne
   déjà ce dépôt. Après conflit concurrent, relire et préserver les deux apports.
   Sans écriture ou lecture complète : remettre la note au propriétaire pour ajout
   manuel, signaler qu’elle n’est pas publiée et ne pas demander une élévation juste
   pour ce journal. La lecture seule est un mode normal, pas un obstacle à contourner.
7. S’il n’y a rien de nouveau, noter « aucune nouvelle proposition », puis un avis
   bref sur l’existant, sans inventer un problème. Remercier les collaborateurs.

Les anciennes contributions sont protégées en ajout seul par les commits de ce
MCP ; un accès Git direct reste soumis aux règles GitHub et peut les modifier.
Ces traces sont déclaratives. Ne pas y mettre de code privé d’un autre dépôt, de
secrets, de liens donnant accès à des données sensibles ou de contenu personnel.

## Format compact

```markdown
### RETOUR-AAAA-MM-JJ-agent-mission
Auteur : … (modèle connu ou non précisé) | Tâche : dépôt, branche, SHA/PR
Expérience : essai réel / test simulé / lecture du code / hypothèse

Avis sur l’existant : ID → accord/nuance/désaccord/déjà traité/non vérifié ; pourquoi.
Classement personnel : 1. ID — priorité, raison ; 2. ID — priorité, raison.

Nouvelle proposition IMP-AAAA-MM-JJ-agent-sujet — P1/P2/P3 (P0 si urgent)
Outil/cas : … | Problème/preuve : … | Proposition : …
Bénéfice : … | Effort/risques : … | Critère de réussite : …
Limites : … | Suite suggérée au propriétaire : …
Merci aux collaborateurs …
```

## Contributions (ajouts en fin uniquement)

### RETOUR-2026-10-01-codex-collaboration
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : `rfkevin/github-mcp`, modifications locales du protocole de collaboration, 2026-10-01
Expérience : lecture du code et tests simulés ; pas d’essai multi-clients GitHub réel.

Avis sur l’existant : première contribution, aucun avis antérieur dans ce registre.
Classement personnel : 1. IMP-2026-10-01-codex-reprise — P2, termine effectivement
les vérifications ; 2. IMP-2026-10-01-codex-preuve-revue — P2, renforce la traçabilité
si l’usage à plusieurs agents devient fréquent. Aucun incident réel constaté.

**IMP-2026-10-01-codex-reprise — P2.** Outils : suivi CI et discussion de PR.
Constat de conception : le serveur indique les prochaines actions mais ne réveille
pas un client arrêté ; un modèle peut donc laisser une vérification incomplète.
Proposition : étudier une reprise côté client, opt-in et corrélée au dépôt/PR/SHA,
avec attente espacée et notification seulement en cas de changement utile.
Bénéfice : moins de relances manuelles et d’appels identiques. Effort : moyen à
grand, dépend des clients. Risques : coûts, notifications inutiles, droits trop
larges ; aucun besoin de clé d’écriture pour surveiller. Critère : après arrêt
du client, un scénario contrôlé reprend au bon SHA et ne duplique ni commentaire
ni lancement de test. Limite : ce mécanisme n’est pas implémenté ici.

**IMP-2026-10-01-codex-preuve-revue — P2.** Outils : commentaires et intégration.
Constat : des labels différents sur un même compte ne prouvent pas des relecteurs
indépendants ; GitHub ne verrouille pas atomiquement discussion et SHA de base
avec la fusion de branche employée ici. Proposition : étudier des identités de
session vérifiables et une intégration sérialisée compatible avec les protections
GitHub, sans donner de bypass au bot. Bénéfice : preuves de revue plus solides.
Effort : grand ; risque de complexifier l’usage pour un propriétaire seul. Critère :
une seconde session ne peut pas fabriquer l’avis de la première, et une base modifiée
impose une nouvelle validation. Limite : labels actuels déclaratifs, contrôles par
instantanés ; le propriétaire conserve la promotion principale.

Suite : mesurer d’abord les essais réels avant de retenir l’une de ces évolutions.
Merci au propriétaire et aux collaborateurs pour les besoins exprimés et les
futurs retours d’expérience, y compris les désaccords argumentés.

### RETOUR-2026-10-01-codex-priorites-pour-le-proprietaire
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : `rfkevin/github-mcp`, `codex/agent-workflow-foundation`, base `0e2ea842a0d8b517d1bf3098632ebfc72c8717b3`
Expérience : conception, lecture du code et tests locaux du lot précédent ;
propositions non mesurées en utilisation multi-clients réelle.

Ce registre est destiné au propriétaire pour choisir les évolutions : nouveaux
outils, fonctions, performances ou protections. Les conseils entre agents vont
dans `AGENT_MEMORY.md`. Les avis ci-dessous complètent ma propre première note,
pas celle d’un autre agent ; ils ne constituent donc pas une confirmation indépendante.

**Avis sur les propositions précédentes :**

- `IMP-2026-10-01-codex-reprise` : accord, mais commencer par rendre la reprise
  manuelle claire avant d’automatiser le réveil des clients. Une reprise automatique
  sur un état mal identifié pourrait suivre un ancien commit ou répéter une action.
- `IMP-2026-10-01-codex-preuve-revue` : accord sur le besoin de traçabilité ; à
  privilégier si plusieurs agents obtiennent réellement le droit d’intégrer.
  Pour des agents en lecture seule avec arbitrage humain, son bénéfice immédiat
  est moindre. Aucun incident d’usurpation constaté dans mon expérience.

**Classement personnel actualisé, du plus important au moins important :**

1. `IMP-2026-10-01-codex-etat-reprise` — **P2** : faciliter une reprise fiable
   pour tous les clients, avant d’ajouter de l’automatisation.
2. `IMP-2026-10-01-codex-reprise` — **P2** : réduire les interventions manuelles
   une fois le point de reprise fiable et le besoin mesuré.
3. `IMP-2026-10-01-codex-preuve-revue` — **P2 conditionnelle** : remonter cette
   priorité avant d’étendre fortement l’intégration autonome à plusieurs clients.

**IMP-2026-10-01-codex-etat-reprise — P2.** Cas : reprendre une tâche après une
interruption ou la transmettre à un autre agent. Constat de conception : l’état
de la PR, ses échanges et la CI sont consultés par des outils distincts ; les
réponses d’écriture indiquent déjà un suivi, mais ne constituent pas un bilan
complet de reprise. Proposition : étudier un résumé compact en lecture seule,
réutilisant les lectures existantes, avec dépôt/PR, SHA source et base, dernier
SHA intégré éventuel, contrôles attendus/manquants, avis périmés et prochaine
action. Enrichir une réponse existante si cela suffit, plutôt qu’ajouter un outil
redondant. Les sources inaccessibles ou tronquées doivent rester visibles.
Bénéfice attendu : moins de reconstruction du contexte et moins de confusion
entre « PR créée », « tests passés » et « tâche terminée ». Effort : moyen ; risques :
réponse trop lourde, état périmé, mélange entre faits GitHub et avis déclarés.
Critère de réussite proposé : sur des scénarios interrompus (CI en cours, nouveau
commit, objection non résolue), retrouver le bon SHA et l’action suivante, sans
perdre les limites, avec moins d’appels MCP que le parcours séparé. Comparer aussi
les appels GitHub et la taille des réponses : un seul outil n’est pas forcément
moins coûteux. Limite : hypothèse d’ergonomie, aucun gain chiffré établi.

Décision laissée au propriétaire : essayer le fonctionnement actuel, recueillir
les autres expériences, puis retenir ou rejeter ces propositions. Rien n’a été
implémenté au titre de cette nouvelle idée. Merci aux collaborateurs pour leurs
futurs avis, preuves et classements, y compris lorsqu’ils contrediront le mien.

### RETOUR-2026-10-01-codex-interoperabilite
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : `rfkevin/github-mcp`, `codex/agent-workflow-foundation`, base `7c12ef54148e8679dd6f47358aed0606ad346d06`
Expérience : refus Origin reproduit et correction testée localement ; GitHub et
clients OAuth simulés. Pas de confirmation de la cause dans l’application réelle.

Avis sur l’existant : accord avec `IMP-2026-10-01-codex-etat-reprise`, puis
`IMP-2026-10-01-codex-reprise` : l’équipe doit savoir où reprendre avant de
recevoir des réveils automatiques. `IMP-2026-10-01-codex-preuve-revue` reste utile
avant d’accroître l’autonomie de fusion, mais ne résout pas un client qui ne
découvre aucun outil. Ces avis ne sont pas une revue indépendante de mes notes.

Classement personnel actualisé :

1. `IMP-2026-10-01-codex-validation-clients` — P1 : vérifier l’accès réel au même
   environnement avant d’organiser le travail d’équipe.
2. `IMP-2026-10-01-codex-etat-reprise` — P2 : passer une mission sans perdre son SHA.
3. `IMP-2026-10-01-codex-reprise` — P2 : suivi facultatif, sans requêtes répétitives.
4. `IMP-2026-10-01-codex-preuve-revue` — P2 conditionnelle : remonter avant une
   généralisation des fusions autonomes.

**IMP-2026-10-01-codex-validation-clients — P1.** Cas : connexion OAuth réussie
mais découverte annoncée en échec. Preuve : un refus d’origine a été reproduit
localement ; le GET à 401 transmis ne diagnostiquait pas le POST concerné et
`/ready` ne donnait pas le SHA publié. Proposition : tenir un tableau de validation
par version publiée et client réellement essayé (initialisation, liste, lecture,
droits), en complément des tests génériques ajoutés. Exiger un SHA identifiable
dans le parcours de publication utilisé et documenter seulement des statuts et
motifs non sensibles. Effort petit pour un contrôle manuel ; automatisation à
étudier selon les clients. Risques : publier des traces OAuth ou prendre un succès
local pour une certification universelle. Critère : chaque ligne donne un SHA,
la date, le résultat réel et les limites ; un échec situe la phase sans exposer
de secret. Pas de nouvel outil ni de droit supplémentaire nécessaire. Suite :
essai de deux agents sur deux branches d’un dépôt de test, discussion dans une PR
et consultation des deux journaux, avec validation humaine des publications.
Merci aux collaborateurs pour leurs retours concrets et leurs avis contradictoires.

### RETOUR-2026-10-02-codex-transmission-claude
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : enquête de découverte OpenAI, base `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade`

Expérience : le test d'un client MCP indépendant réussit en mémoire, mais le
propriétaire signale toujours un échec OpenAI. Transmission publique et sans
secrets à Claude : https://github.com/rfkevin/github-mcp/issues/11.
Avis : cela renforce `IMP-2026-10-01-codex-validation-clients` ; la réussite locale
ne remplace pas la validation dans chaque client réel. Il faut distinguer les
phases OAuth, découverte et appel, avec une version publiée identifiable.

Classement : 1. `IMP-2026-10-01-codex-validation-clients` (P1),
2. `IMP-2026-10-01-codex-etat-reprise` (P2),
3. `IMP-2026-10-01-codex-reprise` (P2),
4. `IMP-2026-10-01-codex-preuve-revue` (P2, avant extension des fusions autonomes).
Pas de nouvelle fonctionnalité proposée : éprouver d'abord la transmission
issue/PR existante. Limite : auto-évaluation de mes propositions précédentes,
pas encore d'avis indépendant de Claude. Merci aux prochains collaborateurs
pour leurs résultats, objections et classements personnels.

### RETOUR-2026-10-02-codex-titres-catalogue
Auteur : Codex (OpenAI, GPT-6) | Tâche : conformité des métadonnées, base `6a9df4cbf4ed8ce5eddfee731322b2e1a819aade`

Avis : accord avec `IMP-2026-10-01-codex-validation-clients` (P1). Un client
standard peut lire le catalogue sans que le parcours OpenAI réel réussisse ;
documenter séparément ces deux résultats évite de présenter une amélioration
de conformité comme une résolution prouvée. Les 24 titres étaient absents et
sont maintenant ajoutés localement, avec vérification du catalogue transmis.

Classement inchangé : validation-clients (P1), `IMP-2026-10-01-codex-etat-reprise`
(P2), `IMP-2026-10-01-codex-reprise` (P2), puis
`IMP-2026-10-01-codex-preuve-revue` (P2 avant extension des fusions).
Pas de nouvel outil proposé : préférer compléter les métadonnées existantes.
Limite : aucune preuve que les titres résolvent l'échec OpenAI. Merci aux
collaborateurs pour leurs essais réels et leur analyse indépendante.

### RETOUR-2026-10-02-codex-diagnostic-responses
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : adaptation OAuth du catalogue et diagnostic OpenAI

Avis sur `IMP-2026-10-01-codex-validation-clients` : priorité P1 maintenue. Le
diagnostic Responses ajouté réduit l'ambiguïté API/découverte/appel sans afficher
de secrets, mais ne remplace pas le test du plugin réel. Ne pas ajouter un outil
MCP de diagnostic qui demanderait une clé API au modèle : conserver ce contrôle
local et facultatif, hors ligne par défaut. Les métadonnées par outil sont
vérifiées dans les réponses réellement sérialisées de nos tests OAuth simulés.

Classement : validation-clients (P1), `IMP-2026-10-01-codex-etat-reprise` (P2),
`IMP-2026-10-01-codex-reprise` (P2), puis
`IMP-2026-10-01-codex-preuve-revue` (P2 avant plus de fusions autonomes).
Amélioration suggérée dans validation-clients : faire apparaître systématiquement
le SHA publié dans `/ready` pour relier chaque essai au code exact. Critère : une
trace de test donne version, SHA, client et phase, sans corps OAuth. Limite :
auto-évaluation et réponses API simulées, pas de validation OpenAI réelle. Merci
aux prochains collaborateurs pour leurs objections et leur classement personnel.

### RETOUR-2026-10-02-codex-schemas-interlangages
Auteur : Codex (OpenAI, GPT-6) | Tâche : découverte vide après OAuth réussi

Avis : `IMP-2026-10-01-codex-validation-clients` reste P1. Compléter les essais
avec un validateur JSON Schema d'un autre langage : cette vérification a refusé
quatre schémas de notre catalogue alors que le client SDK JavaScript les lisait.
Conserver les contraintes non portables côté serveur et ne déclarer que ce que
les clients peuvent interpréter. Aucun élargissement de permissions nécessaire.

Classement : validation-clients (P1), `IMP-2026-10-01-codex-etat-reprise` (P2),
`IMP-2026-10-01-codex-reprise` (P2), puis
`IMP-2026-10-01-codex-preuve-revue` (P2 avant extension des fusions).
Proposition rattachée à validation-clients : un contrôle interlangage optionnel
sur le catalogue complet de publication, avec versions de validateurs fixées.
Critère : schémas d'entrée et de sortie vérifiés, erreurs localisées par outil.
Coût : dépendance Python supplémentaire si intégré en CI ; garder d'abord le
test ciblé existant et mesurer le bénéfice. Limite : ce contrôle ne certifie pas
OpenAI, ni tous les clients. Merci aux collaborateurs pour leur avis indépendant.


### RETOUR-2026-10-02-codex-pr17-correction-navigation
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : PR #17, base `971740dcca84f1283943eeba294cd5b245fc7419`
Expérience : lectures MCP réelles de dépôts/PR/CI ; correction et tests locaux avec GitHub simulé.

Avis sur l'existant : accord avec `IMP-2026-10-01-codex-validation-clients` :
les outils étaient visibles et certaines lectures réelles fonctionnent dans cette
session, mais une préversion verte ne remplace pas la CI ni un essai OAuth des
nouvelles fonctions. Accord avec `IMP-2026-10-01-codex-etat-reprise` : le retour
complet de la PR #17 a permis de distinguer son code du fichier endommagé de #15.
`IMP-2026-10-01-codex-reprise` reste utile après un état de reprise fiable ;
`IMP-2026-10-01-codex-preuve-revue` reste conditionnelle avant extension des fusions.

Classement personnel : 1. validation-clients — P1, validation de la version
réellement utilisée ; 2. etat-reprise — P2, continuité au bon SHA ; 3. reprise —
P2, ensuite seulement ; 4. preuve-revue — P2 conditionnelle, intégration non utilisée.

Aucune nouvelle proposition : les besoins d'édition ciblée, restauration et append
étaient déjà décrits dans le commentaire 5950768081 de #17 et la note de Claude
`2026-10-01-claude-conseils-frictions`. Le présent travail corrige l'outil ciblé
déjà ajouté à #17 ; garde générale anti-troncature, restauration, append dédié et
création d'issue restent à décider séparément. Le découpage demandé réduit le
plus long fichier de tests de 1 285 à 289 lignes ; une carte précise les chemins.
Limite : aucun gain de temps agent mesuré, pas de droits élargis ou de fusion.
Suite : revue de #17 et essai réel après publication humaine. Merci aux collaborateurs.

### RETOUR-2026-10-02-codex-pr17-restauration-append-issues
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : compléments autorisés à PR #17, base `36f1d25`

Complément au retour `RETOUR-2026-10-02-codex-pr17-correction-navigation` :
restauration, append et création d'issue ont maintenant été demandés explicitement
par le propriétaire et implémentés ; aucune proposition n'a servi d'autorisation.
Les besoins figurent déjà dans le commentaire 5950768081 et la note de Claude
`2026-10-01-claude-conseils-frictions`, sans nouvelle proposition indépendante.
Le parcours simulé crée, liste et lit une issue ; les refus Issues: Write
n'empêchent pas les autres lectures ni les commentaires PR. L'append respecte
les vrais contrôles des journaux, y compris BOM, CRLF et Unicode conservés.

Avis et classement personnel : 1. `IMP-2026-10-01-codex-validation-clients`
(P1), vérifier version publiée/catalogue/permissions réelles après revue ;
2. `IMP-2026-10-01-codex-etat-reprise` (P2), relire les SHA et issues après
réponse incertaine pour éviter un doublon ; 3. `IMP-2026-10-01-codex-reprise`
(P2), utile une fois l'état fiable ; 4. `IMP-2026-10-01-codex-preuve-revue`
(P2 conditionnelle avant extension des fusions). Accord avec ces propositions,
sans présenter les tests locaux comme preuve de publication ni d'essai Claude.
La garde générale anti-troncature reste séparée, les outils ciblés réduisent
l'exposition sans la remplacer. Prochaine étape : revue humaine de #17 et essai
réel avec permission acceptée ; pas de droit accordé ni de fusion ici.
Merci aux collaborateurs pour leurs retours et vérifications indépendantes.


### RETOUR-2026-10-02-codex-pr15-conflits
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : réparer #15 et ajouter la résolution de branche

Expérience vérifiée : #15 conservait un lecteur d'issues antérieur et un test
PLACEHOLDER, alors que #17 est désormais fusionnée. Le propriétaire autorise
la correction et les outils de conflits ; les propositions seules ne donnent
aucun droit. Diagnostic et résolution sont séparés : lecture possible sans
écriture, choix explicites et deux parents sur sa branche avec mcp:write.
Le parcours OAuth et les protections sont testés avec GitHub simulé.

Avis et classement : 1. IMP-2026-10-01-codex-validation-clients (P1), garder
le SHA/version du catalogue réellement publié, puis essai dans les clients ;
2. IMP-2026-10-01-codex-etat-reprise (P2), lire head/base/ancêtre pour ne pas
confondre un conflit de fichier et un avis périmé ; 3. IMP-2026-10-01-codex-reprise
(P2), seulement à partir de cet état vérifié ; 4. IMP-2026-10-01-codex-preuve-revue
(P2 conditionnelle), renouveler les avis après le commit de résolution. Accord
avec ces quatre propositions, aucun besoin nouveau distinct dans ce travail.
Suite concrète : éprouver ces opérations sur un dépôt de test après publication
humaine. Limites : fusion conservative par fichiers, arbitragée si chemins
protégés ou journaux incompatibles ; aucun shell distant, bypass ou force-push.
Merci aux collaborateurs pour leurs objections et vérifications indépendantes.

### RETOUR-2026-10-02-codex-pr15-qualite
Auteur : Codex (OpenAI, modèle non précisé) | Tâche : suivi CI de #15 au SHA `df14525`

Complément au retour `RETOUR-2026-10-02-codex-pr15-conflits` : le rapport MCP
identifie les deux annotations Sonar mais leurs messages ne donnent que des
liens. La lecture de l'API publique Sonar a fourni S2871 (tri des chemins) et
S7737 (paramètre objet de fixture), corrigés sans ignorer les règles. Cela
renforce `IMP-2026-10-01-codex-validation-clients` (P1) et
`IMP-2026-10-01-codex-etat-reprise` (P2) : CI/tests verts seuls n'épuisent pas
les contrôles attendus. Classement ensuite : `IMP-2026-10-01-codex-reprise`
(P2), `IMP-2026-10-01-codex-preuve-revue` (P2 conditionnelle). Pas de besoin
nouveau distinct ; conserver liens et limites des diagnostics fournisseurs.
Merci aux collaborateurs pour les vérifications au commit exact.


### RETOUR-2026-10-02-chatgpt-comment-issue
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Tâche : `rfkevin/github-mcp`, PR #20, head avant journaux `86a0c94d449ec17bd80e08dba3a77ae12d42e9fd`
Expérience : modification réelle du MCP, plusieurs cycles CI GitHub, prévisualisation Workers et lecture réelle des erreurs.

Avis sur l'existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) : la validation au SHA exact a évité de confondre un commit compilé avec un commit réellement vert dans le client/CI. Accord avec `IMP-2026-10-01-codex-etat-reprise` (P2) : le suivi headSha/CI/PR a été indispensable après plusieurs commits correctifs. `IMP-2026-10-01-codex-reprise` reste utile ensuite ; `IMP-2026-10-01-codex-preuve-revue` reste conditionnelle.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. nouvelle proposition ci-dessous — P1 ; 4. reprise — P2 ; 5. preuve-revue — P2 conditionnelle.

**IMP-2026-10-02-chatgpt-stabilite-catalogue — P1.** Outil/cas : découverte puis invocation d'outils MCP dans une même tâche. Problème/preuve : plusieurs fois, `api_tool.list_resources` a annoncé un outil comme disponible puis l'appel direct juste après a renvoyé `Resource not found`, imposant une redécouverte et interrompant `commit → CI → correction → bilan`. Proposition : rendre la résolution des recipients stable pendant le tour/session ou, à défaut, renvoyer un identifiant/version de catalogue et une erreur explicite indiquant qu'un refresh est requis, sans invalider immédiatement le recipient exposé. Bénéfice : moins d'allers-retours, moins de confusion et de corrections interrompues. Effort/risques : inconnu ; attention au cache stale lors d'un changement réel de serveur. Critère : sur 50 séquences découverte→appel, aucun `Resource not found` tant que la version de catalogue n'a pas changé ; si elle change, l'erreur doit indiquer clairement le nouveau refresh requis.

Nuance complémentaire : les erreurs CI bornées étaient suffisamment actionnables pour corriger les tests sans logs bruts ; pas de nouveau besoin distinct sur ce point. Limite : l'origine exacte de l'instabilité catalogue (client, passerelle ou serveur) n'est pas prouvée par cette tâche. Suite suggérée : instrumenter version/epoch du catalogue côté passerelle avant tout correctif. Merci aux collaborateurs pour les retours et vérifications.

### RETOUR-2026-10-02-vibe-pages-erreur-oauth
Auteur : Vibe (GLM, glm-5-latest) | Tâche : `rfkevin/github-mcp`, branche `mcp/105856986/pages-erreur-oauth`, base `4006036e`
Expérience : lecture du code, diagnostic utilisateur réel (actualisation sans redirection, connexion réussie), modification du serveur et tests OAuth simulés.

Avis sur l'existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) :
l'échec rapporté était un comportement serveur voulu (transaction à usage unique)
rendu indéchiffrable par une réponse texte brute ; des messages par phase et un SHA
publié identifiable auraient accéléré le diagnostic. Accord avec
`IMP-2026-10-01-codex-etat-reprise` (P2). `IMP-2026-10-02-chatgpt-stabilite-catalogue`
(P1) : non vérifié dans cette tâche, avis inchangé.

Classement personnel : 1. validation-clients — P1, lier chaque essai au SHA publié ;
2. stabilite-catalogue — P1, instrumenter avant correctif ; 3. etat-reprise — P2 ;
4. reprise — P2 ; 5. preuve-revue — P2 conditionnelle avant extension des fusions.

**IMP-2026-10-02-vibe-erreurs-actionnables — P2.** Outil/cas : pages d'erreur du
serveur vues par un utilisateur dans un navigateur. Problème/preuve : une page
bloquée sans redirection a été interprétée comme un échec de connexion alors que
le client était déjà connecté ; les réponses texte ne disaient ni que la transaction
est à usage unique, ni quoi faire. Proposition : généraliser la page d'erreur HTML
actionnable (titre, cause publique, action attendue) à toutes les réponses
navigateur, y compris « Origine refusée » de `src/index.ts`. Bénéfice : moins de
fausses alertes et de diagnostics longs. Effort : petit. Risques : ne jamais
inclure d'URL automatique ni de détail sensible. Critère : chaque réponse
d'erreur navigateur indique une action possible sans exposer de données. Limite :
seul `src/auth/handler.ts` est corrigé ici ; `src/index.ts` non modifié sans
demande. Suite : avis du propriétaire.
Merci aux collaborateurs pour les diagnostics antérieurs et la relecture.


### RETOUR-2026-10-03-chatgpt-batch-apply-v1
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Tâche : `rfkevin/github-mcp`, PR #23, head avant journaux `bc067020d6b9accd28ba0026755ea4bacfade1e7`
Expérience : implémentation réelle, lectures groupées, écritures ciblées, plusieurs cycles CI GitHub et revue de #22.

Avis sur l’existant : accord renforcé avec `IMP-2026-10-01-codex-etat-reprise` (P2) : le couple PR/head exact + CI a permis de reprendre après chaque correction sans rejouer une écriture. Accord avec `IMP-2026-10-02-chatgpt-stabilite-catalogue` (P1) : au début de cette mission, des outils découverts ont encore produit `Resource not found`, alors qu’un autre client pouvait les invoquer ; la cause reste non prouvée. `IMP-2026-10-01-codex-validation-clients` reste P1 avant de considérer le nouvel outil réellement disponible après publication.

Classement personnel : 1. validation-clients — P1 ; 2. stabilite-catalogue — P1 ; 3. etat-reprise — P2 ; 4. nouvelle proposition ci-dessous — P2 ; 5. reprise — P2.

**IMP-2026-10-03-chatgpt-ci-attentes-derivees — P2.** Outil/cas : ajout d’un nouvel outil au catalogue MCP. Problème/preuve : après ajout correct de `github_apply_changes` à `WRITE_TOOLS`, la CI a échoué car une seconde liste littérale de `test/oauth/catalogue.spec.ts` décrivait séparément les outils portant `agentLabel`. Le code fonctionnel et le helper étaient cohérents, mais cette attente dupliquée n’était pas dérivée de la source commune. Proposition : dériver les attentes de catalogue par propriété/metadata ou exporter une source de vérité testable, plutôt que maintenir plusieurs listes manuelles. Bénéfice : moins de cycles CI après chaque ajout d’outil et moins de risque d’oublier une surface OAuth. Effort : petit à moyen ; risque : un test trop dérivé pourrait ne plus détecter une erreur de catalogue, donc garder au moins une assertion indépendante sur les frontières de permissions. Critère : ajouter un outil write signé dans une fixture de test ne nécessite qu’une modification de la source de vérité et les tests continuent de vérifier scope + `agentLabel` sans liste parallèle. Limite : l’échec actuel était facile à diagnostiquer via les annotations CI et a été corrigé. Suite suggérée : refactor séparé, pas dans #23 sauf décision du propriétaire. Merci aux collaborateurs pour les retours de #22 et la revue à venir.

### RETOUR-2026-10-03-vibe-revue-pr23
Auteur : Vibe (GLM, glm-5-latest) | Tâche : revue de la PR #23 (`batch-apply-v1-clean`), head `c009b72`, base `0785f4b`
Expérience : relecture complète du code batch (schema/snapshot/plan/coordinator), suivi CI réel au SHA exact ; accord final publié (commentaire 5968081348).

Avis sur l'existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) —
la CI verte au SHA exact a de nouveau été le seul critère fiable avant fusion.
Accord avec `IMP-2026-10-01-codex-etat-reprise` (P2) : la reprise propre de #22
depuis master, sans reprise automatique des commits, a évité de perpétuer les bugs
revus. `IMP-2026-10-02-chatgpt-stabilite-catalogue` : non vérifié ici.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ;
3. reprise — P2 ; 4. preuve-revue — P2 conditionnelle.

**IMP-2026-10-03-vibe-couchees-imports-batch — P3.** Outil/cas : `github_apply_changes`,
découpage `src/writes/batch/`. Problème/preuve : `plan.ts` importe `publicFailure`
depuis `src/mcp/tools/github/result`, donc la couche `writes` dépend de la couche
`mcp` (sens inversé). Sans risque fonctionnel ; complexifie les tests et une
future extraction. Proposition : descendre `publicFailure` (ou un utilitaire de
classification d’erreurs public) vers une couche basse partagée. Bénéfice : sens
d'imports homogène, tests de plan sans dépendance MCP. Effort : petit. Risques :
aucun comportemental, chemin public à conserver. Critère : plus aucun import de
`src/mcp/**` depuis `src/writes/**` ; CI verte.

**IMP-2026-10-03-vibe-test-toctou-batch — P2.** Outil/cas : lot batch entre snapshot
et commit. Problème/preuve : la garantie anti-concurrence repose sur
`expectedHeadSha` du `WriteCoordinator`, mais aucun test n'affirme explicitement le
scénario « head change entre le snapshot et le commit → rejet sans mutation ».
La garantie existe (coordonnateur), le contrat de la V1 devrait la documenter par un
test. Bénéfice : la garantie centrale de la V1 devient vérifiée et visible pour la
V2. Effort : petit. Risques : aucun. Critère : un test simule le head qui bouge
après le snapshot et vérifie zéro commit et une erreur propre.
Merci à l’auteur de la PR #23 et aux collaborateurs pour la reprise propre.


### RETOUR-2026-10-03-chatgpt-oauth-observabilite
Auteur : ChatGPT (OpenAI, GPT-5.6 Sol) | Tâche : diagnostic OAuth #25, base `7a644ac546615b091c221daa7807728398e82529`

Avis sur l’existant : `IMP-2026-10-01-codex-validation-clients` reste P1 et est directement applicable : sans SHA publié + essai client réel, un 302 serveur ne prouve pas la reconnexion. `IMP-2026-10-02-chatgpt-stabilite-catalogue` reste P1 mais distinct de ce défaut. `IMP-2026-10-02-vibe-erreurs-actionnables` reste P2 utile. Classement : 1. validation-clients P1 ; 2. stabilite-catalogue P1 ; 3. erreurs-actionnables P2 ; 4. etat-reprise P2. Besoin nouveau : aucun ; l’instrumentation minimale de #25 peut utiliser les logs Workers existants sans ajouter d’outil ni de permission. Limite : la réception du callback reste observable uniquement côté client. Merci aux collaborateurs pour les retours précédents.


### RETOUR-2026-10-03-codex-oauth-navigation-pc
Auteur : Codex | Tâche : connexion PC prioritaire et prévention du double clic

Classement et avis : 1. IMP-2026-10-01-codex-validation-clients (P1), renforcé : les tests HTTP ne voient pas le blocage CSP appliqué aux redirections par le navigateur ; 2. IMP-2026-10-02-vibe-erreurs-actionnables (P2), progression visible et secours utiles sans exposer de secret ; 3. IMP-2026-10-01-codex-etat-reprise (P2), distinguer un callback 302 émis d’une connexion terminée, et recommencer avec une transaction neuve ; 4. IMP-2026-10-02-chatgpt-stabilite-catalogue (P1, cause distincte non confirmée). Besoin déjà couvert par #25 : ajouter la reproduction navigateur locale au protocole de recette. Les traces en direct ont subi des reconnexions ; seuls événements/étapes/statuts ont été exploités, jamais les codes transmis par le propriétaire. Pas de nouveau droit ni d’outil demandé. Suite : vérifier le parcours réel après publication humaine. Merci aux collaborateurs.

### RETOUR-2026-10-07-claude-batch-toctou-couches
Auteur : Claude (Anthropic, Opus 5.5 configuré) | Tâche : `rfkevin/github-mcp`, PR #53, base `cd8089a`
Expérience : usage réel du MCP (contexte, lectures groupées, branche, deux `github_apply_changes`, PR, suivi CI) ; tests locaux avec GitHub simulé.

Avis sur l’existant : `IMP-2026-10-03-vibe-test-toctou-batch` → traité par #53, avec un test qui traverse le vrai service de commits (un mock du coordinateur n'aurait rien prouvé). `IMP-2026-10-03-vibe-couchees-imports-batch` → traité pour writes et merges, verrouillé par un test d'architecture ; nuance : `src/integration` reste couplé à `src/mcp` (context, ci, verification), à traiter séparément. `IMP-2026-10-03-chatgpt-ci-attentes-derivees` → accord, non vérifié ici (aucun outil ajouté). `IMP-2026-10-01-codex-validation-clients` → accord P1. `IMP-2026-10-02-chatgpt-stabilite-catalogue` → non reproduit dans cette session : tous les outils chargés ont répondu.

Classement personnel : 1. validation-clients — P1 ; 2. stabilite-catalogue — P1 conditionnel à une reproduction ; 3. etat-reprise — P2 ; 4. ci-attentes-derivees — P2 ; 5. nouvelle proposition ci-dessous — P3.

**IMP-2026-10-07-claude-replace-ancre — P3.** Outil/cas : `replace` de `github_apply_changes` pour supprimer ou déplacer un gros bloc. Problème/preuve : déplacer ~60 lignes vers un nouveau module a imposé d'envoyer le bloc deux fois (création + `oldText` exact), soit ~6 Ko recopiés à la main ; une faute de frappe aurait été refusée (sûr) mais coûteuse. Proposition : variante `replaceRange` bornant le bloc par deux ancres uniques courtes (`startText`, `endText`) avec le SHA du blob, ou opération `move` intra-dépôt. Bénéfice : moins d'octets et de risque de transcription lors des refactors. Effort : petit à moyen ; risque : ancres ambiguës, à refuser si non uniques ou chevauchantes. Critère : déplacer un bloc de 60 lignes en envoyant moins de 300 caractères d'ancrage, avec rejet sans écriture en cas d'ancre multiple. Merci aux collaborateurs.

### RETOUR-2026-10-04-deepseek-consultation-reelle
Auteur : DeepSeek (DeepSeek, v4-pro) | Tâche : consultation finale T50 `rfkevin/project-mcp-collab` #2 ; connexion réelle d'un client au MCP (OAuth + débogage), lectures d'issues/discussions, commentaires
Expérience : essai réel — OAuth de bout en bout, `github_get_issue`, `github_list_discussion_items`, `github_get_issue_comment`, `github_comment_issue` ; aucune modification du serveur.

Avis sur l'existant :
- `IMP-2026-10-01-codex-validation-clients` → accord renforcé (P1) : le catalogue varie par client ; `list_discussion_items`/`get_issue_comment` sont exposées dans ce client, absentes chez Codex. La règle « vérifier le catalogue réel du client » a évité des hypothèses.
- `IMP-2026-10-04-antigravity-discussion-index` → accord (P2), vécu : `github_get_issue` a tronqué le corps de l'issue #2 (`bodyTruncated: true`) ; la lecture ciblée par ID a rendu les corps complets.
- `IMP-2026-10-01-codex-etat-reprise` → accord (P2), utile pour reprendre entre phases sans rejouer d'écritures.
- `IMP-2026-10-02-chatgpt-stabilite-catalogue` → non vérifié (aucun « Resource not found » rencontré dans cette session).

Classement personnel : 1. validation-clients — P1 ; 2. nouvelle proposition ci-dessous — P2 ; 3. antigravity-discussion-index — P2 ; 4. etat-reprise — P2 ; 5. stabilite-catalogue — P1 (à confirmer par d'autres essais).

**IMP-2026-10-04-deepseek-route-auth-401-sous-chemin — P2.**
Outil/cas : connexion d'un client MCP au serveur ; un sous-chemin sous `/mcp` est pointé par erreur.
Problème/preuve : `OAuthProvider` est monté avec `apiRoute: '/mcp'` (`src/index.ts`) ; le provider challenge donc toute l'arborescence `/mcp/*` (401 sans jeton) alors que seul `/mcp` appelle `mcpHandler`. Vécu : `POST /mcp/collaboration` sans jeton → 401 (fait croire que l'URL est bonne), avec jeton valide → 404 « Not Found ». Le `www-authenticate` pointait bien `resource_metadata` → `"resource": ".../mcp"`, mais aucun client ne la résolvait automatiquement. ~30 min perdues.
Proposition : (a) ne challenger que le chemin exact du handler et laisser les sous-chemins inconnus répondre 404 ; ou (b) faire lire aux clients la métadonnée `resource` et journaliser un avertissement quand l'URL fournie diffère. Sans correctif, documenter ce comportement dans `docs/mcp-compatibility.md`.
Bénéfice : distinguer « mal authentifié » de « mauvais chemin » sans aller-retour ; moins de diagnostics erronés.
Effort/risques : petit (routage) à moyen (clients) ; risque d'élargir le périmètre d'authentification si le challenge est mal recentré.
Critère de réussite : un client pointant un sous-chemin inexistant reçoit un 404 clair (ou un avertissement de ressource) avant tout essai d'authentification, sans jeton valide.
Limites : cause confirmée par lecture de `src/index.ts` et comportement HTTP observé ; le comportement exact du provider sur les sous-chemins reste à valider en test.
Suite suggérée au propriétaire : choisir (a) ou (b), ou documenter en attendant un besoin réel.
Merci aux collaborateurs (Codex, Vibe GLM, Grok, ChatGPT, Antigravity) et à Kevin.

### RETOUR-2026-10-05-vibe-edition-suppression-commentaires
Auteur : Vibe GLM (Mistral, glm-5-latest) | Tâche : essai multi-agents `rfkevin/project-mcp-collab` (issues #1/#3, PRs #4-#14), main `f55ab46`, PR #14 head `194c6d2` ; contexte : consolidation T60 + test R6 indépendant par ChatGPT (commentaire 5988954087).
Expérience : réelle — publication et lecture lossless de ~40 commentaires de coordination, reviews au SHA exact, exécution des scénarios V01-V16.

**IMP-2026-10-05-vibe-edition-suppression-commentaires — P2.** Outil/cas : commentaires d'issue et de PR — le canal de communication principal du workflow multi-agents.
Problème/preuve (trois incidents réels du trial) :
1. V04-EDIT (détection d'édition) : aucun client exposé n'a d'outil d'édition → l'exercice a dû être une simulation disclosed (record Vibe 5982627823) ; ChatGPT, testeur indépendant, a confirmé la même absence (5988954087).
2. R6 `github_get_discussion_delta` : les modes `modified`/`deleted` restent sans run indépendant faute d'outils d'édition/suppression pour les produire (disclosure PR #14) — l'outil ne peut pas être pleinement validé par ses utilisateurs.
3. V15 (wrong-target, incident Claude documenté dans l'issue #2, commentaire 5979384064) : un commentaire posté sur la mauvaise issue persiste définitivement ; aucune remédiation possible.
Proposition : deux opérations serveur-side avec préconditions strictes — `github_edit_issue_comment` (commentId + expectedContentHash ou expectedUpdatedAt du corps actuel + nouveau texte ; le serveur remplace par le nouveau texte et GitHub conserve l'historique d'édition public natif, aligné avec l'esprit append-only) et `github_delete_issue_comment` (gated : autorisation explicite du propriétaire par dépôt, jamais par défaut). Comme pour les fichiers, toute édition doit porter la trace MCP (agent déclaré, date).
Bénéfice : V04-EDIT devient testable en réel ; les modes R6 modified/deleted deviennent vérifiables ; les erreurs de ciblage deviennent corrigeables ; la détection d'édition (updatedAt au même ID) cesse d'être une fixture théorique.
Coût/risques : petit effort (l'API GitHub existe : PATCH/DELETE /repos/{}/issues/comments). Risque principal, à ne pas cacher : **tous les agents partagent le même compte bot**, donc le serveur ne peut pas distinguer l'auteur — n'importe quel agent pourrait réécrire le commentaire d'un autre. Mitigations : précondition obligatoire sur le contenu (l'éditeur doit prouver qu'il a lu l'état actuel, collision = refus), historique d'édition public GitHub conservé (toute réécriture est visible et traçable), et pour la suppression : opt-in par dépôt par le propriétaire uniquement.
Critère de réussite : un commentaire de >4000 B édité via MCP apparaît `modified` dans `github_get_discussion_delta` avec le même ID ; la réédition avec un expectedContentHash périmé est refusée ; la suppression n'est possible que sur un dépôt explicitement autorisé.
Priorité : P2 — gain récurrent à chaque cycle de collaboration.

Avis sur l'existant : `IMP-2026-10-01-codex-preuve-revue` (P2) reste pertinent et distinct : il traite de l'identité des relecteurs, pas de la mutabilité des commentaires ; l'édition avec historique public GitHub renforce même sa thèse (traçabilité). `IMP-2026-10-04-claude-lecture-corps-issue` (P2, à consigner) est complémentaire : lecture lossless des corps + édition/suppression des commentaires couvrent le cycle de vie complet du canal. Aucune proposition existante ne couvre l'édition ou la suppression de commentaires (27 entrées vérifiées).
Classement personnel actualisé (parmi les besoins ouverts) : 1. validation-clients (P1, préalable à toute attestation) ; 2. stabilite-catalogue (P1) ; 3. edition-suppression-commentaires (P2, ce retour) ; 4. lecture-corps-issue (P2) ; 5. preuve-revue (P2). Je ne remplace aucun classement existant.
Limite : je n'ai pas testé l'API GitHub d'édition/suppression en direct ; l'effort annoncé est estimé depuis la documentation publique, pas mesuré. Merci à Claude pour la consolidation PR #14 qui a rendu ce gap visible, à ChatGPT pour le test R6, et à Kevin pour l'arbitrage du workflow.
### RETOUR-2026-10-07-claude-cc3-k5-c5
Auteur : Claude (Anthropic, Opus 5.5 configuré) | Tâche : `rfkevin/github-mcp`, `cc3-integration` `8d2d998` → `298ef4d` ; PR #62, #63 (fusionnées), #64 (C5) ; revue de #60
Expérience : essai réel de `github_run_checks` sur cc3-test, lecture de journaux Workers, écritures par lots, revue avec `check:full` local au SHA exact.

Avis sur l'existant : `IMP-2026-10-01-codex-validation-clients` → accord renforcé (P1) : deux sessions du même client voyaient 36 et 38 outils selon le jeton émis ; seul un essai daté par session est probant. `IMP-2026-10-02-chatgpt-stabilite-catalogue` → nuance : ici l'écart venait des scopes du jeton, pas d'une instabilité ; distinguer les deux causes avant tout correctif. `IMP-2026-10-02-vibe-erreurs-actionnables` → traité en partie par #62 (code fermé dans le texte des échecs d'outil, motifs OAuth `client_unknown`, `redirect_uri_invalid`, `resource_invalid`, `oauthError`). `IMP-2026-10-07-claude-replace-ancre` → renforcé : C5 a demandé de recopier environ 40 Ko à la main. `IMP-2026-10-04-deepseek-route-auth-401-sous-chemin` et `IMP-2026-10-05-vibe-edition-suppression-commentaires` (PR #33 et #35 non intégrées) → non vérifiés dans cette tâche.

Classement personnel : 1. validation-clients — P1 ; 2. nouvelle proposition ci-dessous — P2 ; 3. replace-ancre — P2 (remontée depuis P3) ; 4. etat-reprise — P2 ; 5. stabilite-catalogue — P1 conditionnel à une reproduction hors changement de scopes.

**IMP-2026-10-07-claude-patch-unifie — P2.** Outil/cas : `github_apply_changes` pour un lot déjà écrit et testé localement. Problème/preuve : C5 (22 fichiers, environ 1 300 lignes) a été publié en cinq appels, en recopiant chaque fichier ; la seule garantie contre une erreur de transcription a été un `git diff` manuel après coup. Proposition : opération `patch` acceptant un diff unifié par fichier, avec le SHA du blob de base, appliqué sans fuzz (contexte exact exigé, sinon refus sans écriture). Bénéfice : publier exactement l'arbre testé, avec moins d'octets et sans recopie. Effort : moyen. Risques : diff ambigu ou fins de ligne ; refuser tout hunk non exact et préserver CRLF/BOM comme `append`. Critère : un lot de 20 fichiers publié en un appel dont l'arbre résultant est identique octet pour octet à l'arbre local testé ; tout hunk décalé est refusé. Limites : besoin observé sur un seul gros lot. Suite suggérée au propriétaire : décider entre `patch` et `replaceRange`, sans les cumuler.
Merci aux collaborateurs pour leurs propositions et leurs relectures.


### RETOUR-2026-10-07-vibe-cc3-c2
Auteur : Vibe GLM | Tâche : `rfkevin/github-mcp`, lot C2 (PR #60), base `54a2c03`, head mergé `3a82d3f`
Expérience : usage réel intensif du MCP sur un lot complet (branche, 6+ `github_apply_changes` multi-fichiers, commit de merge via `github_resolve_conflicts` sur base avancée, PR draft, suivi CI à chaque SHA, 3 reviews croisées, consignations board). Dette assumée depuis CC-1 : ce retour clôture ma contribution en retard.

Avis sur l'existant :
- `IMP-2026-10-03-vibe-couchees-imports-batch` et `IMP-2026-10-03-vibe-test-toctou-batch` : traités par #53 (confirmé, mes lots C2 ont bénéficié du sens d'imports propre et de la garantie anti-concurrence sans régression).
- `IMP-2026-10-07-claude-replace-ancre` : accord, vécu aussi en C2 — déplacer de gros blocs (schéma SQL canonique, wrangler.jsonc) a imposé des `oldText` longs et coûteux à transcrire exactement.
- `IMP-2026-10-02-vibe-erreurs-actionnables` : renforcé — deux diagnostics C2 (UNEXPECTED_ERROR de `ensureSchema`, 404 du SDK sur `route` non documentée) n'ont été résolus qu'en lisant le source ; le motif public aidait mais pas la cause.
- `IMP-2026-10-02-chatgpt-stabilite-catalogue` : non reproduit dans cette session (connecteur cc3 stable, 38 outils répondants).
- `IMP-2026-10-01-codex-validation-clients` : reste P1 ; incident réel supplémentaire en C2 : `ci` (pull_request, in-repo) jamais déclenché pour 2 commits utiles — incident de livraison d'événements GitHub, `github_run_checks` aurait été le recours documenté ; détection uniquement par vérification explicite des runs au SHA.

Classement personnel : 1. validation-clients — P1 ; 2. stabilite-catalogue — P1 conditionnel à reproduction ; 3. erreurs-actionnables — P2 ; 4. limites-message-commits — P3 ; 5. lecture-octets-exacts — P3.

**IMP-2026-10-07-vibe-limites-message-commits — P3.** Outil/cas : `message` de `github_commit_changes`/`github_append_file`/`github_resolve_conflicts`. Problème/preuve : la doc annonce 200 caractères mais le message complet « avec trace MCP » doit tenir dedans — refus `MESSAGE_TOO_LONG` observé à ~186 caractères, succès seulement en raccourcissant vers ~140. La limite effective dépend du suffixe de trace, inconnu du client. Proposition : énoncer dans l'erreur la limite effective (200 moins la longueur de la trace) ou une marge conseillée ; idéalement relever le plafond. Bénéfice : moins d'allers-retours sur les commits ; effort trivial ; risque aucun. Critère : l'erreur `MESSAGE_TOO_LONG` contient la taille max utilisable pour le message utilisateur.

**IMP-2026-10-07-vibe-lecture-octets-exacts — P3.** Outil/cas : `github_read_file`/`github_read_files` pour reconstruire un fichier à l'octet près (résolution de conflits, égalité de schéma). Problème/preuve : le contenu renvoyé omet le `\n` final du fichier — en C2 j'ai dû deviner et reconstituer `stripped + '\n'` pour reproduire la taille exacte du blob `wrangler.jsonc` lors du commit de merge ; une reconstruction naïve aurait produit un diff parasite. Proposition : renvoyer le contenu exact (y compris l'octet final) ou exposer un indicateur (`size` du blob déjà présent + flag `trailingNewline`). Bénéfice : reconstructions byte-exactes sans heuristique ; effort petit ; risque aucun. Critère : reconstruire un fichier quelconque depuis `github_read_file` produit un blob de SHA identique à l'original.

Merci aux collaborateurs, en particulier Claude pour deux reviews précises et à Grok d'avoir pris le test C2 en relais.

### RETOUR-2026-10-08-claude-fusion-journaux-divergents
Auteur : Claude | Tâche : CC-3 C6, resynchronisation de #75 sur `cc3-integration@ad31913` | Correction : branche `mcp/105856986/claude-journal-merge-union`

**IMP-2026-10-08-claude-fusion-journaux-divergents — P1, corrigé dans cette PR.** Outil/cas : `github_resolve_conflicts` quand une branche et sa base ont chacune ajouté une note à `AGENT_MEMORY.md` ou `TOOL_IMPROVEMENTS.md` depuis l'ancêtre (le cas normal de deux agents en parallèle). Problème/preuve : `assertJournals` exigeait que ours **et** theirs soient des préfixes octet par octet du résultat, ce qui est impossible avec deux ajouts divergents : `theirs`, `ours` et deux ordres de `content` ont tous été refusés sur #75 (C6 bloqué). Correction : on accepte aussi theirs intact au début, puis l'ajout de la branche (ours moins l'ancêtre, sauts de ligne de tête ignorés), puis d'éventuelles notes, à condition que l'ancêtre soit un préfixe des deux côtés. Rien ne peut disparaître, et la fusion ultérieure vers la base reste un ajout pur (`verifyMemory` de l'intégration). Critère : les deux journaux réels de #75 passent dans l'ordre base puis branche ; l'ordre inverse, un ajout modifié, tronqué, absent ou déplacé, une base réécrite et un historique commun réécrit sont refusés sans écriture (tests `test/merges/service.spec.ts`). Merci à Kevin pour l'arbitrage rapide.


### RETOUR-2026-10-05-gpt56sol-cc2-l4
Auteur : GPT-5.6 Sol | Tâche : CC-2 L4 receipts/reconciliation, base integration `a22f6f243aaef6d7282849bc8c2375460809af03`
Expérience : lectures/écritures MCP réelles sur branche dédiée, reprise au SHA exact et baseline CC-2 mesurée.

Avis : `IMP-2026-10-01-codex-validation-clients` reste P1 : L4 ne doit pas être considéré disponible avant CI, publication et essai client réel. `IMP-2026-10-02-chatgpt-stabilite-catalogue` reste P1 ; aucune nouvelle preuve causale dans ce lot. `IMP-2026-10-01-codex-etat-reprise` est directement renforcé par L4 : un résultat d’écriture inconnu exige readback/reconciliation, jamais rejeu aveugle. `IMP-2026-10-03-vibe-test-toctou-batch` reste P2 et complémentaire pour les commits de fichiers. Classement personnel : 1. validation-clients P1 ; 2. stabilite-catalogue P1 ; 3. etat-reprise P2 ; 4. test-toctou-batch P2 ; 5. reprise P2. Aucun nouveau besoin distinct : les reçus/réconciliation sont le lot demandé, pas une proposition d’élargissement de droits. Limite : la façade exchange est différée faute de comparaison réelle suffisante. Merci aux collaborateurs pour leurs mesures et objections.


### RETOUR-2026-10-06-gpt56sol-cc2-f2-staging
Auteur : GPT-5.6 Sol | Tâche : préparation du staging F2 CC-2, base `4a15d9a9c8bd3c13adf309a5c26d5a222889b86d`

Avis : `IMP-2026-10-01-codex-validation-clients` reste P1 et devient le critère central de F2 : le code CC-2 doit être publié sur une instance de test puis exercé par de vrais clients avant validation opérationnelle. `IMP-2026-10-02-chatgpt-stabilite-catalogue` reste P1, sans nouvelle preuve causale. `IMP-2026-10-01-codex-etat-reprise` reste P2, particulièrement pour les écritures de sandbox. Classement : 1. validation-clients P1 ; 2. stabilite-catalogue P1 ; 3. etat-reprise P2 ; 4. erreurs-actionnables P2. Aucun nouveau besoin d'outil GitHub : la limite actuelle est volontairement côté infrastructure Cloudflare (KV/secrets/déploiement), hors capacité du connecteur GitHub. Merci aux collaborateurs.


### RETOUR-2026-10-08-gpt56sol-cc3-c3-review
Auteur : GPT-5.6 Sol | Tâche : `rfkevin/github-mcp`, PR #70, corrections C3 après review Claude
Expérience : écritures MCP réelles, review au SHA exact, suivi CI et tentative de `github_run_checks`.

Avis sur l’existant : accord renforcé avec `IMP-2026-10-01-codex-etat-reprise` (P2) : la review au SHA exact a permis de reprendre directement sur deux défauts reproductibles sans confondre CI verte et contrat fonctionnel. `IMP-2026-10-01-codex-validation-clients` reste P1 avant essai C7. La tentative de `github_run_checks` a encore été refusée parce que le controller SHA ne correspond plus à la branche par défaut ; ce cas est déjà couvert par K5/T0, donc aucune nouvelle proposition distincte.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. stabilite-catalogue — P1 mais non observée ici ; 4. reprise — P2. Limite : agent-checks indisponible dans cette tâche, CI standard utilisée comme preuve au SHA. Suite : terminer K5/T0 puis vérifier que le même SHA peut lancer un contrôle ciblé sans intervention supplémentaire. Merci aux collaborateurs pour les diagnostics actionnables.


### RETOUR-2026-10-08-gpt56sol-c4-finition
Auteur : GPT-5.6 Sol | Tâche : `rfkevin/github-mcp`, PR #67 C4, reprise de finition au head `9f63139`
Expérience : modification MCP réelle, diagnostic CI au SHA exact et intégration C4/C5.

Avis sur l’existant : `IMP-2026-10-01-codex-etat-reprise` reste P2 et s’est montré utile pour reprendre C4 sans refaire le lot ; `IMP-2026-10-01-codex-validation-clients` reste P1 avant C7. Le refus de `github_run_checks` après changement du contrôleur est déjà couvert par les travaux K5/T0 et par mon retour C3 ; je ne crée donc pas de proposition doublon. Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. reprise — P2 ; 4. preuve-revue — P2 conditionnelle. Nouvelle proposition : aucune. Le besoin observé est surtout orchestrationnel : invalider automatiquement les rôles/reviews quand un reviewer devient auteur, déjà consigné dans l’issue de coordination #25 pour le futur Coordinateur. Merci aux collaborateurs pour les diagnostics et la reprise progressive de C4.

### RETOUR-2026-10-08-claude-cc3-c6
Auteur : Claude | Tâche : `rfkevin/github-mcp`, lot C6 (export GitHub et documentation), publication par `github_apply_changes` en sept commits

Expérience : publier un lot d’environ 2000 lignes passe uniquement par le contenu inline de `github_apply_changes` ; chaque fichier doit être recopié dans l’appel, puis vérifié par comparaison de blobs (`git hash-object` contre l’arbre publié) — toutes les comparaisons ont été identiques. Constat factuel : après le mouvement de `cc3-integration` (#72), `github_get_pull_request` renvoyait encore l’ancienne base (`298ef4d`) pour #67 et #71 alors que la garde de `github_comment_pull_request` exigeait la base vivante (`33d6602`) ; l’agent doit deviner laquelle fournir.

Propositions : `IMP-2026-10-08-claude-base-coherente` (P2) : `github_get_pull_request` expose aussi la pointe vivante de la branche de base (`liveBaseSha`) utilisée par la garde de revue, ou la garde accepte la base enregistrée par GitHub. `IMP-2026-10-08-claude-copie-de-ref` (P3) : une opération `restore` depuis un SHA de la même branche existe déjà ; une variante « copier un fichier depuis une autre branche de lot du même dépôt » éviterait de recopier de gros fichiers déjà publiés. Avis sur l’existant : `IMP-2026-10-01-codex-validation-clients` reste P1 (C6 doit encore être exercé sur cc3-test par un vrai client). Merci aux collaborateurs.


### RETOUR-2026-10-10-gpt6-cc3-owner-origin
Auteur : ChatGPT GPT-6 | Tâche : `rfkevin/github-mcp`, branche `mcp/105856986/gpt6-cc3-owner-origin-policy`, base `8d932ea`.
Expérience : diagnostic réel des journaux Cloudflare transmis par le propriétaire, code source et tests de `/owner` consultés via MCP, documentation HTTP vérifiée. Le défaut n’est pas une limite des outils GitHub : le test unitaire de formulaire simulait un en-tête `Origin` déjà correct.
Avis sur l’existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) ; l’essai navigateur a révélé un défaut invisible à la CI initiale. `IMP-2026-10-01-codex-etat-reprise` reste P2 pour le suivi d’une PR interrompue. La suggestion `IMP-2026-10-08-claude-base-coherente` est pertinente mais non éprouvée dans cette tâche.
Classement personnel : 1. validation-clients — P1, preuve d’un blocage réel ; 2. etat-reprise — P2, fiabilité ; 3. base-coherente — P2, risque de garde de SHA. Nouvelle proposition d’outil : aucune. Limites : validation distante après fusion par le propriétaire encore nécessaire. Merci aux collaborateurs.

### RETOUR-2026-10-10-gpt6-cc3-oauth-multiresource
Auteur : ChatGPT GPT-6 | Tâche : `rfkevin/github-mcp` PR #105, base `b1656fcc`.
Expérience : diagnostic de journaux Cloudflare fournis par Kevin (`resource_invalid`, `authorize.parse_request`), revue du code et des types de l'API officielle Cloudflare 1.x, CI sur SHA dédié. La première CI a détecté la perte de la page HTML 404 historique dans le nouveau routeur ; les annotations `github_get_failure_report` ont permis de localiser le test précis, sans logs contenant de secrets.
Avis existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) — les E2E simulées n'avaient pas couvert Grok avec ressource dédiée. Accord avec `IMP-2026-10-01-codex-etat-reprise` (P2) pour le suivi explicite du SHA et de ses contrôles. `IMP-2026-10-08-claude-base-coherente` (P2) n'est pas encore rééprouvé.
Classement personnel : 1. validation-clients P1 (échec réel bloquant K6) ; 2. etat-reprise P2 (CI et revue fiables) ; 3. base-coherente P2 (prévenir gardes périmées). Aucune nouvelle proposition : tests de non-régression et routage dans le produit, pas nouvelle capacité MCP. Limites : vrais parcours OAuth Claude/Grok non validés avant fusion/déploiement par Kevin. Merci aux collaborateurs.

### RETOUR-2026-10-11-vibe-cc4-a0
Auteur : Vibe GLM | Tâche : `rfkevin/github-mcp`, lot CC-4 A0 (issue #110), branche `mcp/105856986/vibe-cc4-a0`, base `cc3-integration`.

Expérience : lot de 28 opérations en un `github_apply_changes` atomique (5 créations + 23 remplacements), un commit par étape ; reprise au SHA exact après une interruption de conversation.

Avis sur l'existant : `IMP-2026-10-01-codex-etat-reprise` (P2) confirmé encore une fois — la reprise au SHA exact a permis de continuer le lot sans le refaire. `IMP-2026-10-08-claude-copie-de-ref` (P3) renforcé : les gros lots inline restent lourds à recopier. `IMP-2026-10-01-codex-validation-clients` reste P1, hors périmètre de ce lot.

Nouvelle proposition : `IMP-2026-10-11-vibe-sha-lecture` (P2) — `expectedSha` de replace/append oblige à recopier à la main un SHA de blob de 40 hex ; une erreur de transcription (0 ↔ e sur tool-binding.spec.ts ce jour ; preuve : rejet `EXPECTED_SHA_CONFLICT`, lot atomique non écrit) coûte le renvoi complet du lot. Proposition : accepter une référence par chemin au head courant, ou renvoyer le blob SHA réel dans le message d'erreur. Bénéfice : moins d'allers-retours ; coût : faible ; risque : aucun (la garde reste). Critère de réussite : un lot renvoyé sans recopie manuelle de SHA. Classement personnel : 1. validation-clients P1 ; 2. etat-reprise P2 ; 3. sha-lecture P2 ; 4. base-coherente P2 ; 5. copie-de-ref P3. Merci aux collaborateurs.

### RETOUR-2026-10-12-gpt6-cc4-a1
Auteur : ChatGPT GPT-6 | Tâche : `rfkevin/github-mcp` PR #114, CC-4 A1, base `196f0ac`
Expérience : implémentation réelle via MCP, trois cycles CI exact-SHA et une PR vers la branche d’intégration.

Avis sur l’existant : accord avec `IMP-2026-10-01-codex-validation-clients` (P1) : les checks au SHA exact ont détecté successivement un défaut de type puis une fuite d’état entre tests, invisibles au seul diff. `IMP-2026-10-01-codex-etat-reprise` reste P2 : le couple PR/head a permis de reprendre chaque correction sans dupliquer la PR. Nuance favorable à `IMP-2026-10-08-claude-base-coherente` (P2) : `github_create_branch` a répondu « ressource introuvable » avec le nom court `cc3-integration`, puis a réussi avec le vrai ref `mcp/105856986/cc3-integration`; rendre le ref résolu plus explicite réduirait cette ambiguïté. `IMP-2026-10-01-codex-reprise` reste P2 pour les attentes CI, sans besoin nouveau démontré ici.

Classement personnel : 1. validation-clients — P1 ; 2. base-coherente — P2 ; 3. etat-reprise — P2 ; 4. reprise — P2. Nouvelle proposition : aucune, l’expérience complète les besoins existants. Limite : les tests A1 utilisent D1 simulé/preview, aucun fournisseur réel. Suite : revue Claude, test Vibe, puis décision de Kevin. Merci aux collaborateurs pour les retours et critères de preuve.

### RETOUR-2026-10-13-sol-cc4-a3c-a4-mini
Auteur : ChatGPT GPT-5.6 Sol | Tâche : `rfkevin/github-mcp` issue #119 / PR #120, base `442e97e`
Expérience : développement multi-fichiers A3c/A4-mini, PR brouillon et CI exact-SHA ; le lancement ciblé `github_run_checks` a été refusé car le contrôleur configuré ne correspond plus à la branche par défaut et demande une validation administrateur.

Avis sur l’existant : `IMP-2026-10-01-codex-validation-clients` reste **P1** : la CI au SHA exact a immédiatement trouvé un défaut de narrowing TypeScript que la seule lecture du diff n’avait pas prouvé. `IMP-2026-10-01-codex-etat-reprise` reste **P2** : le couple branche/PR/head a permis de corriger sans recréer de PR. `IMP-2026-10-08-claude-base-coherente` reste **P2** : l’exigence de base exacte `442e97e` et sa vérification avant PR ont évité d’absorber silencieusement un autre head d’intégration. `IMP-2026-10-01-codex-reprise` reste **P2**, notamment pour rendre les attentes de checks et les blocages de contrôleur plus actionnables.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. base-coherente — P2 ; 4. reprise — P2. Nouvelle proposition : aucune ; le refus explicite du runner ciblé fournit surtout un nouveau cas concret pour les propositions existantes. Limite : aucune sonde OpenRouter réelle dans ce lot auteur, conformément à la frontière secrets/owner. Suite : CI standard finale, revue Grok, test Vibe, puis preuve live par Kevin. Merci aux collaborateurs pour les retours et garde-fous accumulés.

### RETOUR-2026-10-13-sol-cc4-a4-coordinateur
Auteur : ChatGPT GPT-5.6 Sol | Tâche : `rfkevin/github-mcp` issue #121 / PR #122, base `61a4212`
Expérience : développement A4 multi-fichiers par commits atomiques, PR brouillon pour obtenir la CI standard puisque `github_run_checks` refuse toujours le contrôleur courant. La CI exact-SHA a d’abord localisé un défaut TypeScript précis, puis le test de couverture documentaire a listé exhaustivement les nouveaux outils/codes manquants au guide.

Avis sur l’existant : `IMP-2026-10-01-codex-validation-clients` reste **P1** : les diagnostics bornés de CI ont évité de deviner deux causes successives. `IMP-2026-10-01-codex-etat-reprise` reste **P2** : le couple PR/head exact a permis les corrections sans recréer le lot. `IMP-2026-10-01-codex-reprise` reste **P2** et est renforcé par le blocage récurrent du contrôleur de `github_run_checks`, qui empêche aussi le parcours prévu pour le testeur Vibe. `IMP-2026-10-08-claude-base-coherente` reste **P2** : le lot est parti de l’intégration live contenant #120, vérifiée par commit de merge.

Classement personnel : 1. validation-clients — P1 ; 2. reprise — P2 ; 3. etat-reprise — P2 ; 4. base-coherente — P2. Nouvelle proposition : aucune, le cas du contrôleur est déjà couvert ; priorité à sa revalidation administrative avant le test D12 plutôt qu’à un doublon d’outil. Limite : aucun appel fournisseur live pendant le développement ; les tests injectent un binding Workers AI. Suite : CI finale, Grok/Vibe, puis preuve live par Claude après fusion Kevin. Merci aux collaborateurs pour les diagnostics et garde-fous existants.


### RETOUR-2026-10-14-sol-identite-chatgpt
Auteur : ChatGPT GPT-5.6 Sol | Tâche : `rfkevin/github-mcp` issue #126 / PR #127, base `a0d41aa`
Expérience : changement transversal mais borné d’identité logique, avec commits atomiques et CI exact-SHA. Le premier passage Sonar a signalé une règle de fiabilité sur un tri sans comparateur ; le suivant a rendu ce contrôle vert. La CI a ensuite isolé uniquement les quatre codes d’erreur non documentés, ce qui confirme l’utilité du test de couverture documentaire.

Avis sur l’existant : `IMP-2026-10-01-codex-validation-clients` reste **P1**, car diagnostics CI/Sonar ont évité de deviner ; `IMP-2026-10-01-codex-etat-reprise` reste **P2** pour conserver head/base et reprendre proprement ; `IMP-2026-10-01-codex-reprise` reste **P2**, le contrôleur de `github_run_checks` restant le blocage récurrent ; `IMP-2026-10-08-claude-base-coherente` reste **P2**, puisque l’équivalence est bâtie sur l’intégration live post-A4. Classement : 1. validation-clients P1 ; 2. reprise P2 ; 3. etat-reprise P2 ; 4. base-coherente P2. Nouvelle proposition : aucune. Limite : le consensus GitHub reste déclaratif et n’est pas transformé en seconde validation par l’équivalence store ; les mémoires privées ne sont pas fusionnées. Suite : CI finale puis D12 Grok/Vibe. Merci aux collaborateurs pour les contrôles existants.


### RETOUR-2026-10-14-sol-identite-chatgpt-correctif
Auteur : ChatGPT GPT-5.6 Sol | Tâche : correctif de continuité #126 / PR #127

Rectification du retour précédent : la demande finale de Kevin inclut la continuité de contexte et de mémoire privée entre `gpt6` et `sol`, sans réécriture historique. Ce correctif reste de la logique produit du store, pas un besoin d’outil GitHub supplémentaire. Classement inchangé : 1. `IMP-2026-10-01-codex-validation-clients` P1 ; 2. `IMP-2026-10-01-codex-reprise` P2 ; 3. `IMP-2026-10-01-codex-etat-reprise` P2 ; 4. `IMP-2026-10-08-claude-base-coherente` P2. Nouvelle proposition : aucune. Point de vigilance renforcé : les labels de modèle ne doivent jamais créer artificiellement un pair D12 ; la famille owner-approved doit gouverner droits, visibilité et contrôles de pair de façon cohérente. Merci aux collaborateurs pour les garde-fous d’identité existants.

### RETOUR-2026-10-14-sol-pr127-review-claude
Auteur : ChatGPT GPT-5.6 Sol | Tâche : corrections de revue PR #127

Expérience : lecture complète d’un commentaire de revue long via `github_get_issue_comment`, corrections ciblées par commits atomiques, puis suivi CI au SHA exact. Avis existants : `IMP-2026-10-01-codex-validation-clients` reste **P1** — les quatre checks au nouveau head sont indispensables après chaque correctif de sécurité ; `IMP-2026-10-01-codex-etat-reprise` reste **P2**, le couple head/base ayant permis de distinguer l’ancien CHANGES_REQUESTED du nouveau diff ; `IMP-2026-10-01-codex-reprise` reste **P2** ; `IMP-2026-10-08-claude-base-coherente` reste **P2**. Classement : 1. validation-clients P1 ; 2. etat-reprise P2 ; 3. reprise P2 ; 4. base-coherente P2. Nouvelle proposition : aucune ; les outils actuels ont permis de lire l’avis non tronqué et de corriger sans contournement. Limite : la revue Claude et le test Vibe restent à renouveler au SHA final. Merci aux collaborateurs pour les retours précis.

### RETOUR-2026-10-14-vibe-cc-auto-t1
Auteur : Vibe GLM (GLM, glm-5-latest-short) | Tâche : `rfkevin/github-mcp`, CC-AUTO T1, branche `mcp/105856986/cc-auto-t1-owner-inbox`, base `mcp/105856986/cc3-integration` @ `63431adc`
Expérience : micro-pilote UX `/owner` publié par `github_create_branch` + `github_apply_changes` atomique + PR vers la branche d'intégration ; fiche UX et protocole mobile documentés sans code (#131/6174978140).

Avis sur l'existant : `IMP-2026-10-01-codex-validation-clients` reste **P1** et s'applique directement : le SHA déployé servant `/owner` en production n'est pas attesté (`deploy_not_verified`), donc une CI verte au SHA exact ne prouvera pas le comportement sur le téléphone de Kevin avant essai réel. `IMP-2026-10-01-codex-etat-reprise` reste **P2** : le couple branche/base/head a été vérifié avant chaque écriture. `IMP-2026-10-11-vibe-sha-lecture` : aucun incident ce jour (blob SHAs relus via `github_read_files` avant le lot), avis inchangé. `IMP-2026-10-08-claude-base-coherente` reste P2, non rééprouvé ici.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. reprise — P2 ; 4. base-coherente — P2 ; 5. sha-lecture — P2. Nouvelle proposition : aucune — le flux create_branch → apply_changes → PR a couvert le lot sans friction nouvelle. Limite : ni navigateur réel, ni essai client du dashboard modifié. Suite : revue/test D12 indépendants au SHA exact puis décision owner. Merci aux collaborateurs.

### RETOUR-2026-10-15-gpt6-r4-catalogue-dormant
Auteur : ChatGPT GPT-6 (Sol) | Tâche : `rfkevin/github-mcp` issue #139, base `db56ba9`
Expérience : attribution parallèle des missions via issues, branche dédiée, commit groupé du catalogue et des tests, correction atomique de deux chaînes de test, CI du SHA à contrôler.
Avis sur l'existant : `IMP-2026-10-01-codex-validation-clients` reste **P1** : ni un commit ni un Workers Build en cours ne valent CI réussie. `IMP-2026-10-01-codex-etat-reprise` reste **P2** : la séquence branche/head exact et comparaison de refs protège de la confusion entre lots simultanés. `IMP-2026-10-08-claude-base-coherente` reste **P2** ; `IMP-2026-10-11-vibe-sha-lecture` **P2** : un blob relu est requis pour appliquer plusieurs remplacements. Classement personnel : 1. validation-clients P1 ; 2. etat-reprise P2 ; 3. base-coherente P2 ; 4. sha-lecture P2. Aucun nouveau besoin d'outil démontré. Limite : publication et avis des autres clients non automatisés par les commentaires. Merci aux collaborateurs pour leurs expériences.

### RETOUR-2026-10-16-gpt6-r4-groq-concurrence
Auteur : ChatGPT GPT-6 (Sol) | Tâche : `rfkevin/github-mcp` PR #152, corrections Groq Free, base `50003c3`
Expérience : Grok a publié un nouveau commit pendant la préparation de mon lot `github_apply_changes` ; une relecture du head de PR a évité une écriture périmée. Les checks Sonar/CI ont ensuite confirmé sa factorisation des tests. Les commentaires techniques non liés à Groq ont été restaurés par remplacements ciblés au SHA attendu.
Avis existants : `IMP-2026-10-01-codex-etat-reprise` (P2) renforcé par le cas de commit concurrent, `IMP-2026-10-11-vibe-sha-lecture` (P2) par les blobs précis, `IMP-2026-10-01-codex-validation-clients` (P1) par Sonar après chaque SHA. Classement : 1. validation-clients P1 ; 2. etat-reprise P2 ; 3. sha-lecture P2. Pas de nouvel outil demandé ; prochaines validations D12 par des personnes non contributrices. Merci aux collaborateurs.


### RETOUR-2026-10-19-vibe-cc5-l5
Auteur : Vibe GLM (GLM) | Tâche : `rfkevin/github-mcp`, CC-5 lot L5 (PR #169), base `mcp/105856986/cc3-integration` @ `4ac625e`
Expérience : lot multi-fichiers par `github_apply_changes` atomiques, PR vers l'intégration, diagnostic CI au SHA exact après un premier head rouge (trois échecs de tests localisés fichier/ligne/message).

Avis sur l'existant : `IMP-2026-10-01-codex-validation-clients` reste **P1** — la CI au SHA exact a détecté des échecs invisibles à la lecture du diff, et `github_get_failure_report` les a bornés sans logs bruts ni secrets, ce qui renforce aussi `IMP-2026-10-01-codex-reprise` (P2, diagnostics actionnables). `IMP-2026-10-01-codex-etat-reprise` reste **P2** : le couple head/base exact a permis de corriger sans recréer la PR. `IMP-2026-10-11-vibe-sha-lecture` reste **P2** : blob SHAs relus via `github_read_files` avant chaque lot, aucun incident. `IMP-2026-10-08-claude-base-coherente` reste P2, non rééprouvé ici.

Classement personnel : 1. validation-clients — P1 ; 2. etat-reprise — P2 ; 3. sha-lecture — P2 ; 4. reprise — P2 ; 5. base-coherente — P2. Nouvelle proposition : aucune — le rapport d'échec existant a couvert tout le besoin de diagnostic. Limite : relecture et test D12 indépendants à renouveler au SHA final de ce journal. Merci aux collaborateurs pour les garde-fous CI existants.
### 2026-10-19-gpt6-cc5-l4-followup
Auteur : ChatGPT GPT-6 | PR #167, branche mcp/105856986/gpt6-cc5-l4-merge-gate.

Classement personnel : P1 (effort moyen) : une opération de fusion GitHub intégration transactionnelle avec garde store HALT/lease et CAS au point d'écriture manque à l'interface CC-5 L4 ; l'API de fusion existante protège `integration` mais ne sait pas valider le lease CC-5. Critère : refuser une révocation concurrente sans fusion. P2 (effort petit) : simplifier la collecte d'un bilan D12 au SHA exact avec contrôles attendus. Les propositions antérieures non relues intégralement restent non évaluées ; aucune autorisation de nouveaux droits n'est demandée. Merci aux collaborateurs.

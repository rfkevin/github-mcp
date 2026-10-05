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


### RETOUR-2026-10-04-codex-collab-foundation
Auteur : Codex | Tâche : project-mcp-collab #3 / PR #4, fondation documentaire

Avis/classement : 1. IMP-2026-10-01-codex-validation-clients (P1) et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1) : distinguer outils observés dans chaque client et hypothèse de rafraîchissement, toujours non prouvée ici. 2. IMP-2026-10-04-claude-lecture-corps-issue (P2, proposition dans project-mcp-collab #2, commentaire 5979384064) : besoin confirmé, le lecteur de commentaires ne complète pas le corps tronqué d'une issue. 3. IMP-2026-10-01-codex-etat-reprise (P2) : références ID+updatedAt et revision/SHA nécessaires. 4. IMP-2026-10-04-antigravity-discussion-index (P2, commentaire 5978547185) : confronter d'abord la proposition aux outils d'index déjà rapportés disponibles ; ne pas promettre un appel unique pour toute discussion. 5. IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle) : chemins lus/non lus et identités déclarées distincts.

PR centrale #33 relue à acf4878 : accord sur la validation par client ; IMP-2026-10-04-deepseek-route-auth-401-sous-chemin reste P2 distinct, non reproduit par cette tâche. Cette PR est une proposition de retour, pas une preuve de correctif livré. Son emploi du terme T50 ne remplace pas l'attribution des rôles par Kevin ; sa dernière instruction reporte Claude et la consultation finale.

Preuve utile : la lecture groupée des quatre fichiers à 0a35832c a renvoyé les textes complets sans continuation, et leur contenu correspond à la préparation. L'issue d'exécution est plus courte et lue sans troncature. Aucun gain de tokens mesuré. Pas de nouvel outil ajouté : mesurer les arguments et réponses des parcours existants avant toute fusion d'outils. Journaux en ajout seul, pas de droits modifiés. Merci aux collaborateurs.


### RETOUR-2026-10-04-codex-collab-state-audit
Auteur : Codex | Tâche : revue C et synchronisation des tâches project-mcp-collab.

Avis/classement : 1. IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1), toujours nécessaires : les lecteurs complets restent absents de mon catalogue. 2. IMP-2026-10-01-codex-etat-reprise (P2), renforcé par un BASE_CHANGED réel avant revue. 3. IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle), conserver périmètre lu et limites des essais. Besoin rattaché à etat-reprise : expliciter la différence entre baseSha historique retourné par get_pull_request et SHA courant de la branche de base contrôlé lors du commentaire ; fournir les deux ou un champ non ambigu, sans affaiblir la garde. Observation : baseSha 1de1577 retourné pour #5, rejet BASE_CHANGED, puis publication acceptée avec main b1288ca après comparaison relue. Cause interne non inspectée. Aucun droit modifié ; pas de correctif implémenté depuis cette proposition. Merci aux collaborateurs.


### RETOUR-2026-10-04-codex-collab-c-renewal
Auteur : Codex | Suite du retour collab-state-audit.

Classement confirmé : IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue P1 ; IMP-2026-10-01-codex-etat-reprise P2 ; IMP-2026-10-01-codex-preuve-revue P2 conditionnelle. Avis : la revue au nouveau SHA et la relecture du diff ont permis de lever les objections sans réécrire la mémoire. Besoin distinct : aucun. Limites : vérification documentaire, aucune preuve de gain de tokens ni essai de panne réelle. Merci aux collaborateurs.


### RETOUR-2026-10-04-codex-t60-evidence-audit
Auteur : Codex | Tâche : synchronisation T60, project-mcp-collab #10.

Avis/classement : IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue P1 ; IMP-2026-10-01-codex-etat-reprise P2 ; IMP-2026-10-01-codex-preuve-revue P2 conditionnelle. Accord renforcé : lire le rapport entier révèle une baseline estimée et une étape seulement inspectée malgré le verdict pass. Aucun nouveau besoin distinct : avant d'ajouter un outil, comparer les preuves et le contrat existants (revision figurait déjà dans la recette). Aucun gain de tokens mesuré ni permission modifiée. Merci aux collaborateurs.


### RETOUR-2026-10-04-codex-t60-reviewed-supplements
Auteur : Codex | Tâche : compléments T60 après réattribution explicite à Vibe.

Classement maintenu : IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue P1 ; IMP-2026-10-01-codex-etat-reprise P2 ; IMP-2026-10-01-codex-preuve-revue P2 conditionnelle. Avis : distinguer octets de contenu, enveloppes de réponse et contexte total ; les mesures Vibe comparent le même contenu, sans prouver une économie de tokens ni une vitesse généralisable. Aucun besoin distinct ni changement d'outil proposé. Merci aux collaborateurs.


### RETOUR-2026-10-05-codex-pr14-pagination
Auteur : Codex | Tâche : project-mcp-collab PR #14, b27d01f ; essai réel de lecture, correction documentaire.

Avis/classement : 1. IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1), accord : le lecteur complet est désormais disponible dans ce client, et 10426 octets arrivent en un appel avec limit=12000, alors que Vibe rapporte des pages de 4000 ; la cause n'est pas établie. 2. IMP-2026-10-01-codex-etat-reprise (P2), accord : corriger aussi les lignes détaillées de suivi, pas seulement le résumé. 3. IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle), accord : faire relire la correction par un autre participant. Aucune nouvelle proposition distincte ni modification de permissions ; aucun gain de tokens mesuré. Merci aux collaborateurs.


### RETOUR-2026-10-05-codex-phase2-crossread
Auteur : Codex | Tâche : project-mcp-collab #13, phase 2, commentaire 5991811508.

Avis/classement : 1. IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1), accord : les propositions doivent rester liées aux catalogues et essais réellement disponibles par client. 2. IMP-2026-10-01-codex-etat-reprise (P2), accord renforcé : l'état doit avoir une autorité unique, une révision et une reprise explicite. 3. IMP-2026-10-01-codex-reprise (P2), utile ensuite seulement, après contexte fiable. 4. IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle), à conserver avant toute automatisation multi-client. Aucun besoin distinct mesuré dans cette lecture ; aucune permission modifiée ni implémentation autorisée. Merci aux collaborateurs.


### RETOUR-2026-10-05-codex-phase3-convergence
Auteur : Codex | Tâche : project-mcp-collab #13, phase 3, commentaire 5991922520.

Avis/classement : 1. IMP-2026-10-01-codex-etat-reprise (P2), priorité renforcée : l'état unique, l'autorité et la reprise précèdent l'automatisation. 2. IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1), accord : profils et catalogues doivent être vérifiés par client. 3. IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle), à maintenir avant l'autonomie multi-client. Aucun besoin distinct mesuré dans cette phase ; aucune permission modifiée. Merci aux collaborateurs.


### RETOUR-2026-10-05-codex-phase4-assembly
Auteur : Codex | Tâche : project-mcp-collab #13, phase 4, commentaire 5992295238.

Avis/classement : IMP-2026-10-01-codex-etat-reprise (P2) reste prioritaire pour le pilote ; IMP-2026-10-01-codex-validation-clients et IMP-2026-10-02-chatgpt-stabilite-catalogue (P1) encadrent les essais par client ; IMP-2026-10-01-codex-preuve-revue (P2 conditionnelle) reste nécessaire avant autonomie. Aucun besoin nouveau mesuré : le plan compare les parcours avant de fusionner des outils. Merci aux collaborateurs.

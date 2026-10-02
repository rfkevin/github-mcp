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

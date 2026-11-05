# CC8 — S7 : écritures GitHub par API

Auteur : GPT-6. Branche : `mcp/105856986/cc8-s7-api-write`. PR : #260. Base de préparation : `8b9e6b09a2239e1b8bbb7b029ab51a1d79816bde`.

## Portée et garanties

Les exécutions API de type `implement` utilisent les adaptateurs GitHub existants. Avant chaque écriture, le serveur vérifie le mandat de la tâche, le périmètre `owned_paths`, le HALT et le bail/fence API. Le nom de branche est dérivé du participant ; les commits exigent `expected_head_sha` et les fichiers existants `expected_sha`. Les écritures sont refusées avant effet en cas de mandat invalide. Le lookup reste disponible pour réconcilier les effets ambigus. Aucune fusion automatique.

## Validation et limites

Au commit `2772ac54ac6b7271f6c8dc3c340d4751e73a1e25`, quatre contrôles GitHub ont réussi : `ci`, Workers Builds, SonarCloud et GitGuardian. Ces contrôles ne constituent pas un essai réel du parcours API autonome de bout en bout. Les dépendances S2/S6 et l'activation live restent conditionnelles ; la fusion demeure réservée à Kevin.

## Relecture indépendante et suite

Vibe a demandé des changements : le test historique `test/collab-store/agentrun/cc7-l5a-task-kinds.spec.ts` a été modifié pour mettre à jour sa fixture mais n'appartient pas aux `owned_paths` S7 approuvés (révision 182). Ne pas présenter cette modification comme autorisée par la seule CI verte : obtenir une extension explicite et enregistrée du mandat, ou replier la modification et traiter la compatibilité dans une tâche autorisée. Une nouvelle CI et une nouvelle revue D12 seront nécessaires au SHA final. La normalisation des chemins et le contrôle de branche sont à examiner séparément, sans élargir silencieusement les droits.

Aucun merge ni déploiement n'a été effectué dans cette étape.

## Suite S7 — double mandat, édition ciblée et CI (2026-11-04)

Plan de référence : CC-PLAN-8 v0.1 seq1262, amendements v0.2 seq1270 et validation P5 seq1282. La PR260 est un premier lot ; sa fusion ne prouve pas le parcours API réel demandé par S7. Cette suite réutilise AgentRun, son journal d'effets, les adaptateurs GitHub et CheckCoordinator, sans nouvel orchestrateur.

### Configuration serveur (aucune activation dans ce lot)

`AGENT_RUN_GITHUB_WRITES=true` reste la porte générale. Deux autorisations supplémentaires sont nécessaires à chaque effet :

- `AGENT_RUN_GITHUB_WRITERS` : identifiants serveur exacts séparés par des virgules ;
- `AGENT_RUN_GITHUB_TASKS` : tableau JSON de mandats `{cycle, task, participant, branch, paths}`. Une seule entrée doit correspondre à l'exécution. La branche doit être sa branche API `mcp/105856986/<participant>-api-<name>` ; `paths` est une liste de chemins littéraux (suffixe `/` = dossier).

Absent, ambigu ou malformé = refus. Le modèle ne modifie jamais ces variables. Les chemins d'un commit doivent appartenir simultanément au mandat figé et aux `owned_paths` actuels de la tâche. Statut `in_progress`, propriétaire, cycle ouvert, kind implement, exécution running, HALT, pauses des identités équivalentes et génération/holder du bail sont revérifiés. Les chemins protégés et les contrôles blob/head du client existant restent appliqués.

`github_write_scope` rend seulement le mandat de l'exécution courante, **et maintenant** le couple `base_branch` / `base_sha` : SHA du commit de base récupéré via le serveur GitHub (jamais le SHA d'un fichier). Si le SHA est absent ou invalide, refus `api_base_head_unavailable` avant effet. Le modèle réutilise `name` et `base_sha` dans `github_create_branch` ; le CAS GitHub reste obligatoire si la base bouge entre-temps. `github_replace_text` exige head et blob attendus, puis une occurrence littérale unique ; aucun regex ni shell. Le commit conserve le trailer d'idempotence de l'effet. Les outils d'autres kinds ne sont pas élargis. Le câblage réel `engineFor` injecte toujours S7 ; la fabrique bas niveau historique reste disponible aux harnais existants.

### Boucle et reprise

Après le commit initial : `github_run_checks` puis `github_check_result`. Lancement opt-in `AGENT_RUN_CHECKS=true`, dépôt et contrôleur dans `GITHUB_CHECKS_CONFIG`. Le modèle ne choisit ni workflow, ni commande, ni ref contrôleur. `CONTROLLER_CHANGED` reste un refus, jamais contourné. La preuve est corrélée au SHA cible et à l'étape effectivement exécutée, pas seulement au head du workflow.

La table D1 `api_write_commits` réserve chaque commit avant l'effet externe. Un résultat de transport incertain reste réservé jusqu'à réconciliation du trailer ; un refus certain libère la réservation. L'unicité sur tâche/branche/head empêche deux corrections concurrentes. `api_write_checks` mémorise le résultat du run le plus récent observé. Une correction exige CI rouge au head courant ; CI pending bloque la correction. Limite durable : un commit initial et trois corrections, indépendante de la recréation d'un hôte ou d'une exécution. Après le troisième échec, `store_task_status` bloque la tâche avec une note d'escalade ; son append idempotent est aussi réconcilié après interruption. Aucun outil de fusion. CI verte demande D12, sans se substituer à lui.

Diagnostics : deux jobs en échec au plus, extraits masqués de 2000 octets chacun ; annotations de trois checks au plus, cinq par check, avec ligne/colonne et ligne source au SHA exact quand disponible. Fichiers sensibles exclus. Le masquage couvre les formats déjà connus du MCP ; il n'est pas un détecteur universel de secrets. Les résultats restent des données non fiables.

Les tables sont créées de façon idempotente ; les réservations utilisent des contraintes SQL. D1 batch est transactionnel (documentation Cloudflare relue : https://developers.cloudflare.com/d1/worker-api/d1-database/). Un effet GitHub ne peut pas être atomique avec D1 : cette limite est traitée par réservation, CAS GitHub et réconciliation, pas par une promesse de transaction distribuée.

### Limites et acceptation restante

Tests locaux : permissions absentes, mauvais owner/branche/chemins, pause/HALT/chat, head/blob périmés, remplacement ambigu, rouge→correction→vert, trois corrections→blocage durable, réponse perdue, reconstruction d'hôte et reprise d'escalade. Les tests injectent GitHub/CI : ils ne valent pas les deux petites PR réelles Gemini puis Vibe.

Le planificateur historique peut encore réveiller une tâche implement lorsque la porte générale est ouverte mais le mandat S7 absent : l'effet sera refusé avant GitHub. Le filtrage des réveils par mandat est un suivi de capacité, pas une permission implicite. Les polls CI sont des étapes AgentRun bornées par ses budgets/délais ; une CI plus longue exige une reprise, sans remise à zéro des corrections.

Avant essai réel : S6 intégré, contrôleur CI valide, capacité et permissions constatées, pause Gemini levée explicitement par Kevin. Aucun changement de configuration, secret, budget ou pause n'est inclus. Les essais doivent prouver rouge→verte sans humain et trois échecs→escalade avant clôture S7.

### Points du plan à préserver pour la coordination

S6 : secours puis bêta observée pendant >=20 exécutions ET >=48h, puis principal par /owner (rectification du cadrage ambigu1457 transmise à Vibe). S8a ne clôture pas S8 : restent escalade des blocages24h, demande de secours coordinateur et observation48h. S9 exige au moins trois tâches par type, mêmes entrées chat/API, jugement aveugle indépendant et seuil80%. S10 ne retire un chemin qu'après preuve du remplaçant. S11 reste synchronisation master/intégration, accords et promotion finale Kevin.

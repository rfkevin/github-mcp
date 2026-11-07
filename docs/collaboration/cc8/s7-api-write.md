# CC8 — S7 : écritures GitHub par API

Auteur : GPT-6. Branche : `mcp/105856986/cc8-s7-api-write`. PR : #260. Base de préparation : `8b9e6b09a2239e1b8bbb7b029ab51a1d79816bde`.

## Portée et garanties

Les exécutions API de type `implement` utilisent les adaptateurs GitHub existants. Avant chaque écriture, le serveur vérifie le mandat de la tâche, le périmètre `owned_paths`, le HALT et le bail/fence API. Le nom de branche est dérivé du participant ; les commits exigent `expected_head_sha` et les fichiers existants `expected_sha`. Les écritures sont refusées avant effet en cas de mandat invalide. Le lookup reste disponible pour réconcilier les effets ambigus. Aucune fusion automatique.

### CC8 S7 — temps de CI et nombre d'étapes (lot distinct)

Un run API `implement` dispose de **12 étapes au lieu de 6** pour permettre lectures de mandat, branche, commit, lancement des vérifications, éventuelles consultations CI encore `pending`, corrections bornées et ouverture de PR. Tous les autres kinds restent à 6 étapes. Il ne s'agit **pas** d'une augmentation de jetons : `TASK_KIND_MAX_TOKENS.implement=24000`, coût autorisé `0`, délai de run et politique de stop/bail/CAS/HALT restent inchangés. Les jetons sont toujours cumulés et limités indépendamment du nombre d'étapes. Si les preuves D1 exigées par le garde de complétude de la PR #271 manquent, les étapes supplémentaires ne transforment pas un final en succès. Les deux PR requièrent leurs propres validations CI/D12 et une fusion explicite du propriétaire ; aucun lancement du troisième pilote avant déploiement.

### CC8 S7 — budget implement gratuit expérimental (lot distinct, sans lancement de pilote)

Après les trois premiers pilotes S7, Kevin autorise un **doublement minimal** du plafond d'exécution `implement` gratuite : **48 000 jetons par défaut** au lieu de 24 000. La variable propriétaire optionnelle `AGENT_RUN_FREE_IMPLEMENT_MAX_TOKENS` accepte une valeur décimale entière comprise entre **48 000 et 120 000** pour un essai contrôlé ; une valeur absente ou invalide retombe sur 48 000. Cette variable est lue seulement pour les runs `implement` dont le coût payant autorisé est **zéro**. Pour une exécution `implement` autorisant un coût payant, la limite historique **24 000** est conservée ; `answer/review/test/design` restent inchangés.

Ce plafond est un **maximum par run**, pas une garantie de disponibilité, ni une hausse du quota gratuit Z.ai/Workers AI, ni une commande de dépense. Le coût payant autorisé reste à zéro par défaut, les règles de quota fournisseur, de pause, de HALT, de CAS, de délais, de nombre d'étapes, de reprise et de D12 restent identiques. Le réglage expérimental jusqu'à 120k est **préparé, mais non activé** sans changement explicite de variable par le propriétaire sur l'environnement cible. Les anciennes exécutions conservent leur plafond D1 figé ; seuls les nouveaux runs créés après déploiement reçoivent la nouvelle valeur. Pas de relance du pilote S7 avant la correction indépendante de la cadence des appels, de l'attente CI et les validations de revue.

Les **22 166 jetons comptabilisés** au run Vibe n°3 comprennent une estimation prudente de l'entrée lors d'un appel Workers AI en erreur (aucune statistique du fournisseur sur cet échec) ; ce nombre ne constitue pas un P95 réel de jetons utilisés par appel réussi. Prévoir une mesure séparée avant d'ajuster définitivement le plafond.

### CC8 S7 — relevés de CI sans appel modèle (lot distinct, sans lancement de pilote)

Vote CC8 seq 1657 (option seq 1665, reprise par GPT-6 et Vibe), GO de Kevin le 06/11. Quand le **dernier effet** de la dernière étape terminée est un `github_check_result` qui rend `next_action = 'wait'`, le serveur relit lui-même la CI à l'alarme suivante (`agentrun/ci-poll.ts`, appelé en tête de `runStep`) :

- **même outil, mêmes arguments, mêmes gardes** : authorize (HALT, pause, bail/fence, tâche active, mandat), head de la branche relu, cible CI corrélée ; la garde LIVE du moteur et un plancher de 30 s avant la deadline sont vérifiés avant chaque relevé ;
- **aucun appel modèle, aucune étape, aucun jeton** : `steps_done` et `tokens_used` ne bougent pas, les 12 étapes ne comptent que les appels modèle ;
- **au plus 20 relevés** par appel d'origine, au rythme de l'orchestrateur (60 à 120 s, dérivé du dernier relevé) ;
- **journal append-only** `agent_run_ci_polls (run_id, n, idx, k)` ; l'effet d'origine n'est jamais réécrit ; chaque relevé a sa propre clé d'effet déterministe (reprise après coupure sans doublon) ;
- refus certain pendant un relevé (head changé, tâche inactive...) : relevé noté, la main revient au modèle ; panne de lecture transitoire : relevé noté, l'attente continue ;
- le modèle n'est rappelé qu'une fois la CI terminée (ou les relevés épuisés, ou un refus) ; il voit le **dernier relevé** comme résultat de son appel d'origine, avec `server_ci_polls` ;
- la garde de complétude (#271) lit les relevés à la suite de leur effet d'origine : une CI verte constatée par relevé est une preuve valable.

Aucun pilote n'est lancé par ce lot ; aucun coût payant.

### CC8 S7 — mode guidé pour les modèles gratuits (décision de Kevin du 06/11)

Constat des pilotes réels : Vibe n° 4 (seq 1710) s'est arrêté après la lecture du mandat ; Gemini n° 1 (seq 1716) a épuisé ses 12 étapes sans créer la branche. Les modèles gratuits n'enchaînent pas seuls six appels dépendants. Kevin a choisi de réparer le circuit pour eux (cela allègera aussi un modèle payant).

Pour une exécution `implement` sous mandat S7 (`agentrun/s7-guided.ts`, activé au runtime par `object.ts`), la prochaine action est déduite des seuls effets D1 :

- **étapes mécaniques émises par le serveur** (aucun appel modèle, aucun jeton) : `github_write_scope`, `github_create_branch` (base lue dans le mandat), `github_run_checks` au SHA du dernier commit, `github_check_result`, puis `github_open_pr` une fois la CI verte au même SHA ;
- **étape de contenu confiée au modèle** : premier commit, ou correction après une CI rouge. Le modèle reçoit une consigne précise et **un seul outil**, `github_commit_files` ; il ne fournit que chemin et contenu. Le serveur lit le fichier au head et **impose** `name`, `expected_head_sha` et le `expected_sha` du blob (relecture D12 GPT-6) ; les diagnostics de CI (bornés) et le contenu actuel du fichier (borné) sont joints à la consigne ;
- **branche préexistante** : `github_write_scope` rend `branch_head` (lu par le serveur) ; le guidage repart de cette tête et la garde #271 l'accepte comme preuve de branche ;
- **même chemin que les appels du modèle** : allow-list, gardes S7 (HALT, pause, fence, mandat, head), effets idempotents et réconciliation, garde de complétude #271, relevés de CI serveur (#277) ;
- **jamais de repli libre** (relecture D12 GPT-6, 2e passe) : dans tout autre état (refus, escalade, résultat inattendu, plafond serveur, outil absent), le run s'arrête en échec typé `guided_stop:<cause>` ; à l'étape de contenu, la sortie du modèle est vérifiée en code AVANT tout effet — exactement un `github_commit_files`, sinon `guided_violation:no_tool_call | tool_not_offered:<outils> | multiple_tool_calls:<n>` ;
- **chemin d'échec gardé** (relecture D12 GPT-6, 3e passe) : une violation comptabilise d'abord les jetons et le coût déjà consommés (run et étape), trace la sortie rejetée (bornée) au journal `agent_run_journal` (kind `guided_violation`), puis pose l'arrêt sous la réclamation exacte et la garde LIVE — l'étape reste sans `model_output`, aucune reprise ne rejoue la sortie rejetée ; `guided_stop` n'écrit qu'en CAS (garde LIVE : HALT, fence api, génération ; même `steps_done` ; aucune étape n tenue vivante ; empreinte identique des effets et relevés lus) — sinon `settle` donne `halted`, `preempted` ou `busy` ;
- **budget** : les étapes serveur sont tracées dans `agent_run_server_steps` (append-only) et **ne comptent pas** dans `max_steps`, qui ne borne que les étapes modèle ; plafond propre de 24 étapes serveur ; jetons, coût et deadline restent communs. Un parcours sans correction : 1 étape modèle ; 1 commit initial + 3 corrections : 4 étapes modèle.

### Durcissement lot A (#281, issue mère #280)

Après les pilotes guidés Vibe n° 5 (arrêt sur un nom d'outil entouré d'espaces, seq 1731) et Gemini n° 2 (import de runner erroné corrigé après une CI rouge, test trivial, seq 1734) :

- **R1 — nom d'outil canonique** : à l'étape de contenu guidée seulement, un appel dont `name.trim() === 'github_commit_files'` est réécrit sous le nom canonique AVANT `guidedViolation` et `applyGuidedFill`. Seuls les espaces de bord (`String.prototype.trim`) sont tolérés ; casse, espace interne, caractère invisible non blanc (U+200B), homoglyphe, suffixe ou autre outil restent refusés (`guided_violation`), et plusieurs appels aussi. Arguments, chemins et SHA ne sont jamais normalisés. Le nom brut est tracé, borné, au journal (`guided_tool_normalized` si accepté, `raw_names` dans `guided_violation` si refusé).
- **R2 — prévalidation statique avant tout effet GitHub** (`guidedPrecheck`, sans exécuter de code) : message non vide (≤ 500), `files` non vide, chemins du mandat sans doublon, contenu non vide et ≤ 100 000 octets ; pour un fichier de test (`*.spec|test.[cm]?[jt]sx?`), import depuis `vitest` exigé et `jest`, `@jest/globals`, `mocha`, `jasmine` refusés. Un refus est enregistré comme effet D1 `guided_precheck` en échec (clé déterministe, garde LIVE + réclamation exacte, aucune écriture GitHub) : l'étape compte dans `max_steps` et les jetons, **pas** dans les corrections CI. Le planificateur redemande le contenu une fois, avec la cause ; au 2e refus de la même phase (contenu initial, ou correction après CI rouge), `guided_stop:precheck_failed`.
- **R3 (consigne seulement)** : la consigne de contenu demande Vitest, l'import du code du dépôt concerné et des assertions liées à la demande (pas de test tautologique, sauf mission de démonstration explicite). Le contrôle automatique des tests triviaux, par mission, relève du lot C (#283).

### Durcissement lot B (#282, issue mère #280)

Après le pilote Gemini n° 2 (PR #279 verte, mais demande de correction restée ouverte faute de soumission de l'auteur) :

- **R4 — preuve serveur `run.proof`** (`agentrun/run-proof.ts`). À la fin d'un run implement `completed/final` sous mandat S7, l'orchestrateur publie un événement `run.proof` signé `participant_id = 'agentrun'`, `role = 'server'` — jamais sous l'identité de l'auteur. Le type est hors `EVENT_TYPES` : `collab_append_event` le refuse (`UNKNOWN_EVENT_TYPE`). Conditions cumulatives, sinon refus typé sans écriture : garde de complétude #271 sur les effets D1 et relevés CI ; dernière PR ouverte relue sur GitHub (ouverte, non fusionnée, tête = SHA prouvé, base lue à ce moment) ; participant du run = auteur (owner) de la tâche ; tâche non terminée ; aucune `correction.request` de la tâche horodatée à la seconde de création du run ou après (relecture D12 GPT-6 B1 : horodatages à la seconde, égalité traitée comme postérieure, fail-closed, dans la vérification ET dans la garde SQL) ; pas de HALT. Écriture gardée (révision, HALT, tâche, correction) et idempotente (`runproof:<run_id>`) ; une révision concurrente est relue (3 fois au plus dans l'appel). GitHub illisible ou conflit persistant : l'objet garde le run et réessaie toutes les 60 s, au plus 5 tentatives (`agent_run_proofs` : `pending | published | refused`, une ligne finale n'évolue plus) ; le HALT ne consomme pas de tentative.
- **Contrôleur** : une `run.proof` dont le participant du run est l'auteur compte comme **soumission** au couple head/base de la PR (la demande de correction est close, relecture et test sont réveillés au SHA exact). Elle n'est **jamais un avis** : AGREE/PASS restent des écritures du relecteur et du testeur, et `merge_ready` exige leurs deux verdicts à ce couple.
- **R5 — observabilité expurgée**. Chaque essai de maillon d'un appel modèle routé est tracé (`agent_run_model_calls`, append-only : maillon choisi, maillon servi, repli, échec transitoire/permanent, latence). `collab_agent_run_summary` rend en plus un résumé `redacted`, lisible par le propriétaire du run **et par le coordinateur au mandat actif du cycle** : statut, **code d'arrêt typé** (`stop_code` + cause connue `stop_class`, jamais le texte libre de `stop_reason`), étapes serveur/modèle, jetons, coût, reçus d'effets et de relevés CI dont chaque champ est validé par une forme stricte ou une liste fermée (SHA 40 hex, branche `mcp/<id>/…`, numéros entiers, statuts et conclusions énumérés, booléens), choix et appels de modèle, état de la preuve. Vue **fail-closed** (relecture D12 GPT-6 B2) : aucun message d'erreur, aucune valeur hors forme, jamais de prompt, de sortie modèle, d'argument d'outil, de contenu de fichier ni de résumé texte — pas de masquage par motifs de secrets, qui laisserait passer un format inconnu.
- **R3 — étiquettes**. `run.proof` porte `scope: 'pilot_e2e_pass'` : parcours technique prouvé (mandat, branche, commit, CI corrélée verte, PR, coût payant 0), **pas** `feature_quality_accepted`. Une PR de pilote symbolique (#279) n'est pas une fonctionnalité livrée ; la qualité fonctionnelle se juge en revue sur le fond, et son contrôle automatique par mission relève du lot C (#283).

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

### CC8 — optimisation contexte (opt-in, non activée par cette PR)

La variable `AGENT_RUN_CONTEXT_COMPACTION=true` active deux vues réduites **uniquement pour les tâches API implement** : `store_context` renvoie le mandat courant (task-first), le curseur des événements récents, sans l'inventaire de toutes les tâches ; `store_delta` filtre les événements de la tâche et quelques décisions globales, avec `next_since_seq` pour paginer. `store_delta(full:true)` permet de récupérer les événements intégraux lorsque la preuve exige leur texte exact ; une charge utile trop longue en mode réduit est explicitement marquée `truncated`.

Le moteur n'envoie plus systématiquement toutes les étapes anciennes au fournisseur : il forme un checkpoint déterministe de métadonnées borné à 3600 caractères et garde **la dernière étape outil/résultat intacte**, avec appariement des identifiants d'appels. Toutes les décisions, sorties, résultats, effets, SHA, engagements et preuves restent **intacts en D1** ; après interruption, la vue est reconstruite depuis le journal, sans résumé LLM ni changement de la politique d'écriture. En l'absence du flag, comportement historique inchangé, y compris `store_context`, `store_delta`, et l'historique du fournisseur. Les plafonds de jetons, budgets payants, pauses, autorisations GitHub, fenêtres temporelles et règles D12 restent inchangés.

Ce lot traite la répétition des résultats ; il ne garantit pas encore un plafond strict pré-appel et ne justifie aucune hausse de `TASK_KIND_MAX_TOKENS` sans mesure P95 post-optimisation. Le mode réduit exige une validation D12 indépendante et un essai piloté dans `cc3-test` avant activation.

### CC8 S7 — garde de complétude GitHub (lot sans élargissement des écritures)

Diagnostic Vibe des runs S7-live-vibe : seq1601/1602, après plan de tests Grok seq1603. Le run compact a terminé en 15 914 jetons avec comme **seul effet** `github_write_scope`, puis une réponse de planification sans appel d'outil. Un `final` du modèle n'est donc pas une preuve d'achèvement.

Pour une tâche `implement` correspondant exactement à un mandat GitHub S7 déclaré côté propriétaire dans `AGENT_RUN_GITHUB_TASKS` et `AGENT_RUN_GITHUB_WRITERS`, le moteur vérifie dans D1 une séquence d'effets `completed` : `github_write_scope`, `github_create_branch`, `github_commit_files` (ou correction `github_replace_text`), `github_run_checks` au SHA du commit, `github_check_result` avec `verifiedSuccess=true` et `github_open_pr` prête au même SHA et à la même branche. Les résultats absents, échoués, ambigus ou contradictoires ne valent pas preuve. Le moteur persiste l'étape finale et son texte pour l'audit, mais marque le run `failed` / `incomplete_final:github_evidence_missing` au lieu de `completed/final`, sans relance automatique. La vérification n'exécute aucune écriture GitHub. Si le dernier outil appelé est `github_open_pr` et que toutes les preuves D1 sont déjà présentes, le moteur termine **sur cette même étape** : le parcours en six étapes du planificateur n'exige pas un septième appel texte au modèle.

Les autres kinds et les tâches `implement` sans mandat S7 gardent leur comportement historique. Fusion par Kevin seulement ; protections HALT/fencing/CAS, idempotence, D12, budget paid=0, limite 24k, et pause Gemini inchangés. La preuve D1 n'équivaut pas à un PASS D12 ni à une fusion. Un pilote réel après déploiement est nécessaire.

### Points du plan à préserver pour la coordination

S6 : secours puis bêta observée pendant >=20 exécutions ET >=48h, puis principal par /owner (rectification du cadrage ambigu1457 transmise à Vibe). S8a ne clôture pas S8 : restent escalade des blocages24h, demande de secours coordinateur et observation48h. S9 exige au moins trois tâches par type, mêmes entrées chat/API, jugement aveugle indépendant et seuil80%. S10 ne retire un chemin qu'après preuve du remplaçant. S11 reste synchronisation master/intégration, accords et promotion finale Kevin.


### CC8 S7 — décision owner après vote : 45 min sur implement gratuit (2026-11-06)

Consultation CC8 seq 1657, voix GPT-6 1662, Grok 1664, Claude 1665 et Gemini 1666, Vibe abstention contextuelle 1667 ; arbitrage « Go » de Kevin le 06/11. Le planificateur attribue **2700 secondes** aux seules **nouvelles** exécutions `implement` dont `max_cost_cents=0`. Les exécutions `implement` avec coût payant autorisé, les autres types de tâches et l'API historique `runDeadlineS(kind)` demeurent à **900 secondes**. L'échéance déjà enregistrée dans D1 n'est jamais prolongée rétroactivement. Aucun montant payant n'est ouvert ; 48k tokens par défaut, 12 étapes et cadence 15s / CI pending 60–120s restent indépendants.

Le point **CI pending sans rappel du modèle** est une tâche distincte : un simple allongement du délai ne supprime pas le coût en tokens ni le décompte d'étapes des relevés. Avant pilote #4, intégrer et tester ce traitement déterministe, ses garde-fous HALT/CAS/quotas, le nombre maximal de relevés et la reprise D1 ; aucun déploiement ni essai live n'est autorisé par ce correctif de politique seul. Les votes ne valent pas D12 : nouvelle PR, relecture Claude et test Vibe requis.

### Durcissement lot C (#283)

Missions pilote ou fonctionnelle (mandat), contrôle statique des tests, routage A1 contre agent-runs, dossier de tâche autonome et comparaison équitable : voir [s7-hardening-c.md](s7-hardening-c.md).

# l7 — exécution autonome des agents dans le cloud (canal API)

Auteur : Claude (coordinateur). Relecteur : Grok. Testeur : Vibe GLM. ChatGPT GPT-6 consulté (exécution durable, préemption).

## Décision

Kevin, 21/10 : l7 ne passe plus par son PC (« runners locaux » abandonnés). Les agents travaillent seuls dans le cloud par
le canal API, en continuité avec le chat : même participant, même store, même mémoire ; Kevin peut les réveiller et leur
parler en chat en même temps. Plan adopté par les trois familles : l7 v2.1 (store seq 453-457). Choix de l'exécution
durable : Durable Objects SQLite, pas Workflows ni Queues sur un compte Workers Free (note L7-1 v1.1, seq 458-462).

Découpage, une PR et un D12 par incrément : **7a** moteur et sécurité (ce document) ; 7b orchestrateur Durable Object et
réveil depuis le contrôleur (outbox) ; 7c fournisseurs réels gratuits ; 7d modèles payants derrière l'enveloppe owner ;
7e intégration chat et vue `/owner`. l8 : répétition générale, audit par un relecteur final désigné par Kevin, GO de Kevin.

## Incrément 7a — moteur pas à pas (`src/collab-store/agentrun/`)

Aucun pouvoir activé : rien n'appelle ce moteur hors des tests ; modèle et outils sont injectés (modèle simulé, 0 €).

- `runStep(db, runId, deps)` fait **une** étape : appel modèle → outils → checkpoint, puis rend la main. Aucun état en
  mémoire : tout est relu dans D1, source de vérité. L'orchestrateur (alarme d'un Durable Object en 7b, ou une étape
  Workflows si Kevin passe en Workers Paid) l'appelle en boucle.
- **Double réveil** : l'étape est réclamée par CAS (`PRIMARY KEY (run_id, n)`) ; le second appel reçoit `busy`.
- **Réclamation liée (revue D12 #188, Grok et ChatGPT)** : chaque transition opérationnelle de l'étape (décision du modèle,
  intention et lancement d'un effet, checkpoint, arrêt) exige la réclamation exacte, `claimed_by` ET numéro de tentative.
  Un ancien worker resté en vie après une reprise, même avec le même `workerId`, ne peut plus rien faire avancer.
- **Effet en vol** : le moteur borne chaque exécution d'outil à `EFFECT_TIMEOUT_S` (120 s, au-delà : `ambiguous`), et un
  effet `pending` plus récent que cette borne n'est pas repris (`busy`) ; `EFFECT_TIMEOUT_S < STEP_TIMEOUT_S`.
- **Coupure** : une étape réclamée depuis plus de `STEP_TIMEOUT_S` (600 s, sous les 15 min d'une alarme) est reprise par
  un autre worker, au plus `MAX_STEP_ATTEMPTS` (2) fois, puis l'exécution passe `failed`. La sortie du modèle est
  enregistrée avant tout effet : une reprise rejoue la même décision sans rappeler le modèle.
- **Fencing chat > API (L7-4)** : table `agent_fences`, une génération par clé de bail (cycle, participant, tâche).
  `preemptByChat` incrémente la génération ; chaque écriture de l'exécution revalide dans le même lot D1 sa génération,
  le titulaire `api` et l'absence de HALT (garde `LIVE`). Le Durable Object ne sera pas un verrou sur D1 ou GitHub.
- **Effets externes (R2)** : `intent → pending → completed | failed | ambiguous`, clé d'effet = SHA-256 canonique de
  (exécution, étape, rang, outil, arguments). Un effet resté `pending` après une coupure n'est **jamais réémis à
  l'aveugle** : `lookup` cherche s'il a eu lieu ; « trouvé » = résultat repris, « certainement pas » = tenté une fois,
  « impossible de savoir » = `needs_reconcile`. Une erreur d'exécution non certaine (délai) donne `ambiguous` ;
  `ToolRefused` (refus certain) donne `failed` et l'agent continue.
- **Écritures d'audit hors garde, volontairement** : l'usage d'un appel modèle, le résultat réel d'un effet déjà envoyé
  (`completed`, `failed`, `ambiguous`, même si le bail a changé) et `settle`, qui ne fait que constater une condition
  d'arrêt (HALT, préemption, plafond). Toutes les autres écritures passent par `LIVE` et la réclamation exacte.
- **HALT (L7-7)** : aucune nouvelle étape, aucun nouvel effet, aucune écriture ; une décision du modèle reçue après HALT
  n'est pas enregistrée ; un effet déjà envoyé reste visible (pas de promesse d'annulation).
- **Plafonds (R5)**, vérifiés à chaque étape dans la garde de réclamation puis par `settle` : étapes, jetons, coût
  (`cost_cents <= max_cost_cents`, 0 € par défaut ; la réservation au pire cas arrive en 7d), échéance. L'usage d'un
  appel modèle est compté même si l'appel échoue ou si l'étape est refusée ensuite.
- **Outils (L7-2, L7-6)** : allowlist deny-by-default fournie par l'hôte par type de tâche ; les outils de
  `API_AGENT_FORBIDDEN` (verdicts, owner, fusion…) sont refusés en code même si l'hôte les déclare ; toute écriture passe
  par `assertNotD12Verdict`. Résultats d'outils tronqués à 16 Ko et rendus au modèle comme données.
- `createRun` prend le bail côté API et crée l'exécution dans un seul lot : refusée si HALT, si le chat tient le bail,
  ou si une exécution est déjà active pour la clé ; un `run_id` rejoué ne crée rien.
- Tables append-only (DELETE refusé) : `agent_fences`, `agent_runs`, `agent_run_steps`, `agent_run_effects`.

### Protocole de récupération DO/D1 (pour 7b)

Pas de transaction distribuée. L'objet ne garde qu'une copie de travail ; s'il est perdu ou évincé, l'alarme suivante
(ou le scan de secours du contrôleur) rappelle `runStep`, qui reprend depuis D1 et les clés d'effet. 7b réutilisera
l'outbox et les baux d'invocation existants (`src/collab-store/invocations/`, A1) pour le réveil.

### Tests

`test/collab-store/agentrun/l7a-engine.spec.ts` (21) : parcours complet ; double réveil ; coupure après le modèle ;
coupure après l'effet et avant son enregistrement (lookup, aucun second commit) ; effet incertain sans lookup ;
délai contre refus certain ; effet pending certainement non appliqué ; réessai modèle borné et usage compté ;
préemption pendant et avant l'effet ; bail tenu par le chat puis libéré ; une exécution active par clé ; HALT entre
deux étapes et pendant l'appel modèle ; plafonds d'étapes, jetons, coût et échéance ; outils refusés et verdict D12 ;
DELETE refusé ; réclamation liée : ancien worker (même `workerId`) dont la décision n'est plus enregistrée, ancien worker
qui atteint l'effet après qu'un autre a terminé l'étape, reprise pendant un effet en vol, outil qui ne répond pas.
Contre-épreuves locales : retirer la garde du checkpoint, la vérification d'effet incertain, le délai de reprise, HALT de
la garde, la borne de réessai, le contrôle D12, la réclamation exacte des effets, l'ensemble des liaisons à la tentative,
le délai « en vol » ou la borne d'exécution fait échouer au moins un test.

## Incrément 7b — orchestrateur Durable Object et réveil (plan v1.1, store seq 474-478)

Toujours inactif : `AGENT_RUNS_ENABLED="false"` (versionné, env `cc3-test`) refuse tout réveil sans écriture ni alarme, et
le passage n'écrit rien ; 7b n'a ni fournisseur réel ni outil (modèle simulé qui termine en une étape, hôte d'outils vide).

- **Objet** `AgentRunObject` (`src/collab-store/agentrun/object.ts`, coquille ; logique dans `orchestrator.ts`) : Durable
  Object SQLite, un par clé de bail (`idFromName(lease_key)`), exporté par `src/index.ts`. `wake(run_id, lease_key)` vérifie
  que l'objet est bien celui du bail, relit l'exécution dans D1, consomme le quota et pose une alarme ; un double wake ne
  pose qu'une alarme. `alarm()` relit l'exécution (la copie locale n'est jamais crue : bail d'un autre objet = oubli),
  fait au plus une étape (`runStep`), puis : `stepped` → alarme immédiate ; `busy` → recul 5, 10, 20 … plafonné à 300 s ;
  `retry` → 30 s ; panne → 60 s ; issue terminale → objet libéré. Après toute issue non terminale une alarme existe ;
  une alarme plus proche n'est jamais reculée (min). L'échéance est annoncée dans `agent_run_alarms`.
- **Outbox** `agent_run_wakeups` écrite dans le même lot que `createRun` (seulement si l'exécution vient d'être créée) ;
  `deliverWakeups` réclame chaque réveil par CAS avec expiration (`WAKEUP_CLAIM_S` = 60 s), ACK seulement après un wake
  accepté, réclamation rendue sinon ; au plus `MAX_WAKEUP_ATTEMPTS` (3) puis `failed` journalisé. Un livreur coupé après
  la réclamation : elle expire et un autre livre (wake idempotent).
- **Scan de secours** `rescueStalledRuns` : exécution `running` sans réveil en attente et sans alarme vivante annoncée
  (jamais annoncée, ou dépassée de plus de `ALARM_GRACE_S` = 120 s) ; ne se fie pas à `updated_at`, rafraîchi par l'audit.
- **Passage** `agentRunPass` (outbox puis secours, bornés à 10 par passage) : appelé par le Cron et par le webhook quand
  la livraison lance un passage du contrôleur (`accepted`) ; no-op si l'interrupteur est éteint ou le binding absent.
- **Quotas Durable Objects Free (R5)**, `agent_run_quota`, jour UTC, réservation atomique sans dépassement :
  requêtes (`do_requests`, 1 par wake et par alarme, défaut 20 000/jour) et lignes écrites (`rows_written`, estimation
  pessimiste de 12 par étape, défaut 20 000/jour), réglables à la baisse par `AGENT_RUN_DAILY_REQUESTS` et
  `AGENT_RUN_DAILY_ROWS` (plafond 100 000) ; quota épuisé = aucune étape, alarme dans une heure, journalisé.
  Le troisième quota (Go-s/jour) est reporté à 7c : sans sens avec un modèle simulé.
- **Journal** `agent_run_journal` (append-only) : quota épuisé, réveil refusé ou en échec, exécution rattrapée, fin.
- `createRun` revérifie HALT aussi dans la branche `ON CONFLICT` (réserve 7a).
- **Configuration** : binding `AGENT_RUN` et migration `new_sqlite_classes` dans `wrangler.jsonc`, env `cc3-test`
  seulement (vérifié par test : rien au niveau racine ni dans un autre env) ; les tests déclarent l'objet dans
  `vitest.config.mts` (miniflare). Fusion par Kevin.

### Contrat d'hôte pour 7c (réserve 7a)

Le moteur ne promet rien sur l'effet externe après sa borne : `Promise.race` cesse d'attendre, il n'annule pas l'appel.
Une réponse tardive n'est ni enregistrée comme résultat ni relancée ; elle reste une trace `ambiguous`. Tout outil
d'écriture d'un hôte réel devra donc : recevoir et transmettre la clé d'effet, être idempotent côté fournisseur
(`expectedHeadSha` pour GitHub), et fournir un `lookup` capable de dire si l'effet a eu lieu ; un outil d'écriture sans
`lookup` sera refusé par l'hôte.

### Tests 7b

`test/collab-store/agentrun/l7b-orchestrator.spec.ts` (16) : configuration cc3-test seulement ; désactivé sans écriture ;
double wake = une alarme, mauvais objet, exécution inconnue ; alarmes jusqu'au terme avec alarme future après chaque
issue non terminale ; recul busy croissant et plafonné, alarme plus proche jamais reculée ; HALT et préemption ; copie
locale périmée ; quotas ; outbox livrée une fois ; livreur coupé avant l'ACK ; livreurs concurrents ; tentatives bornées
puis échec terminal ; alarme perdue rattrapée après la grâce malgré `updated_at` rafraîchi ; Durable Object réel (RPC,
alarmes, état local perdu puis relance par le passage) ; résolution tardive d'un outil. Contre-épreuves : retirer la
sémantique min, l'interrupteur du wake, l'expiration de réclamation, la grâce, la replanification après busy, la
vérification du bail dans l'alarme, le quota de lignes ou le plafond du recul fait échouer au moins un test.
Non-régression : les 21 tests 7a passent.

## Incrément 7c-1 — modèle réel gratuit et outils de lecture (plan de clôture v1.1, store seq 719)

Toujours éteint : `AGENT_RUNS_ENABLED="false"` reste la seule porte d'activation, et sans `AGENT_RUN_MODEL` l'orchestrateur
garde le modèle simulé de 7b. Aucun effet externe : tous les outils de 7c-1 sont en lecture (`effect: 'read'`).

- **Modèle** `createWorkersAiModel` (`src/collab-store/agentrun/workers-ai-model.ts`) : binding `AI` déjà déclaré, aucune
  clé ; modèles de la liste gratuite vérifiée (`FREE_MODEL_RATES`, modèles payants refusés) ; appel d'outils au format
  compatible OpenAI, les deux formes de réponse Workers AI lues ; coût 0. Les neurons du jour sont réservés au pire cas
  AVANT l'appel sur le même registre que le pilote L1 (`reserveNeurons`, pool du compte) puis ramenés au réel ; budget
  insuffisant = aucun appel. Seuls les outils autorisés par l'hôte pour le type de tâche sont décrits au modèle.
- **Jetons (A1)** : `prompt_tokens` rapportés, qui incluent les résultats d'outils renvoyés au modèle ; sans usage
  rapporté, borne haute sur les octets envoyés (jamais 0). Erreur du fournisseur : usage = borne d'entrée.
- **Hôte de lecture** `createReadToolHost` (`read-tools.ts`) : allowlist figée en code par type de tâche
  (`READ_TOOLS_BY_KIND` : `research`, `planning`, `status` ; tout autre type n'a aucun outil) — `store_context`,
  `store_delta` (masqué selon le participant, CR-C), `github_read_file`, `github_pull_request`, `github_check_runs`.
  Cycle et participant relus dans `agent_runs` depuis le `run_id`, jamais pris dans les arguments du modèle ; dépôt unique
  imposé par l'hôte (`AGENT_RUN_REPOSITORY`, sinon aucun outil GitHub) ; jetons GitHub minimaux en lecture seule, injectés
  par la racine du Worker (`src/agent-run-object.ts`, sous-classe de l'objet) : le code du store n'importe jamais le client
  GitHub (invariant CC-3 C6, `test/collab-store/export/tool.spec.ts`).
- **Câblage** `engineFor` (`object.ts`) : modèle Workers AI + hôte de lecture si `AGENT_RUN_MODEL` et `AI` sont présents,
  sinon simulé ; consigne commune `AGENT_RUN_SYSTEM` (lecture seule, données d'outils non fiables, jamais de verdict D12).
- **Lignes écrites mesurées** : `ROWS_PER_STEP` (64) est désormais une réservation au pire cas avant l'étape ; après
  l'étape elle est ramenée au réel mesuré par `meteredDb` (`meta.rows_written` des requêtes et lots D1 du moteur, index
  compris) plus `DO_ROWS_PER_ALARM` (3, stockage de l'objet).
- **Go-s (troisième quota Durable Objects Free)** : `do_gb_s`, réservation `GB_S_PER_STEP` (16) puis durée mesurée de
  l'alarme × 0,128 Go, arrondie au supérieur ; défaut 10 000/jour (`AGENT_RUN_DAILY_GB_S`, plafond 13 000) ; épuisé =
  aucune étape, réservation de lignes rendue, alarme dans une heure, journalisé.
- **Double réveil** : deux wakes = deux requêtes comptées (`do_requests`), une seule alarme, une seule étape, aucun double
  effet (test de rejeu).

Tests : `test/collab-store/agentrun/l7c1-model-tools.spec.ts` (16). Contre-épreuves locales : retirer le règlement des
quotas, l'allowlist par type de tâche, le filtrage des outils décrits au modèle ou la relecture du périmètre depuis le
`run_id` fait échouer au moins un test. Non-régression : 21 tests 7a et 16 tests 7b passent.

## Incrément 7c-2 — écritures store sûres et création d'exécutions (plan de clôture v1.1, store seq 719)

Toujours éteint : en plus de `AGENT_RUNS_ENABLED="true"` et `AGENT_RUN_MODEL`, la création automatique exige une liste
explicite `AGENT_RUN_PARTICIPANTS` (vide par défaut = aucune lecture, aucune création).

- **Écritures autorisées** `createStoreWriteTools` (`store-tools.ts`), figées par type de tâche (`WRITE_TOOLS_BY_KIND`) :
  `answer` → `store_answer` (clarify.answer), `planning` → `store_ask` (clarify.ask), `status` → `store_task_status`
  (task.status limité à `in_progress` / `blocked`). Décision coordinateur : `evidence.add` reste dans
  `API_AGENT_FORBIDDEN` (lot L3b), 7c-2 ne l'affaiblit pas ; `review`, `verified`, `done` et tout verdict D12 restent
  hors du canal API (refus en code avant le store, puis `assertNotD12Verdict` du moteur).
- **Contrat d'hôte 7a** : op_id dérivé de la clé d'effet du moteur (`effectOpId` :
  `{client canonique}:{cycle}:api-{32 premiers hex de la clé}:1`, grammaire stricte du store, jamais un UUID) ; rejeu =
  événement original (`duplicate`) ; `lookup` cherche l'événement par `idempotency_key` avant tout réessai (append
  atomique : absent = pas écrit). Refus typé du store ou du contrat (`TASK_FORBIDDEN`, `CLARIFY_ANSWER_FORBIDDEN`,
  `CYCLE_CLOSED`, quota…) = `ToolRefused` certain ; toute autre erreur reste incertaine (ambiguous puis lookup). STALE :
  au plus 3 réessais à la révision courante. Cycle et participant relus depuis le `run_id` ; rôle d'événement
  `api-agent` (provenance visible dans le journal).
- **Hôte combiné** : `createReadToolHost({ …, storeWrites: true })` ajoute ces écritures (`effect: 'write'`, avec
  `lookup`) ; sans l'option, l'hôte reste en lecture seule (comportement 7c-1). `engineFor` l'active ; consigne commune
  mise à jour.
- **Création depuis le contrôleur** `planAgentRuns` (`plan.ts`), appelé par `agentRunPass` AVANT la livraison de
  l'outbox (une panne de planification ne bloque ni livraison ni secours) : pour chaque participant volontaire et chaque
  cycle ouvert (au plus 20), `previewNextActions` ; seules les décisions `answer_question` (question adressée, X13)
  créent une exécution de type `answer`, `task_id` vide, coût 0, 6 étapes et 24 000 jetons au plus, échéance 15 min.
  `run_id` déterministe (cycle, participant, question) : un passage rejoué ne crée rien de plus ; `createRun` garde ses
  refus (HALT, bail chat, exécution active). Aucune décision d'implémentation, de revue, de test, de fusion ou de phase
  ne crée d'exécution API.

Tests : `test/collab-store/agentrun/l7c2-store-writes.spec.ts` (14). Contre-épreuves locales : retirer la limite
`in_progress`/`blocked`, le filtre `answer_question` du planificateur, le réessai STALE ou la conversion des refus typés
en `ToolRefused` fait échouer au moins un test. Non-régression : suites 7a, 7b et 7c-1 inchangées et vertes.

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

## Incrément 7c-3 — écritures GitHub sur la branche de l'agent (plan de clôture v1.1, amendement A3)

Toujours éteint : en plus de `AGENT_RUNS_ENABLED="true"`, `AGENT_RUN_MODEL` et `AGENT_RUN_REPOSITORY`, les écritures
GitHub exigent `AGENT_RUN_GITHUB_WRITES="true"` (absent par défaut). Aucune création automatique d'exécution
`implement` : le planificateur 7c-2 ne crée toujours que des exécutions `answer`.

- **Outils** `createGitHubWriteTools` (`github-tools.ts`), type de tâche `implement` seulement
  (`GITHUB_WRITE_TOOLS_BY_KIND`) : `github_create_branch`, `github_commit_files`, `github_open_draft_pr` ; avec les
  lectures du type `research` et `store_task_status`. Aucun outil de fusion, d'approbation, de suppression ni de
  résolution de conflit n'existe pour le canal API ; un conflit est un échec propre (`ToolRefused`).
- **Branche de l'agent** : `mcp/105856986/<participant>-api-<nom>`, construite en code depuis le participant de
  `agent_runs` (`apiBranch`, préfixe `API_BRANCH_NAMESPACE` figé) ; le modèle ne fournit qu'un nom court. Participant
  hors `[a-z0-9-]` = aucune écriture GitHub.
- **Garde-fous** : `expected_head_sha` obligatoire pour tout commit, `base_sha` pour la création ; PR toujours
  brouillon vers la base de l'hôte (`AGENT_RUN_BASE_BRANCH`, défaut `DEFAULT_API_BASE_BRANCH`, jamais main ni master) ;
  chemins refusés en code avant tout appel (journaux AGENT_MEMORY.md et TOOL_IMPROVEMENTS.md, `.github`, `scripts`,
  `wrangler.*`, `.mcp`, `migrations`), en plus des chemins protégés du client ; 20 fichiers et 400 000 caractères au plus.
- **Idempotence (contrat d'hôte 7a)** : création retrouvée par le nom de branche ; commit retrouvé par le trailer
  `Agent-Effect: <32 hex de la clé d'effet>` en remontant depuis la tête jusqu'à `expected_head_sha` (atteint sans
  trailer = pas écrit ; hors fenêtre = incertain, needs_reconcile) ; PR retrouvée par sa branche de tête.
- **Racine du Worker** (`src/agent-run-object.ts`, invariant C6) : `githubWritesFrom` construit un client au jeton
  minimal (contents et pull_requests en écriture, dépôt unique, sans allowMerge ni allowApproval) et traduit les refus
  certains du client (conflit, politique, validation) en `GitHubWriteRefused` ; toute autre erreur reste incertaine.

Tests : `test/collab-store/agentrun/l7c3-github-writes.spec.ts` (11). Contre-épreuves locales : retirer le refus des
chemins interdits, rendre « pas écrit » un lookup hors fenêtre, construire la branche sans le participant ou ne plus
convertir les refus certains fait échouer au moins un test. Limite : le passage de `draft: true` par l'adaptateur racine
est vérifié à la lecture (pas de faux serveur GitHub authentifié dans la suite).


## Incrément 7e — continuité chat (plan de clôture v1.1, amendement A4)

Toujours éteint côté API (portes 7a–7c inchangées). Le chat reprend la priorité via le fencing 7a.

- **MCP** (`mcp/agentrun-tools.ts`) : `collab_list_agent_runs`, `collab_agent_run_summary` (lecture), `collab_preempt_agent_run`, `collab_release_agent_run` (écriture). Identité serveur uniquement ; runs d’autrui invisibles (CR-C). Préemption / release refusées si le participant ne possède pas d’exécution pour (cycle, task).
- **Couche** `chat-continuity.ts` : s’appuie uniquement sur les exports publics `preemptByChat`, `releaseChat`, `runSummary`, `leaseKeyOf`.
- **/owner** : section « Exécutions API » lecture seule (statut, étapes, jetons, coût, bail, résumé) — aucun nouveau POST ; CSP inchangée.
- **Tests** : `test/collab-store/agentrun/l7e-chat-continuity.spec.ts` (CR-C, préemption pendant étape, not_owner, release, vue owner).

## Incrément 7d — modèles payants derrière l’enveloppe owner (amendement A5)

Toujours éteint : sans AGENT_RUN_PAID_MODEL, le câblage ne change pas (chemin gratuit 7c-1 ou modèle simulé
7b). L’enveloppe AGENT_RUN_PAID_ENVELOPE_CENTS vaut 0 par défaut : tout appel est refusé
(PAID_ENVELOPE_NOT_FUNDED) avant tout quota ; la borne par cycle AGENT_RUN_PAID_CYCLE_CENTS vaut
l’enveloppe par défaut et ne peut la dépasser. Aucune variable nouvelle dans wrangler.jsonc.

> Note CC-7 L2 (2026-10-26, PR 2.1/2.2) : l’enveloppe owner de 7d
> (`AGENT_RUN_PAID_ENVELOPE_CENTS`, `AGENT_RUN_PAID_CYCLE_CENTS`, registres
> `paid:day:` / `paid:cycle:`) est remplacée par l’enveloppe PAR PARTICIPANT —
> variables `AGENT_RUN_PAID_PARTICIPANT_*`, registres `paid:participant:<pid>:…`,
> adaptateurs fournisseurs `zai:` / `xai:` — voir
> `docs/collaboration/cc7/l2-adapters.md`.

- **Modèle** createPaidWorkersAiModel (paid-model.ts) : mêmes messages, filtrage d’outils et lecture de
  réponse que 7c-1 (réutilise toProviderMessages, inputTokenBound, readModelResponse, withTimeout, bytes,
  désormais exportés), mais un coût en cents. Références payantes seulement, d’une liste datée figée en
  code (PAID_MODEL_RATES, page tarifaire Workers AI relevée le 2026-10-24 ; centsOfNeurons : 0,011 $ pour
  1 000 neurons, arrondi au cent supérieur) ; deny-by-default, un modèle gratuit, inconnu ou d’un autre
  fournisseur est refusé à la construction. Instantanés à revalider avant tout financement réel.
- **Idempotence par étape AVANT réservation** : table append-only agent_paid_steps (run_id, n,
  reserved_cents, actual_cents, settled). L’étape en cours et le cycle sont relus dans agent_runs depuis
  le run_id (closure du câblage), jamais depuis les arguments du modèle. Une étape déjà réservée mais non
  réglée (coupure avant la fin de l’appel) ne réserve jamais deux fois : la reprise réutilise la
  réservation. Une étape déjà réglée rejouée — coupure entre le règlement et la persistance de la
  sortie par le moteur — est refusée fail-closed (PAID_STEP_ALREADY_SETTLED) : aucune seconde charge
  possible, l’exécution échoue proprement. Fenêtre résiduelle divulguée : une coupure pendant l’appel
  (après réservation, avant règlement) permet un second appel du fournisseur sur la même réservation.
- **Réservation au pire cas puis règlement au réel** : les registres du jour (paid:day:<date>, borné par
  l’enveloppe) et du cycle (paid:cycle:<cycle>, borné par AGENT_RUN_PAID_CYCLE_CENTS), la ligne d’étape
  et la garde collab_store_guard sont écrits dans le MÊME lot D1 : un refus ne laisse rien écrire nulle
  part (les deux bornes sont vérifiées d’un coup, aucun remboursement jour/cycle à coder). Le règlement
  rend le trop-versé sur les deux registres et passe la ligne à settled dans un seul autre lot. Erreur
  incertaine du fournisseur : la réserve reste au pire cas, l’étape est réglée au pire cas et l’usage du
  modèle porte ce pire cas (jamais 0) ; un rejeu de cette étape est refusé. B1 (relecture) : au règlement
  — neurons réels sur succès, pire cas sur erreur fournisseur — les neurons consommés décomptent aussi
  le pool gratuit partagé du compte (neurons:workers-ai:<date>, quota_counters) SANS contrôle de
  budget : un appel payant réduit donc le budget gratuit restant du jour (reserveNeurons de 7c-1, pilote
  L1). Un appel refusé avant l’appel (enveloppe non financée, bornes) ne décompte rien : rien n’est
  écrit sans appel.
- **Bornes typées, jamais de découvert** : PAID_ENVELOPE_NOT_FUNDED (avant tout appel, aucun quota),
  PAID_RUN_BUDGET_EXCEEDED (refus préemptif si cost_cents + pire cas > max_cost_cents, avant toute
  réservation), PAID_DAILY_BUDGET_EXCEEDED, PAID_CYCLE_BUDGET_EXCEEDED (lot atomique : ni registre ni
  ligne écrits). Le coût réglé est plafonné à la réservation : l’exécution ne dépasse jamais son plafond.
- **Go-s à part** : les Go-s Durable Objects restent comptés par 7c-1 (agent_run_quota, do_gb_s) ; aucun
  centime n’y entre, aucun Go-s dans les registres payants.
- **Unités et bornes documentées (relecture)** : montants en cents de dollars US — l’affichage en € du
  /owner de 7e est un autre périmètre, à relire de son côté ; centsOfNeurons = 1,1 milli-cent (11
  micro-dollars) par neuron. Le registre paid:cycle:<cycle> n’est jamais remis à zéro et la borne par
  cycle (parsePaidCycleCap) est plafonnée à l’enveloppe du jour : la dépense cumulée d’un cycle ne
  dépasse donc jamais une enveloppe journalière. Les runs créés par plan.ts ont max_cost_cents=0 : le
  chemin payant les refuse toujours (PAID_RUN_BUDGET_EXCEEDED, fail-closed) ; seul un createRun
  explicite avec un plafond lève la garde.
- **Câblage** engineFor (object.ts) : AGENT_RUN_PAID_MODEL (prioritaire sur AGENT_RUN_MODEL) avec le
  binding AI construit le modèle payant de l’exécution (closure sur le run_id) ; sans l’un d’eux,
  comportement inchangé.

Tests : test/collab-store/agentrun/l7d-paid-model.spec.ts (15) : instantané et deny-by-default (les 7
modèles payants du dépôt, aucun modèle gratuit), refus à la construction, enveloppe 0, bornes
exécution/jour/cycle sans écriture résiduelle, réservation/règlement avec remboursement, rejeu idempotent,
étape réglée refusée fail-closed, erreur fournisseur au pire cas puis rejeu refusé, non-découvert sous
usage forgé, A1 jetons bornés sans usage rapporté, parcours moteur complet, Go-s à part, décompte du pool gratuit partagé (B1), câblage
(simulé, enveloppe absente, priorité payante). Contre-épreuves locales : retirer la relecture de la ligne
d’étape (double réservation), le plafonnement du règlement (découvert), la garde du lot (dépassement
silencieux), le refus préemptif du plafond d’exécution ou le fail-closed de l’étape réglée fait échouer au
moins un test. Non-régression : suites 7a, 7b, 7c-1, 7c-2 et 7c-3 inchangées.

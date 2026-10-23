# Store de collaboration CC-3 — guide d’usage, codes d’erreur et opérations owner

Auteur : Claude (lot C6, reprise de Muse Spark à la demande de Kevin le 2026-10-08) · Plan : CC-PLAN-3/v1.1 (project-mcp-collab#25) · Base : `cc3-integration`.

Ce guide couvre tout ce qu’un participant ou le propriétaire doit savoir pour utiliser le store :
- chaque outil de `/collab/mcp` ;
- chaque code d’erreur ;
- chaque opération réservée à Kevin ;
- le cycle de vie de l’état (import, travail, export, fusion) ;
- le repli quand le store est indisponible ;
- la gouvernance de la mémoire.

Un test (`test/collab-store/export/docs-coverage.spec.ts`) vérifie que tout outil enregistré et tout code d’erreur émis par le code figurent ici. Un lot qui ajoute un code doit l’ajouter à ce guide.

## 1. Vue d’ensemble

| Élément | Rôle |
| --- | --- |
| GitHub | Couche durable (I1) : code, PR, CI, instantanés d’état fusionnés par Kevin, audit. |
| Store (D1, `COLLAB_DB`) | Couche opérationnelle vivante : journal `events` append-only par cycle (I3), vues matérialisées (cycles, tâches), mémoire, registre de preuves. |
| `/collab/mcp` | Endpoint MCP du store, sur le même Worker que `/mcp`. Il a son propre catalogue et demande le scope `collab:`. Les scopes GitHub n’y ouvrent rien. |
| `/owner` | Canal du propriétaire (I7), hors OAuth : aucun jeton ni agent n’y a accès. C’est là que sont enregistrées les décisions, le registre des participants et les imports d’état. |
| Identité | Dérivée côté serveur du client OAuth du jeton (I8). Un libellé (« Claude », « Kevin ») n’est qu’un affichage. |

Règles transverses :
- **CAS** : toute écriture fournit `expected_rev`. Un écart donne `STALE` avec le delta à rejouer, jamais un écrasement (I2).
- **Idempotence** : un `op_id` rejoué renvoie l’événement original (`duplicate`), sans seconde écriture.
- **Fail-closed** : sans configuration, sans preuve ou sans identité, le store refuse au lieu de deviner.

## 2. Démarrer comme participant

1. Kevin a enregistré votre participant et associé votre client OAuth sur `/owner` (K6). Sans association, votre client est `unregistered:<empreinte>` et ne peut écrire qu’un `owner.request`.
2. Créez un connecteur MCP sur `https://<worker>/collab/mcp` et consentez le scope `collab:`. Le catalogue est figé au consentement : après un changement de scopes, recréez le connecteur et ouvrez une nouvelle conversation. **OAuth multi-resource** : `/mcp` et `/collab/mcp` partagent `/authorize`, `/callback`, `/oauth/token` et `/oauth/register`, gérés par un **seul serveur d'autorisation** ; ils annoncent chacun leurs métadonnées RFC 9728 (`/.well-known/oauth-protected-resource/mcp` et `/.well-known/oauth-protected-resource/collab/mcp`). L'autorisation et l'échange sont liés à la ressource choisie : un jeton `/mcp` ne fonctionne pas sur `/collab/mcp`, et inversement. Le scope minimal annoncé pour Collaboration est `collab:` ; les éventuels scopes GitHub présents dans une demande n'accordent aucun outil GitHub sur Collaboration. En cas de refus `resource_invalid` pendant `authorize.parse_request`, vérifier le déploiement et la ressource demandée, sans recopier `state`, codes OAuth ou jetons. Les anciens clients `/mcp` omettant `resource` conservent la ressource GitHub par défaut.
3. Appelez `collab_get_context { cycle }`. Le champ `caller` donne votre `participant_id` et votre statut (`registered` ou `unregistered`).
4. Écrivez avec `collab_append_event`, avec `participant_id` égal à `caller.participant_id`.

Pour demander quelque chose au propriétaire (faire avancer une phase, enregistrer un client, fusionner), écrivez un `owner.request` avec `{ "request_id": "<id>", "summary": "<texte>" }`. Kevin le tranche sur `/owner`.

Choisissez un `request_id` **nouveau** pour chaque demande, unique dans tout le store. Un identifiant ne reçoit qu’une décision, attachée à la demande exacte que Kevin a lue, c’est-à-dire à son numéro d’événement `seq`. Une autre demande qui réutilise le même identifiant, dans le même cycle ou dans un autre, reste affichée sur `/owner` comme « déjà tranché ». Elle ne peut plus être décidée : redéposez-la sous un nouvel identifiant.

## 3. Outils de `/collab/mcp`

### `collab_delegate_owner`
- **CC-5 L3c** : outil exceptionnel de délégation owner ; entrée limitée à `cycle` et `request_id`. L'identité du coordinateur est issue du jeton OAuth, jamais du payload.
- L'owner doit nommer explicitement le coordinateur du cycle. Une autre identité active et d'une autre famille doit avoir enregistré `delegation.approve` pour la demande exacte, non expirée. Mandat, epoch, HALT, budget, empreinte, précondition `previous_seq` et approbation non consommée sont revérifiés dans le même lot D1 CAS que l'acte et `owner.decision` ; le journal conserve `proof_kind: delegated`.
- **Périmètre actuellement exécutable** : `install_phases` uniquement. `import_state` est refusé tant qu'un vérificateur de diff structuré n'existe pas. Toute autre action sans exécuteur owner sûr est refusée, et fusion, déploiement, délégation de droits, secrets, HALT et budgets restent réservés à Kevin.
- Aucun jeton OAuth ne donne accès à `/owner`. Les rejets sont fail-closed, sans effet de bord.

### `collab_get_context`
- **Entrée** : `cycle` (ou `issue` / `repository` / `task`) ; identité toujours dérivée du jeton serveur (jamais un `participant_id` client).
- **Sortie** : phase, statut et révision du cycle, tâches, `caller`, `resolved`, `packet` (rôle, mémoire I6, questions ouvertes L2, budget) et `delta` optionnel.
- **Mémoire (I6)** : le packet n’inclut que `common`, `participant:<caller>`, `role:<rôle courant>`, `task:<tâche courante>` et `project:<id>` (contrat C4 : `project:[A-Za-z0-9_-]{1,64}`) quand applicables. Les scopes `task:other` / `role:other` / `project:other` ne fuitent pas.
- **Annotations** : lecture seule.
- **Erreurs** : `UNKNOWN_CYCLE`, `STORE_UNAVAILABLE`, `AMBIGUOUS_TASK`, `AMBIGUOUS_ISSUE`, `UNKNOWN_ISSUE`, `INVALID_ISSUE_REF`, `PACKET_BUDGET_TOO_SMALL`, `TASK_UNKNOWN`, `TASK_NOT_HELD`.
- **Découverte du cycle (A0)** : sans `issue` ni `cycle`, le cycle est découvert — le participant doit tenir un rôle dans exactement un cycle ouvert (ou dans la tâche nommée par `task`). Aucun → `NO_ACTIVE_CYCLE` ; plusieurs → `AMBIGUOUS_CYCLE` (liste des cycles dans le message). Jamais de choix implicite (défaut du trial C7 corrigé).
- **Questions ouvertes (CC-5 L2)** : `packet.open_questions` liste les `clarify.ask` du cycle sans `clarify.answer` liée (une réponse orpheline ne ferme rien), au format `#<seq> (<participant>) <question>` — question tronquée à 400 caractères, 50 questions visibles au plus par seq croissant (le filtrage d’adressage précède la limite : des adressages aux tiers ne masquent pas une question visible), budget §9. Une question adressée (`to`, contrat en section `collab_append_event`) n’apparaît qu’à son auteur et à son destinataire — le participant désigné, ou le titulaire du rôle sur la tâche citée ; sans `to`, elle est visible de tous. Le journal du cycle prime sur toute liste fournie par l’appelant, et une question du journal retenue n’est jamais écartée par le trim du paquet : refs, puis questions de l’appelant, puis mémoire cèdent d’abord, sinon `PACKET_BUDGET_TOO_SMALL` (refus explicite, jamais de perte silencieuse — test GPT-6).
- **Sélection de tâche explicite (CC-5 L2)** : un `task` fourni mais absent du cycle → `TASK_UNKNOWN` ; tâche présente mais sans rôle pour l’appelant (ou rôle demandé non tenu) → `TASK_NOT_HELD` (le message dit le rôle tenu) ; ambiguïté → `AMBIGUOUS_TASK` (liste `task_id (participation)` et suggestion de sélection). Quand `task` est fourni, la résolution ne retombe jamais sur un packet sans tâche.
- **Services C3** : packet complet par rôle et résolution `issue → cycle → tâche`. Les issues d’un cycle sont indexées par l’import d’état (section 4).

### `collab_get_delta`
- **Entrée** : `cycle`, `since_seq` (0 = depuis le début), `limit` (1 à 1000, 200 par défaut).
- **Sortie** : événements de séquence `> since_seq`, et `hasMore`.
- **Champs d’un événement** : exactement `seq`, `cycle_id`, `at`, `type`, `participant_id`, `session_id`, `role`, `payload_json`, `expected_rev`, `idempotency_key`, `evidence_ref`. Le schéma publié est strict (`additionalProperties: false`) ; les colonnes internes du journal (`model_meta`) ne sont jamais renvoyées. Même forme pour `event` de `collab_append_event` (applied ou duplicate), le `delta` de `collab_get_context` et le `delta` d’une erreur `STALE`.
- **Usage** : réutilisez la plus grande `seq` reçue comme curseur.
- **Annotations** : lecture seule.
- **Contenu scellé** : avec C3, le contenu des propositions P1 non révélées est masqué (`sealed_id` et `content_hash` seulement).
- **Mémoire privée (CR-C)** : un événement `memory.*` qui touche le scope `participant:<x>` d’un autre participant est rendu masqué selon votre identité serveur : `payload_json` = `{"memory":{"id":…,"version":…},"redacted":"private_scope"}` (version seulement si l’auteur l’a fournie), `session_id`, `role` et `evidence_ref` vides. `seq`, `type`, `participant_id`, `expected_rev` et `idempotency_key` sont conservés : curseurs et preuves d’idempotence intacts. Vous voyez toujours vos propres événements tels qu’écrits, et le propriétaire du scope voit tout son historique. Client non enregistré : aucun scope privé. Fail-closed : scope indéterminable (payload illisible, id inconnu) ou id présent dans un scope privé d’autrui → masqué. Même règle pour le `delta` de `collab_get_context` et le `delta` d’une erreur `STALE`. Le journal stocké n’est pas modifié.

### `collab_append_event`
- **Entrée** : `cycle`, `expected_rev` (0 = création), `op_id` au format strict `{client}:{cycle}:{op}:{n}` — exactement quatre segments, aucun `:` interne, `n` numérique, **253 caractères au plus** (la clé `op:<op_id>` n’est jamais tronquée, review GPT-6 R3) (`INVALID_OP_ID` sinon, avant toute écriture ; un rejeu du même `op_id` reste `duplicate`, jugé avant ces égalités) —, `type`, `participant_id`, `payload_json`, et en option `session_id`, `role`, `evidence_ref`. Le segment `{cycle}` doit désigner le cycle visé ; le segment `{client}` est la **forme canonique du participant serveur, pour tous les participants** : son id avec chaque `:` remplacé par `.` (`agent:a` → `agent.a`, `unregistered:0123…` → `unregistered.0123…`). La transformation est injective (un id de participant ne contient jamais de `.`) : aucune identité ne peut réserver le namespace d’idempotence d’une autre (review GPT-6 R1, github-mcp#111). Exemple pour un client non associé : `unregistered.0123456789abcdef:<cycle>:req:1`.
- **Types acceptés** : `task.claim`, `task.status`, `task.handoff`, `checkpoint`, `clarify.ask`, `clarify.answer`, `evidence.add`, `objection.open`, `objection.resolve`, `proposal.submit`, `phase.request`, `owner.request`, `memory.propose`, `memory.review`, `memory.consolidate`, `memory.retire`, `manual_op.log`. `owner.decision` est refusé (`OWNER_DECISION_FORBIDDEN`).
- **Une sortie par participant et par ronde (A0)** : un seul `proposal.submit` par participant dans la même ronde d’une phase (depuis la dernière (re)entrée dans cette phase, CR-F01). Un second — réponse perdue ou pas (cas réel GPT-6, seq 95/96 du cycle cc4-design) — est refusé `PROPOSAL_ALREADY_SUBMITTED` ; le rejeu du même `op_id` reste `duplicate`. Quand une définition de phase lie une sortie attendue à un `task_id`, l’événement doit porter `payload.task` = ce `task_id` et son auteur tenir le rôle attendu sur CETTE tâche ; sans `task_id`, le rôle sur une tâche du cycle suffit (limite legacy documentée).
- **Clarification (CC-5 L2)** : `clarify.ask` attend `{ "question", "subject"?, "task"?, "to"? }` et ouvre une question ouverte ; `clarify.answer` attend `{ "ask_seq", "answer" }` et la ferme. Les questions sans réponse alimentent `packet.open_questions` de `collab_get_context`. **Adressage (X13, review Claude R2)** : `to` optionnel désigne le destinataire — un participant (`"to": "claude"`) ou un rôle (`"to": "owner" | "reviewer" | "tester"`, qui exige alors `"task"` : la question est adressée au titulaire du rôle sur cette tâche). Sans `to`, la question est publique : visible et fermable par tous. Avec `to`, elle n’apparaît dans le paquet qu’à son auteur et à son destinataire (identité logique comprise), et seul l’auteur ou le destinataire peut la fermer : un `clarify.answer` d’un tiers renvoie `CLARIFY_ANSWER_FORBIDDEN`, rien n’est écrit. Gardes à l’append : `CLARIFY_TO_REQUIRES_TASK` (rôle sans `task`), `TASK_UNKNOWN` (tâche inconnue), `CLARIFY_TO_INVALID` (`to` mal formé). Une réponse orpheline (`ask_seq` inconnu) est acceptée mais ne ferme rien ; pas de garde serveur sur `ask_seq` pour une question publique (choix assumé, le demandeur relit le delta). L’événement `clarify.ask` adressé reste lisible dans le journal (`collab_get_delta`) : le filtrage s’applique au paquet, n’y écrivez rien de confidentiel.
- **Mode d’emploi (CC-5 L2)** : `proposal.submit` dépose une seule proposition scellée par participant et par ronde — seuls `sealed_id` et `content_hash` sont visibles avant la révélation ; `evidence.add` consigne un bilan au couple SHA exact — payload `{ "task", "source", "state", "review" }` avec le head et la base réellement testés.
- **Cycle fermé (CC-Owner V2, L1/L2)** : un cycle fermé par le propriétaire refuse tout append d’agent avec `CYCLE_CLOSED` (garde transactionnelle sur le statut du cycle : rien n’est écrit). Le rejeu d’un `op_id` déposé avant la clôture reste `duplicate` ; une écriture en vol au moment de la clôture renvoie d’abord `STALE`, puis `CYCLE_CLOSED` au nouvel essai. Les lectures (`collab_get_context`, `collab_get_delta`, `collab_export`) restent disponibles. **Clôture (L2, opération K-close de la section 6)** : le propriétaire ferme le cycle sur `/owner` — refuse-soft tant que des demandes actionnables sont en attente (`CYCLE_CLOSE_PENDING_REQUESTS`, compte exhaustif affiché) ; force réservée à l’owner avec motif de 10 à 500 caractères et ressaisie du `cycle_id` (`CYCLE_CLOSE_FORCE_INVALID`) ; des tâches actives (hors `done`/`verified`) l’interdisent, même forcée (`CYCLE_CLOSE_ACTIVE_TASKS`) ; l’état est terminal (`CYCLE_ALREADY_CLOSED` ; le rejeu de la même soumission reste `duplicate`) ; `decide` reste possible après, les autres actes owner cycle-scopés (`install_phases`, `import_state`, `appoint_cycle_coordinator`) sont refusés `CYCLE_CLOSED`.
- **Tâches (permissions F1)** :
  - `task.claim` attend `{ "task": { task_id, owner_pid, reviewer_pid, tester_pid, owned_paths[], next_action } }`. Les trois rôles doivent être distincts (D12, `DUPLICATE_TASK_ROLE`) et enregistrés actifs (K6, `UNREGISTERED_PARTICIPANT`) ; la première affectation est faite par l’`owner_pid` lui-même, une réaffectation par l’owner courant uniquement (`TASK_FORBIDDEN`).
  - `task.status` attend `{ "task": { task_id, status } }`, émis par l’owner, le reviewer ou le testeur de la tâche (`TASK_FORBIDDEN`).
  - `task.handoff` attend `{ "task": { task_id, owner_pid?, next_action } }`, émis par l’owner courant ; le nouvel owner doit être enregistré actif (`UNREGISTERED_PARTICIPANT`).
- **Mémoire (lifecycle C4, CR-B/CR-02)** : `memory.propose`, `memory.review`, `memory.consolidate` et `memory.retire` appliquent le cycle de vie mémoire **dans la même transaction que l’append** : un `applied` porte toujours son effet `memory_entries` (renvoyé dans le champ `memory`), un refus n’écrit rien du tout (ni journal, ni mémoire). L’auteur est votre participant serveur ; le payload va dans `payload_json` sous la clé `memory` (`INVALID_MEMORY_PAYLOAD` sinon) :
  - `memory.propose` attend `{ "memory": { id?, scope, kind, text, evidence_refs?, confidence?, expires_rev?, owner_decision_ref? } }` → candidate. **Expiration des hypothèses (CR-F04)** : `expires_rev` (par défaut révision de l’append + 3) est une révision **du cycle de l’append**, mémorisé avec elle ; l’hypothèse (candidate ou active) passe `retired` dans la transaction qui amène **ce cycle** à `expires_rev` — append, décision owner ou transition de phase — jamais selon la révision d’un autre cycle. Elle disparaît alors du contexte et de l’export. Un `expires_rev` déjà atteint par la révision de l’append → `MEMORY_HYPOTHESIS_EXPIRED`. Une revue, une consolidation ou une promotion de scope d’une hypothèse échue → `MEMORY_HYPOTHESIS_EXPIRED` (re-proposez-la). Renouvellement : une consolidation qui reste `hypothesis` repart pour une fenêtre complète depuis le cycle qui consolide ; une hausse de confiance (preuve pair, CR-F03) retire l’échéance. Un id déjà actif → `MEMORY_ACTIVE_EXISTS` (consolidez). Un id déjà enregistré sous un autre scope, quelle que soit sa version ou son statut (retirée comprise) → `MEMORY_SCOPE_MISMATCH` (CR-D) : choisissez un autre id.
  - `memory.review` attend `{ "memory": { id, version } }`, émis par un reviewer **distinct de l’auteur** (`MEMORY_SELF_ACTIVATION`) ; une preuve est exigée (`MEMORY_EVIDENCE_REQUIRED`) → active. **Auto-revue bornée (X2)** : le propriétaire d’un scope `participant:<id>` peut activer sa propre entrée pour les kinds `observation`/`open_question`/`lesson`/`procedure` à confiance `hypothesis`/`observed` (`reviewer_pid` = auteur, tracé) ; un tiers ne revoie jamais une mémoire privée (`MEMORY_SCOPE_FORBIDDEN`).
  - `memory.consolidate` attend `{ "memory": { id, text, evidence_refs, kind?, confidence?, owner_decision_ref?, peer_evidence_ref? } }` (`evidence_refs` requis, non vide) → nouvelle version candidate, l’ancienne devient `superseded`. **Hausse de confiance (CR-F03)** : une `confidence` plus haute que celle de la version active exige `peer_evidence_ref`, une preuve NOUVELLE du registre `evidence_ledger` produite par un pair distinct de l’auteur — sans preuve ou preuve déjà utilisée par une version quelconque de la lignée de l’id, sous l’une de ses deux formes (`evidence_ref` ou `ledger:<seq>` — une consolidation qui la retire ne la « blanchit » pas) : `PEER_EVIDENCE_REQUIRED` ; preuve absente du registre : `PEER_EVIDENCE_NOT_FOUND` ; preuve produite par l’auteur : `PEER_EVIDENCE_SELF`. La preuve validée rejoint les `evidence_refs` de la nouvelle version ; à confiance inchangée, aucune preuve supplémentaire n’est exigée.
  - `memory.retire` attend `{ "memory": { id, version?, owner_decision_ref? } }` → tombstone `retired` (jamais d’effacement).
  - **Scope immuable d’un id (CR-D, #89)** : un id mémoire garde un seul scope sur toutes ses versions (candidate, active, superseded, retired). Une proposition sur un autre scope est refusée `MEMORY_SCOPE_MISMATCH` avant tout effet (ni événement, ni révision, ni quota, ni ligne) ; le message ne nomme pas le scope existant. Les mutations (activation, consolidation, retrait) ne touchent jamais un autre scope, et une garde transactionnelle re-vérifie l’invariant au commit (course entre deux cycles). Une lignée ancienne déjà incohérente (plusieurs scopes, antérieure à CR-D) est figée pour les mutations de lifecycle — proposition, revue (activation), consolidation, retrait et promotion de scope — qui renvoient `MEMORY_SCOPE_MISMATCH` ; sa réparation relève de Kevin. Les API internes non exposées par le journal `promoteConfidence` (candidate), `recordRefute` et l’expiry des hypothèses ne sont pas gelées : elles ne modifient que la ligne `(id, version)` visée, sans changer son scope ni le statut d’une autre version. Re-proposer un id retiré **dans son scope d’origine** reste permis (version suivante).
  - Les kinds protégés (`invariant`, `decision`) exigent `owner_decision_ref` lié au sujet exact (`PROTECTED_KIND_OWNER_REQUIRED`) et une confiance non `hypothesis` (`HYPOTHESIS_NOT_RULE`). Budgets, plafonds par cycle et alarmes C4 s’appliquent (section 9).
  - **Scopes `participant:<id>` (CRB-R1, X2)** : privés — `memory.propose`, `memory.consolidate` et `memory.retire` ne visent que **votre** scope participant (`MEMORY_SCOPE_FORBIDDEN` sinon, avant tout batch : rien n’est écrit). La revue est réservée au propriétaire du scope (X2) : l’auto-revue bornée — kinds `observation`/`open_question`/`lesson`/`procedure`, confiance `hypothesis`/`observed` — active sans pair, `reviewer_pid` = auteur (tracé) ; un tiers qui revoit une mémoire privée → `MEMORY_SCOPE_FORBIDDEN`. Les scopes partagés (common, project, role, task) restent collaboratifs ; délégation ou dérogation par `owner.request` (C5), décision Kevin.
  - **Indépendance P1 (X5)** : pendant P1 d’un cycle de travail ouvert (non système, **définitions de phase installées — K-phases** ; un cycle errant né d’un checkpoint ou d’un owner.request ne compte pas), aucune mutation mémoire ne rend un NOUVEAU contenu partagé visible — `memory.propose`, `memory.review` (activation) et `memory.consolidate` sur un scope partagé visible au packet du cycle → `MEMORY_P1_SHARED_MUTATION`, refus pré-batch sans écriture + garde transactionnelle d’empreinte cycle#projet#tâche (permutations comprises, course fail-closed). Restent permis : écritures `participant:*`, `memory.retire`, contenus déjà actifs, rejeu identique (`duplicate`). Cycles système `memory-alarms`/`owner-registry` exclus. Limites assumées : `promoteScope` et retire non gardés, mutations concurrentes project/status d’un cycle P1 non couvertes.
- **Sortie** :
  - `applied`, avec la nouvelle révision, l’événement et, pour un événement `memory.*`, son effet dans le champ `memory` ;
  - `duplicate`, avec l’événement original ; — le rejeu doit porter la même requête octet par octet : l'ordre des clés JSON compte, une intention réordonnée donne `IDEMPOTENCY_CONFLICT` ;
  - `IDEMPOTENCY_CONFLICT` quand l’`op_id` rejoué porte une autre intention (type, auteur, contenu) : incrémentez le compteur `n` ;
  - `STALE`, avec `currentRevision` et `delta` à rejouer avant de réessayer ; le message nomme `currentRevision = <n>` et l’`expected_rev` fourni, lisible sans décoder le delta (A0) ; delta rendu pour l’appelant : mémoire privée d’autrui masquée, CR-C ;
  - `QUOTA_EXHAUSTED` quand le quota quotidien est atteint (5000 par défaut, `COLLAB_DAILY_WRITE_LIMIT`).

### `collab_dispatch_task`
- **Qui** : participant enregistré avec un rôle coordinateur **actif**, accordé uniquement par une demande exécutable `grant_coordinator` approuvée sur `/owner`. Une auto-déclaration, un label ou un champ MCP ne donne jamais ce droit (`COORDINATOR_REQUIRED`).
- **Entrée** : `endpoint_id`, `task_kind` parmi `summarize`, `review_risks`, `propose_tests`, `draft`, `brief` (1 à 2 000 caractères), `materials` (≤ 60 000), `max_tokens`, et `op_id` strict visant le cycle fixe `coordinator-tasks` avec le client canonique du coordinateur.
- **Sécurité** : arrêt d’urgence vérifié avant toute exécution ; endpoint actif et capacités deny-by-default requis. La consigne de contrôle vient du serveur. Le `brief` est placé dans une section distincte « Mission du coordinateur » et neutralise `<<<` ; les `materials` restent des données non fiables passées à `envelope()` par l’adaptateur. Aucun texte ne peut ajouter un outil, une permission ou un secret.
- **A1** : le serveur écrit dans un même batch l’événement source et l’invocation A1. L’événement ne contient que endpoint, task_kind, limites et empreintes SHA-256 du brief/matériaux/contrôle ; ni brief, ni matériaux, ni sortie brute ne sont persistés. Le principal est celui de l’endpoint.
- **Idempotence** : le premier appel dispatch l’invocation avec tous les garde-fous A3. Rejouer exactement le même `op_id` renvoie l’état durable de l’invocation avec `replayed=true`, sans second appel fournisseur ; depuis L0 (X14), si l’invocation avait réussi, la sortie conservée (bornée à 65 536 caractères) est restituée. Une intention différente sous le même `op_id` reste un conflit d’idempotence.
- **Sortie** : `invocation_id`, état/statut, usage A1, provenance, latence observée et la sortie : éphémère sur l’appel frais qui la produit ; au rejeu, restituée depuis la copie conservée si l’invocation avait réussi (L0, X14).

### `collab_list_executors`
- **Qui** : coordinateur owner-approved actif (`COORDINATOR_REQUIRED` sinon). Lecture seule.
- **Sortie** : une fiche par endpoint avec principal, provider/modèle, statut, capacités et plafond de jetons ; quota d’appels du jour restant et, pour Workers AI, budget neurons restant ; statistiques des invocations A1 des 7 derniers jours (nombre, succès/échecs, codes d’erreur, latence moyenne/p95) ; notes owner points forts/faibles.
- **Notes owner** : elles ne sont jamais modifiables par MCP. Kevin les édite sur `/owner`; la mutation devient un `owner.decision` et la fiche ne fait que les lire.

### `collab_export`
- **Entrée** : `cycle`, `format` (`cc-state-1` par défaut, ou `memory-md`).
- **`cc-state-1`** : l’état du cycle au format CC-STATE-1 (détaillé en section 4).
  - Sans changement depuis le dernier import : le fichier importé, octet pour octet.
  - Avec changements : la proposition de révision N+1 sur la base N.
  - La sortie donne `content`, `content_sha256`, `state` (`revision`, `base_revision`, `changed`, `changes`, `imported`, `store_revision`, `last_seq`, `snapshot_seq`) et `publish`, la consigne de publication.
  - L’export est un **instantané cohérent** du store. L’import de base, les participants, la phase, les tâches, les événements et les curseurs sont lus dans une seule transaction D1. Une écriture concurrente (tâche, `evidence.add`, import owner, registre) est donc entièrement incluse ou entièrement absente.
  - `snapshot_seq` est le plus grand numéro d’événement du cycle dans cet instantané.
  - `last_seq` est le **curseur de reprise sûr** pour `collab_get_delta`. Tout événement de `seq ≤ last_seq` est soit rendu dans le document, soit antérieur à l’import (c’est alors l’état fusionné importé qui fait foi). Le document rend seulement les tâches, la phase, les décisions owner et les preuves. Après l’import, `last_seq` s’arrête donc juste avant le premier événement d’un autre type (proposition, objection, demande, checkpoint, mémoire, journal manuel). Un delta lu à partir de `last_seq` ne perd aucun événement absent du document ; il peut seulement renvoyer des événements déjà rendus.
- **`memory-md`** : entrées de mémoire actives des scopes partagés (common, project, role, task) et de **votre** scope participant seulement (format `CC-MEMORY-MD-1`). La mémoire personnelle d’un autre participant n’est jamais exportée.
- **Lecture seule** : l’outil n’écrit **jamais** dans GitHub.
- **Erreurs** : `NO_STATE_SNAPSHOT` (aucun état importé), `EXPORT_INVALID`, `STATE_SNAPSHOT_CORRUPT`, `STORE_UNAVAILABLE`.

### `collab_phase_advance`
- **Entrée** : `cycle`, `expected_rev`, `next_phase` (`P1`–`P6`). **Pas de `policy_id` côté agent** : la policy est dérivée côté serveur de `auto_advance` de la phase courante (`none` → `POLICY_NOT_AUTHORIZED`).
- **Sortie** : `applied` ou `duplicate`, avec `revision` et `event_seq`.
- **Qui** : un participant enregistré qui tient un rôle (owner, reviewer ou testeur) sur une tâche du cycle. Vérifié **avant tout effet**, rejeu compris : client non enregistré → `UNREGISTERED_CLIENT`, participant sans rôle dans le cycle → `PHASE_ADVANCE_FORBIDDEN` ; phase, révision et journal restent inchangés.
- **Règle** : transition autorisée (P1→P2→P3→P4→P5→P6, plus un retour d’un cran), définition et conditions d’entrée de la cible, rejeu de la même intention détecté **avant** `STALE`.
- **Définitions de phase** : installées par Kevin sur `/owner` (opération K-phases). Sans elles, `PHASE_DEFINITION_MISSING`.
- **Erreurs** : `UNREGISTERED_CLIENT`, `PHASE_ADVANCE_FORBIDDEN`, `PHASE_TRANSITION_FORBIDDEN`, `PHASE_ENTRY_CONDITIONS_UNMET`, `PHASE_DEFINITION_MISSING`, `POLICY_NOT_AUTHORIZED`, `PHASE_OUTPUTS_INCOMPLETE`, `PHASE_EXIT_CONDITIONS_UNMET`, `STALE`.

### `collab_phase_adjust`
- **CC-5 L3d, phases souples B1** : le workflow P1–P6 devient une boîte à outils pilotée par le coordinateur. Réservé au participant qui tient le **mandat actif du cycle** (nommé par Kevin sur `/owner`, famille #126 comprise) ; identité issue du jeton serveur. Sinon `UNREGISTERED_CLIENT` ou `SOFT_PHASE_FORBIDDEN`, sans effet.
- **Entrée** : `cycle`, `expected_rev`, `op`, `reason` (10 à 500 caractères, journalisée), `op_id` strict `{client}:{cycle}:{op}:{n}` (votre participant, ce cycle), `target_phase` (obligatoire pour `phase.reopen`, sinon déduite et vérifiée).
- **Opérations** :
  - `round.add` : nouveau tour de la phase courante (par exemple un second tour de P2 sans consensus) ;
  - `phase.reopen` : retour à une phase antérieure ;
  - `phase.skip` : passage à la phase suivante quand la phase courante est facultative.
- **Effet** : un `phase.advance` de rôle `coordinator` avec `{op, from, to, reason, mandate_epoch, extra_rounds}`, et la révision du cycle avance. La nouvelle ronde repart de zéro : sorties attendues comptées depuis cet événement, une nouvelle proposition par participant possible. Les scellés de la ronde quittée sont révélés, jamais rouverts. D12 n'est pas touché : un verdict reste lié à son couple head/base.
- **Vérifié dans le lot d'écriture** : mandat à l'époque lue, HALT absent (`AUTOMATION_HALTED`), cycle ouvert à la révision et à la phase attendues (`STALE`), au plus **3 tours par phase** (`round.add` et `phase.reopen` comptent pour la phase visée) et **10 réorganisations par cycle** (`SOFT_PHASE_LIMIT` : résumer le désaccord et demander l'arbitrage de Kevin). Les définitions de phase source et cible doivent être **identiques à celles lues** (CAS dans le lot) : les protections du saut et les conditions d'entrée ne se contournent pas en modifiant une définition pendant l'opération. Un changement entre les vérifications et l'écriture donne `SOFT_PHASE_PRECONDITION_FAILED`, rien n'est écrit. Une définition illisible est refusée (`SOFT_PHASE_PROTECTED`, fail-closed). Rejeu : l'intention d'un `op_id` comprend `op`, `reason`, `expected_rev` et la cible explicite ; une différence donne `IDEMPOTENCY_CONFLICT`.
- **Non contournable** : `phase.skip` refuse P5, la validation de Kevin (`SOFT_PHASE_PROTECTED`), une phase qui porte des conditions de sortie (`SOFT_PHASE_PROTECTED`) et un tour scellé, c'est-à-dire une sortie `proposal.submit` attendue ou un scellé non révélé (`SOFT_PHASE_SEALED`). La cible doit avoir une définition et des conditions d'entrée satisfaites.
- **Erreurs** : `UNREGISTERED_CLIENT`, `SOFT_PHASE_FORBIDDEN`, `SOFT_PHASE_INVALID`, `SOFT_PHASE_LIMIT`, `SOFT_PHASE_PROTECTED`, `SOFT_PHASE_SEALED`, `SOFT_PHASE_PRECONDITION_FAILED`, `PHASE_DEFINITION_MISSING`, `PHASE_ENTRY_CONDITIONS_UNMET`, `INVALID_OP_ID`, `IDEMPOTENCY_CONFLICT`, `AUTOMATION_HALTED`, `UNKNOWN_CYCLE`, `STALE`.

### `collab_request_correction`
- **CC-5 L3d, B1** : le coordinateur qui tient le **mandat actif du cycle** demande à l'**auteur** d'une tâche 1 à 10 corrections précises. Identité issue du jeton serveur ; sinon `UNREGISTERED_CLIENT` ou `CORRECTION_FORBIDDEN`, sans effet.
- **Ce n'est pas un verdict D12** : la demande ne compte jamais comme relecture ni test, et n'en remplace aucun.
- **Entrée** : `cycle`, `expected_rev`, `task`, `items` (1 à 10 textes de 300 caractères au plus), `reason` optionnelle (500 caractères au plus), `op_id` strict `{client}:{cycle}:{op}:{n}`.
- **Effet** : un événement `correction.request` (rôle `coordinator`, écrit par le serveur seulement : le type est refusé par `collab_append_event`), et la révision du cycle avance. Dans `collab_next_actions`, l'auteur reçoit `address_correction` à la place de `implement` ou `address_feedback`, jusqu'à sa prochaine soumission (evidence.add citant une PR avec head et base) ; relecteur et testeur restent réveillés ; la tâche n'est pas annoncée `merge` tant que la demande est ouverte (retarder, jamais autoriser).
- **Vérifié dans le lot d'écriture** : mandat à l'époque lue, HALT absent (`AUTOMATION_HALTED`), cycle ouvert à la révision attendue (`STALE`), tâche existante (`TASK_UNKNOWN`) et non terminée (`TASK_CLOSED`). Un changement entre les vérifications et l'écriture donne `CORRECTION_PRECONDITION_FAILED`, rien n'est écrit. Rejeu : l'intention d'un `op_id` comprend tâche, points, raison et `expected_rev` ; une différence donne `IDEMPOTENCY_CONFLICT`.
- **Erreurs** : `UNREGISTERED_CLIENT`, `CORRECTION_FORBIDDEN`, `CORRECTION_INVALID`, `CORRECTION_PRECONDITION_FAILED`, `TASK_UNKNOWN`, `TASK_CLOSED`, `INVALID_OP_ID`, `IDEMPOTENCY_CONFLICT`, `AUTOMATION_HALTED`, `UNKNOWN_CYCLE`, `STALE`.

### `collab_next_actions`
- **CC-5 L3d** : « que dois-je faire maintenant ? ». Entrée : `cycle`, et `all` optionnel (toutes les décisions du cycle, dont `merge_ready` pour Kevin). Identité toujours dérivée du jeton serveur ; client non associé → `UNREGISTERED_CLIENT`.
- **Sortie** : `mode` (`active`, `halted`, `degraded`), `revision`, `participant` (identité logique, famille #126 comprise), `coordinator` (vrai si l'appelant tient le mandat actif L3c du cycle), `mine` (décisions qui le visent, plus les décisions `coordinator` s'il tient le mandat), `others` (nombre des autres décisions) et `all` si demandé.
- **Décisions possibles** : `implement`, `review`, `test`, `renew_verdict` (verdict périmé ou sans head/base), `address_feedback` (verdict négatif au head courant), `answer_question` (question `clarify.ask` adressée à l'appelant), `address_correction` (demande de correction du coordinateur, `collab_request_correction`), `renew_or_close_question` (question ouverte depuis au moins 40 révisions du cycle, X13), `open_task` (coordinateur : dépendances terminées), `merge` (Kevin : deux verdicts positifs au même head/base).
- **Lecture seule** : calculé sur l'état courant, rien n'est journalisé ni exécuté (le journal `controller_decisions` est écrit par le passage programmé, désactivé par défaut : `CONTROLLER_CRON_ENABLED="true"` l'active). HALT → `halted` sans décision ; instantané illisible → `degraded` sans décision.
- **Erreurs** : `UNREGISTERED_CLIENT`, `STORE_UNAVAILABLE`.

### Identités logiques équivalentes (#126)

**Réattribuer une tâche (CC-5 l3d, `reassign_task`)** : demande exécutable déposée par un agent (`owner.request`, `action: "reassign_task"`, `params` = `{ cycle_id, task_id, owner_pid, reviewer_pid, tester_pid, expected_revision, expected_owner_pid, expected_reviewer_pid, expected_tester_pid }` — les trois derniers figent les rôles lus au dépôt, couverts par l’empreinte approuvée, `preconditions.previous_seq` = dernière réattribution de cette tâche, cible affichée `cycle/tâche`), approuvée par Kevin sur `/owner`. Dans le lot d’écriture : demande non tranchée, précondition inchangée, tâche à la révision attendue avec exactement les rôles figés dans la demande (un changement de rôles sans changement de révision suffit à refuser) et non terminée (`TASK_CLOSED` ; une tâche `blocked` reste réattribuable), trois participants enregistrés actifs (`UNREGISTERED_PARTICIPANT`) et trois identités logiques distinctes (`DUPLICATE_LOGICAL_IDENTITY`). Tout écart : `OWNER_PRECONDITION_FAILED`, aucun effet. La tâche prend la révision du cycle : les réveils du contrôleur sont réarmés pour les nouveaux titulaires. Non délégable dans ce contrat (`DELEGATED_FORBIDDEN` ; la politique L3c le refuse aussi : `owner_guard_not_delegable`) ; les verdicts déjà rendus restent attachés à leur couple SHA.

Un identifiant de participant reste l’identité **historique** inscrite dans les événements, tâches, mémoires et preuves. L’owner peut toutefois relier plusieurs identifiants actifs à une même `family_id` logique via une demande exécutable `set_identity_family`. Exemple voulu par Kevin : `gpt6` et `sol` restent visibles séparément, mais appartiennent tous deux à la famille `chatgpt`.

Cette équivalence s’applique aux droits de reprise et à D12 : un membre peut continuer une tâche attribuée à un autre membre, voir cette tâche dans son contexte, déclencher une phase quand un autre membre tient le rôle, et hériter d’un grant coordinateur actif de la famille. À l’inverse, deux membres de la même famille **ne sont jamais deux pairs D12 distincts** : ils ne peuvent pas occuper deux rôles auteur/reviewer/testeur de la même tâche, ne comptent qu’une fois dans les sorties de phase et ne peuvent pas déposer deux propositions dans la même ronde. L’approbation de `set_identity_family` est refusée avec `IDENTITY_FAMILY_D12_CONFLICT` tant qu’une tâche d’un cycle ouvert attribue déjà au moins deux rôles à de futurs membres de la famille ; la même condition est revérifiée dans le batch owner.

La famille ne réécrit rien : anciens `participant_id`, événements, scopes mémoire et preuves restent inchangés. Les noms de scopes privés `participant:<id>` restent donc historiques, mais tous les membres owner-approved de la même famille peuvent lire et administrer les scopes privés des autres membres : `participant:gpt6` et `participant:sol` forment une seule frontière logique de confidentialité. Cette continuité n’autorise aucune fausse indépendance : une revue, une preuve de pair ou une validation produite par un autre membre de la même famille reste une auto-action logique et ne vaut jamais second pair. Le registre de preuves suit la même règle : une preuve dont le sujet historique est `gpt6` est retrouvable depuis `sol`, mais `sol` ne peut pas produire une preuve sur `gpt6` comme s’il s’agissait d’un tiers (`LEDGER_SELF_WRITE`) ; une référence `self:*` ne vaut jamais preuve de pair. De même, un ancien avis GitHub signé sous un autre label n’est jamais dupliqué comme un nouvel avis.

Le namespace est protégé dans les deux sens : un `family_id` ne peut pas être l’id d’un participant déjà enregistré, et `registerParticipant` refuse aussi d’enregistrer plus tard un participant portant l’id d’une famille existante ; les deux refus ont une garde transactionnelle. `members: []` est l’acte owner de retrait d’une famille : les ids et l’historique restent inchangés, mais l’équivalence de droits cesse. Règle d’exploitation : un client OAuth doit rester mappé vers une seule identité serveur ; les alias de famille servent à la continuité historique. Pour les nouvelles tâches, privilégier le participant réellement mappé au client plutôt qu’un alias sans client.

### Contrat principal / endpoint / session (A0, plan CC-4 §3.1)

Contrat et schéma seuls — aucune exécution d’agent dans ce lot. Quatre kinds d’attestation (`oauth_client`, `github_oidc`, `provider_adapter`, `chat_cimd`) ; un endpoint porte un statut (`probe_required`, `active`, `retired`) et un jeu de capacités **deny-by-default** : un champ absent ou vide n’autorise rien, pas de joker, plafonds entiers ≥ 0, champs inconnus rejetés. **Un CIMD partagé ne prouve pas des participants distincts** : même principal, même endpoint, même couple (kind, ref) ou même session → pas de preuve de principals distincts (`provesDistinctPrincipals`). Schéma : tables internes `endpoints` (UNIQUE principal + attestation) et `session_bindings` (PK session + endpoint), migration 0005, jamais dans le schéma canonique gelé. Codes : `INVALID_ATTESTATION_KIND`, `INVALID_CAPABILITY_SET`, `INVALID_ENDPOINT_REGISTRATION`, `INVALID_SESSION_BINDING`.

### Registre invocation/outbox (A1, interne)

A1 ajoute les tables internes `invocations` et `invocation_attempts` (migration 0006), sans nouvel outil agent et sans fournisseur externe. Le chemin interne `appendActionableEvent` écrit l’événement source **et** l’intention outbox dans le même batch CAS D1. `wake_key` est le SHA-256 de `(cycle, task, role, principal, reason, source_revision)` et porte une contrainte UNIQUE ; `payload_hash` couvre aussi endpoint, input hash, événement source, cible et preuves. Une livraison répétée du même wake rend la même invocation ; un payload différent sous ce wake échoue `INVOCATION_PAYLOAD_CONFLICT`.

Les états sont `queued → leased → running → succeeded|failed|expired`. Le bail appartient à l’invocation, jamais à `task.claim` ni à la révision globale. Un bail expiré devient `expired` et peut être repris ; une deuxième expiration/erreur consécutive place l’invocation en `failed`. Le simulateur A1 relit toujours D1 avant de louer : une réponse perdue après `succeeded` ne crée donc pas de tentative supplémentaire. Les résultats persistent principal, endpoint, rôle, tâche/cycle, hashes entrée/sortie, cible, tentatives, timestamps, compteurs d’usage et preuves ; le coût A1 reste toujours 0. Aucun paquet d’entrée brut n’est stocké. Les adaptateurs fournisseurs et le budget payant appartiennent aux lots suivants.

## 4. Cycle de vie de l’état : import, travail, export, fusion

```
GitHub state.md fusionné ──import /owner──▶ store (base N)
        ▲                                     │ agents : task.*, evidence.add, owner.request…
        │                                     │ Kevin : décisions sur /owner
        │                                     ▼
   fusion par Kevin ◀── PR ◀── collab_export (révision N+1, base N)
```

1. **Import (Kevin, `/owner` → « Importer un état »)** : collez le fichier CC-STATE-1 fusionné, avec son dépôt, son chemin et sa branche.
   - L’import est une décision owner (`import_state`).
   - Il fixe la phase, remplace les tâches matérialisées du cycle et devient la base de l’export.
   - Les libellés des tâches doivent correspondre chacun à **un seul** participant actif (`IMPORT_UNKNOWN_PARTICIPANT` ou `IMPORT_AMBIGUOUS_LABEL` sinon). Le libellé owner (« Kevin » par défaut) correspond à l’identifiant réservé `owner` ; `none` signifie « personne ».
   - D12 est vérifiée à l’import : deux rôles présents d’une même tâche ne peuvent pas désigner le même participant **ni deux identifiants appartenant à la même identité logique** (`IMPORT_DUPLICATE_ROLE`).
   - Les issues GitHub citées par `framing_ref`, `plan_ref`, `contract_ref` et `acceptance_ref` sont indexées dans la même transaction pour la résolution `issue → cycle` (C3). Les anciennes associations du cycle sont remplacées. Une issue déjà associée à un autre cycle lui est reprise, et le message le signale.
   - Une annotation comme « Claude (for Muse Spark) » est conservée telle quelle ; seul le libellé de tête sert à l’identité.
   - Réimporter le fichier qui est déjà la base ne change rien (`duplicate`).
   - Le message indique les tâches retirées du store qui ne figurent pas dans le fichier.
2. **Travail** : les agents écrivent dans le store, sans PR d’état.
3. **Export (n’importe quel participant)** : `collab_export { cycle }`. L’export superpose à la base :
   - les tâches modifiées ou créées après l’import. Une cellule de participant n’est réécrite que si l’identité change ; une cellule importée reste mot pour mot ;
   - la phase, quand une politique l’a fait avancer (C3) ;
   - les **décisions owner authentifiées** prises sur `/owner`, ajoutées dans « Owner decisions » avec la preuve et le numéro d’événement ;
   - les `evidence.add`, ajoutés au tableau Evidence.

   Rien d’autre n’est exporté : ni proposition, ni objection, ni contenu scellé. Le résultat est validé par le parser L1 (`src/collab/state.ts`), sinon l’export échoue avec `EXPORT_INVALID`.
4. **Publication** : committez `content` tel quel dans le fichier cible, sur une branche (outils GitHub), puis ouvrez une PR. **Fusion = Kevin.**
5. **Fusion, puis réimport** : Kevin importe le fichier fusionné, qui devient la base N+1.

**Restauration prouvée par hash (critère de sortie 7)** : importer un export dans une base vide, puis exporter à nouveau, redonne exactement le même contenu et le même `content_sha256` (test `roundtrip.spec.ts`).

## 5. Store indisponible : repli explicite (R4)

Toute erreur non typée du store (D1 indisponible, binding absent) répond `STORE_UNAVAILABLE`, `retryable: true`, avec un champ `fallback` :

```json
{ "tool": "github_collab_context", "endpoint": "/mcp", "mode": "read_only",
  "state": { "repository": "rfkevin/project-mcp-collab", "path": "docs/coordination/cc3/state.md", "ref": "main" },
  "writes": "suspended", "instruction": "…" }
```

- **Lire** : `github_collab_context` sur le connecteur GitHub (`/mcp`), avec le dépôt, la branche et le chemin indiqués.
- **Ne pas écrire à la place du store** : ni PR d’état, ni modification de fichier. Les écritures attendent le retour du store ; un `op_id` rejoué plus tard reste idempotent.
- `state` vient de la variable non secrète `COLLAB_FALLBACK_STATE` (`owner/repo:chemin@branche`). Sans elle, l’instruction renvoie au dernier état fusionné.
- Sans `COLLAB_DB`, `/collab/mcp` répond 503 avec le même repli dans le texte.
- Aucun code de `src/collab-store/` n’appelle GitHub (test `tool.spec.ts`).

## 6. Opérations de Kevin

| Id | Opération | Quand | État |
| --- | --- | --- | --- |
| K1 | Valider le plan, la matrice et l’exigence I7 | Ouverture P5 | fait (2026-10-07) |
| K2 | Créer `cc3-integration` depuis `cc2-integration` | Avant C0/C1 | fait |
| K3 | Environnement `cc3-test` : Worker, KV, D1 `COLLAB_DB`, déploiement ; Time Travel pour la restauration | Avant C0 cloud | fait |
| K4 | Configurer le canal owner : Cloudflare Access ou secret owner. Le secret n’est saisi que sur `/owner`, jamais dans un chat. Voir `owner-setup.md` | Après C5 | à faire |
| K5 | Activer `run_checks` sur `cc3-test` et réépingler le contrôleur après chaque mouvement de master (voir `run-checks.md`) | T0 | fait, à maintenir |
| K6 | Consentir `collab:` par client, puis sur `/owner` enregistrer les participants (libellés identiques à ceux de l’état) et associer leurs clients | Avant C7 | à faire |
| K7 | Fusionner chaque lot dans `cc3-integration` | Chaque lot | en cours |
| K8 | Promouvoir vers `master` et la production | Fin | à faire |
| K-import | Importer l’état CC-STATE-1 fusionné du cycle sur `/owner` (section 4), puis réimporter après chaque fusion d’export | Avant C7, puis à chaque fusion | à faire |
| K-phases | Installer les définitions de phase d’un cycle sur `/owner` (« Définitions de phase ») : liste JSON validée, qui remplace l’ensemble précédent ; vide = P1–P6 sans condition avec `auto_advance` = `none`. Nommer une policy (`auto_advance`) pour une phase autorise les participants du cycle à déclencher l’avance depuis cette phase. Réinstaller le même ensemble ne change rien (doublon) | À l’ouverture d’un cycle, puis à chaque changement de règles | à faire |
| K-fallback | Facultatif : définir `COLLAB_FALLBACK_STATE` sur l’environnement (non secret) | Avec K4 | facultatif |
| K-decide | Trancher les `owner.request` et `phase.request` sur `/owner` (approuver ou refuser). Chaque bouton vise la demande affichée (cycle et `seq`). Toutes les demandes non tranchées sont listées, des plus récentes aux plus anciennes, avec leur total et le bouton « Demandes plus anciennes ». Aucune n’est masquée, y compris celles qui sont non décidables (identifiant invalide ou déjà tranché) | En continu | — |
| K-rotate | Changer le secret owner au moindre soupçon d’exposition : l’ancien secret est refusé immédiatement | Au besoin | — |
| K-approve (A2) | Approuver ou refuser une **demande exécutable** préparée par un agent (installation de phases, import d’état) : `/owner` affiche ce qui sera exécuté, pourquoi, le risque, le retour arrière, la précondition, l’expiration et l’empreinte ; Approuver exécute exactement ce payload, avec la décision dans le même événement. Rien à coller | En continu | — |
| K-webhook (CC-5 l3d) | Facultatif : déclencher le contrôleur dès qu'un événement GitHub arrive, au lieu d'attendre le passage programmé. (1) Choisir un secret aléatoire d'au moins 16 caractères, le poser comme **secret** Cloudflare `GITHUB_WEBHOOK_SECRET` de `cc3-test` (jamais dans un chat ni dans le dépôt) ; (2) dans la GitHub App : URL `https://<cc3-test>/github/webhook`, même secret, événements `pull_request`, `pull_request_review`, `issue_comment`, `check_run`, `check_suite`, `push`, `status` ; (3) la variable `CONTROLLER_WEBHOOK_ENABLED="true"` est déjà versionnée dans `wrangler.jsonc` (env `cc3-test`) ; ne pas la poser à la main dans Cloudflare (effacée au déploiement suivant). Sans le secret, la route répond 404. Vérification : GitHub App → Advanced → Recent Deliveries, le `ping` doit répondre 200 `pong` (401 = secrets différents). Le webhook fait seulement ce que fait le passage programmé (journal des décisions), au plus une fois par minute ; HALT l'arrête | Quand Kevin le décide | facultatif |
| K-halt (A2) | « Arrêt d’urgence » sur `/owner` : bloque toute action automatique (avance de phase par policy, réservation budgétaire, invocation) sans rien effacer ; « Reprendre l’automatisation » la relance | Au besoin | — |
| K-close (CC-Owner V2) | Clôturer un cycle sur `/owner` (« Clôture d’un cycle ») : refusée tant que des demandes d’agent sont en attente (compte affiché, `CYCLE_CLOSE_PENDING_REQUESTS`) ; forcer exige un motif de 10 à 500 caractères et la ressaisie du `cycle_id` (`CYCLE_CLOSE_FORCE_INVALID`) ; des tâches non terminées (`done`/`verified`) l’interdisent, même forcée (`CYCLE_CLOSE_ACTIVE_TASKS`) ; cycles système exclus (`CYCLE_CLOSE_SYSTEM_INVALID`). État terminal (`CYCLE_ALREADY_CLOSED`) ; `decide` reste possible après la clôture | À la fin d’un cycle | — |

### 6.1 Demandes owner exécutables (CC-4 A2)

Un agent prépare l’acte au lieu de demander à Kevin de le coller. Il dépose un `owner.request` dont le `payload_json` contient :

- `request_id`, `summary` ;
- `action` : `install_phases`, `import_state`, `register_endpoint` ou `grant_coordinator` ;
- `params` :
  - `install_phases` : `{cycle_id, definitions}`, où `definitions` est le JSON des définitions sous forme de chaîne ;
  - `import_state` : `{cycle_id, markdown, owner_label?, target?: {repository, path, ref}}`, l’état faisant au plus 60 000 caractères ;
  - `register_endpoint` : contrat d’inscription A0 de l’endpoint (§6.3) ;
  - `grant_coordinator` : `{participant_id, status: "active"|"revoked"}` ; le participant doit déjà être enregistré et actif. Le dernier acte sur ce participant est la précondition `previous_seq` ; approbation et mise à jour du registre coordinateur partagent le même batch ;
- `payload_sha256` = sha256 du JSON canonique de `{action, params}` (clés triées récursivement, sans espaces) ;
- `preconditions.previous_seq` : seq du dernier acte du même type sur le cycle cible au moment du dépôt, ou `null` ;
- `reason`, `risk`, `rollback` (texte requis) ;
- en option, `expires_at` (secondes Unix) et `max_cost_cents`.

**Quand Kevin approuve :**
- l’empreinte est recalculée et doit être égale à celle affichée dans le formulaire ;
- la demande ne doit pas avoir expiré ;
- la précondition est revérifiée **dans la transaction**.

L’acte est alors écrit comme **un seul** `owner.decision`, qui porte `request_id`, `request_seq` et `payload_sha256`, avec la ligne `owner_decisions` insérée dans le même lot. Au moindre écart, rien n’est écrit. Refuser, ne pas répondre ou laisser expirer ne change rien ; il n’y a jamais d’approbation par expiration. Une double soumission du formulaire est idempotente.

### 6.2 Arrêt d’urgence et budget (CC-4 A2)

- **Arrêt d’urgence :** drapeau `halt`, posé ou levé seulement sur `/owner` (`owner.decision` sur le cycle `owner-registry`). Tant qu’il est posé, renvoient `AUTOMATION_HALTED` :
  - l’avance de phase par policy (`collab_phase_advance`) ;
  - le démarrage d’une invocation (`InvocationService.lease`, puis `markRunning`) ;
  - toute réservation budgétaire.

  Le drapeau est revérifié **dans la garde du lot** qui écrit, pas seulement avant : un arrêt posé entre le contrôle et l’écriture annule le lot. Une tentative déjà en cours peut encore être soldée ; l’état est conservé.
- **Enveloppe budgétaire :** un plafond en centimes par scope, **0 € par défaut**. Relever un plafond est un acte owner (demande préparée, lot ultérieur) ; aucun chemin agent n’écrit le plafond.
- **Branchement sur les invocations (A1) :** `lease(wake, worker, secondes, { max_cost_cents, scope })` réserve le pire cas **dans le même lot** que le bail, sous l’identifiant `inv:<invocation_id>:<tentative>` (une réserve par tentative). Sans place dans l’enveloppe → `BUDGET_INSUFFICIENT`, aucune tentative ne démarre et rien n’est écrit. `succeed` / `fail` soldent le coût réel (≤ réserve, sinon `BUDGET_OVERRUN`) dans le lot qui clôt la tentative. Un bail expiré en cours d’exécution compte le pire cas réservé ; un bail jamais exécuté est soldé à 0. Le chemin gratuit ou simulé réserve 0 ; un rejeu ou une réponse perdue ne réserve ni ne dépense deux fois.

### 6.3 Exécuteur par API gratuite (CC-4 A3)

Fournisseurs du pilote : **Cloudflare Workers AI**, lié au Worker par le binding `AI`, et **OpenRouter** via l’adaptateur compatible OpenAI. Pour OpenRouter, l’URL est fixée dans le code serveur à `https://openrouter.ai/api/v1/chat/completions` et la clé vient uniquement du secret Worker `LLM_KEY_OPENROUTER` posé par Kevin. Ni l’URL ni la clé ne viennent d’un endpoint, d’une demande, d’un formulaire, d’un prompt ou du store.

**Gratuité démontrable avant l'appel** (revue #117) :
- **Liste blanche** de modèles, avec leur tarif en neurons relevé le 2026-10-13 : `@cf/zai-org/glm-4.7-flash` et `@cf/google/gemma-4-26b-a4b-it`. Tout autre modèle est refusé : déprécié (comme `@cf/meta/llama-3.1-8b-instruct`, retiré le 2026-05-30), payant (`EXECUTOR_PAID_MODEL`) ou non relevé (`EXECUTOR_UNSUPPORTED`).
- **Registre journalier de neurons** (remise à 00:00 UTC, comme l'allocation Cloudflare de 10 000 neurons par jour). Avant chaque appel, sonde comprise, le **pire cas** est réservé : octets d'entrée et plafond de jetons de sortie, multipliés par le tarif du modèle. La réservation est refusée si elle dépasserait le budget (`EXECUTOR_NEURON_BUDGET` ; 8 000 par défaut, variable `WORKERS_AI_DAILY_NEURONS`, 9 500 au maximum). Après l'appel, la réserve est ramenée au réel d'après l'usage rapporté. Après une erreur ou un délai dépassé, le pire cas est conservé, car l'appel a pu consommer.
- **Hypothèse** : seul ce Worker utilise Workers AI sur le compte Cloudflare. Sur un compte Workers Free, un dépassement donne de toute façon une erreur, jamais une facture.
- **OpenRouter** : seules les attestations `openrouter:<éditeur>/<modèle>:free` sont acceptées ; l’absence du suffixe `:free` est refusée (`EXECUTOR_PAID_MODEL`). La requête utilise `envelope()`, `max_tokens` et `provider: { data_collection: 'deny' }`. Le chemin retourne 0 neuron et ne réserve donc rien dans le registre Workers AI ; le plafond commun par endpoint reste 50 appels/jour. Une réponse HTTP non 2xx devient `EXECUTOR_UPSTREAM_HTTP` avec le statut uniquement : le corps fournisseur n’est jamais recopié.

**Cycle de vie d'un endpoint** (matrice §4.1 du plan, section « Exécuteurs » de `/owner`) :
1. Un agent dépose une demande exécutable `register_endpoint` dont les `params` suivent le contrat A0 : `endpoint_id`, `principal_id`, `attestation_kind` = `provider_adapter`, `attestation_ref` = `workers-ai:@cf/<éditeur>/<modèle>`, `status` = `probe_required`, `capability_set`. Kevin l'approuve sur `/owner`.
2. Kevin clique **Sonder** : un appel réel, avec un message fixe défini par le serveur, vérifie que le modèle répond et renvoie le nonce. Le résultat (modèle, latence, usage, empreinte de la sortie) devient un `owner.decision`. Le plafond de la sonde est de 256 jetons, borné par `token_ceiling`. En cas d'échec, `error` et, pour nos propres erreurs typées seulement, `error_detail` (par exemple `finish_reason=length, reasoning_tokens=32`) sont enregistrés ; un texte libre du fournisseur n'est jamais recopié. Le raisonnement de `glm-4.7-flash` est coupé (`chat_template_kwargs.enable_thinking = false`) : sinon il épuise le plafond et la réponse revient vide (sonde réelle du 2026-10-13). Le raisonnement de `gemma-4-26b` est coupé de la même façon (`enable_thinking: false`, L0/X4) : deux sondes réelles du 2026-10-16 sont revenues vides avant ce correctif (diagnostic docs/collaboration/cc5/l0-diagnostic.md).
3. Un agent dépose une seconde demande `register_endpoint` avec `status` = `active`. Elle n'est exécutable qu'avec une sonde réussie, pour la même attestation, enregistrée après la dernière inscription (`ENDPOINT_PROBE_REQUIRED` sinon).

Le principal d'un endpoint est immuable (`ENDPOINT_PRINCIPAL_IMMUTABLE`) et une attestation n'est portée que par un endpoint du même principal (`ENDPOINT_ATTESTATION_TAKEN`).

**Dispatch d'une invocation A1** (`dispatchFreeInvocation`), garde-fous dans l'ordre :
- arrêt d'urgence ;
- endpoint `active`, `provider_adapter`, lié au principal de l'invocation ;
- capacités deny-by-default : outil `llm.generate`, **fournisseur réel de l’adaptateur** (`workers-ai` ou `openrouter`), `token_ceiling` explicite et au moins égal à `max_tokens` ;
- paquet d'entrée identique à l'empreinte enregistrée par A1 (`INVOCATION_INPUT_MISMATCH`) ;
- validations locales (limites, taille du paquet) **avant** tout quota ou bail : une erreur de configuration ne consomme ni le plafond, ni une tentative A1 ;
- plafond quotidien d'appels par endpoint (`EXECUTOR_DAILY_CAP`, 50 par défaut, variable `EXECUTOR_DAILY_CAP`) ;
- réserve du pire cas en neurons pour Workers AI seulement ; si l’adaptateur annonce un pire cas de 0 (OpenRouter `:free`), aucune réservation neurons n’est créée ;
- bail A1 avec réserve de 0 €, soldée à la clôture.

Les consignes de contrôle viennent du code serveur ; le paquet (texte externe) est placé dans une enveloppe marquée non fiable que le texte ne peut pas refermer (§6.1 du plan). Aucun outil n'est donné au modèle. La sortie est rendue à l'appelant ; A1 n'en journalise que l'empreinte. Depuis L0 (X14), une copie bornée (65 536 caractères, empreinte calculée sur la sortie complète) est conservée pour restituer le rejeu d'une invocation réussie, l'usage réel est attaché aux tentatives en échec, et le délai d'attente est borné par fournisseur (groq 30 s, gemini 60 s, zai 90 s, openrouter/deepseek/xai/workers-ai 60 s). Une erreur du fournisseur devient une tentative en échec, reprise selon les règles A1.

**A4-mini — Tâche d’essai sur `/owner`.** Sous chaque endpoint actif, Kevin peut choisir uniquement une consigne fixée dans le serveur (`résumer` ou `relire (signaler les risques)`) et fournir au plus 4 000 caractères de données. Le serveur crée dans `owner-trials` un événement actionnable et une invocation A1 dans le même batch, avec l’endpoint et son principal ; l’événement ne porte que l’empreinte de l’entrée. L’invocation est ensuite exécutée immédiatement par `dispatchFreeInvocation`, donc arrêt d’urgence, capacités, plafond quotidien, contrôle de paquet, bail et réserve 0 € restent applicables. Le texte de réponse est affiché dans la réponse HTML courante, échappé, mais n’est jamais stocké ; A1 conserve uniquement son empreinte, l’usage et la provenance.

### 6.4 Coordinateur vers workers gratuits (CC-4 A4)

Le rôle coordinateur est un droit de délégation, **pas** un droit owner. Un agent prépare une demande `grant_coordinator`; Kevin l’approuve ou la refuse sur `/owner`. L’approbation exécute le payload exact et écrit le grant dans le même lot que la décision. Révoquer utilise la même action avec `status=revoked`. Un participant absent ou inactif est refusé (`COORDINATOR_PARTICIPANT_INACTIVE`). `/owner` affiche la liste des coordinateurs actifs.

Le coordinateur peut ensuite utiliser `collab_list_executors` pour choisir un worker et `collab_dispatch_task` pour lui confier une mission bornée. Cette délégation ne donne **aucun** outil GitHub ni droit D12 au modèle : le worker reçoit seulement une tâche texte via `llm.generate`, sous les capacités, quota, budget gratuit et arrêt d’urgence existants. Les workers ne remplacent jamais les rôles auteur/reviewer/testeur authentifiés du protocole.

Les fiches exécutants utilisent le registre A3 et les invocations A1 : quota du jour, compte/succès/échecs et latences sur les 7 derniers jours. Kevin peut ajouter « Points forts » et « Points faibles » sur `/owner`; ces notes sont stockées séparément, tracées par `owner.decision`, et sont en lecture seule pour les coordinateurs.

Merges vers `main`/`master`, dérogations, promotion et production restent humains (I9). Aucune politique ne peut les automatiser.

## 7. Codes d’erreur

Les échecs typés sont déterministes (`retryable: false`). Seul `STORE_UNAVAILABLE` est `retryable: true`. « Lot » indique le lot qui émet le code ; L1 désigne le parser d’état `src/collab/state.ts`.

### 7.1 Identité, canal owner, transport

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `PARTICIPANT_MISMATCH` | C5 | `participant_id` différent de l’identité dérivée du jeton | Utiliser `caller.participant_id` |
| `UNREGISTERED_CLIENT` | C5 | Client non associé : seul `owner.request` est permis | Demander l’association (K6) |
| `DELEGATED_FORBIDDEN` | CC-5 L3c | Preuve déléguée utilisée hors d'un exécuteur owner autorisé | Soumettre une demande valide et obtenir mandat et approbation indépendants |
| `DELEGATED_MISMATCH` | CC-5 L3c | La preuve ne correspond pas au payload, à l'expiration ou au coût approuvés | Redéposer une demande exacte |
| `OWNER_DECISION_FORBIDDEN` | C1 | Un agent ne peut pas écrire `owner.decision` | Écrire un `owner.request` |
| `ALREADY_DECIDED` | C5 | Demande déjà tranchée, ou identifiant déjà tranché pour une autre demande (`seq`) | Aucune action ; l’agent redépose sous un nouvel identifiant |
| `UNKNOWN_REQUEST` | C5 | Aucune demande en attente avec cet identifiant | Vérifier `request_id` |
| `REQUEST_MISMATCH` | C5 | La demande `seq` du formulaire ne porte plus l’identifiant ou le cycle affichés : rien n’est décidé | Relire `/owner` |
| `AMBIGUOUS_REQUEST` | C5 | Décision sans `seq` alors que plusieurs demandes non tranchées portent ce `request_id` | Décider depuis `/owner`, qui envoie la `seq` |
| `INVALID_REQUEST_ID` | C5 | Identifiant de demande invalide | `[a-z0-9][a-z0-9_-]{0,63}` |
| `INVALID_DECISION` | C5 | Décision autre que `approve` ou `deny` | — |
| `INVALID_LABEL` | C5 | Libellé vide ou trop long | 1 à 80 caractères |
| `INVALID_CLIENT_ID` | C5 | Identifiant de client OAuth invalide | — |
| `UNKNOWN_CLIENT` | C5 | Aucun client OAuth authentifié sur `/collab/mcp` ou enregistré ne correspond au pseudonyme `unregistered:…` (ou pseudonyme ambigu) | Vérifier le pseudonyme ; le client doit d’abord appeler `/collab/mcp`, ou associer l’identifiant brut |
| `OWNER_PRECONDITION_FAILED` | C5/A2 | Condition de la décision non remplie (participant inactif, demande déjà tranchée, ou demande exécutable dont la précondition n’est plus vraie : acte du même type survenu depuis le dépôt) — rien n’est exécuté | Relire `/owner` ; l’agent redépose une demande à jour |
| `CYCLE_ALREADY_CLOSED` | CC-Owner V2 L2 | Le cycle est déjà clos (état terminal) : re-clôturer n’écrit rien | Aucune action |
| `CYCLE_CLOSE_PENDING_REQUESTS` | CC-Owner V2 L2 | Clôture douce refusée : N demande(s) d’agent encore en attente (compte affiché) | Trancher sur `/owner` (K-decide), ou forcer avec motif et confirmation |
| `CYCLE_CLOSE_ACTIVE_TASKS` | CC-Owner V2 L2 | Des tâches du cycle ne sont ni `done` ni `verified` : la clôture est interdite, même forcée | Terminer les tâches avant de clôturer |
| `CYCLE_CLOSE_FORCE_INVALID` | CC-Owner V2 L2 | Clôture forcée sans motif de 10 à 500 caractères, ou sans ressaisie exacte du `cycle_id` | Renseigner le motif et confirmer l’identifiant du cycle |
| `CYCLE_CLOSE_SYSTEM_INVALID` | CC-Owner V2 L2 | Cycle système (`owner-registry`, `memory-alarms`, `coordinator-tasks`) : la clôture ne s’applique qu’aux cycles de travail | — |
| `EXECUTABLE_REQUEST_INVALID` | A2 | Demande exécutable mal formée ou empreinte déclarée ≠ payload : non approuvable | La refuser ; l’agent redépose une demande valide |
| `REQUEST_EXPIRED` | A2 | Demande exécutable expirée (`expires_at` dépassé) : rien n’est exécuté | L’agent redépose une demande à jour |
| `AUTOMATION_HALTED` | A2 | Arrêt d’urgence posé sur `/owner` : aucune action automatique ne démarre, l’état est conservé | Attendre que Kevin reprenne l’automatisation |
| `BUDGET_INSUFFICIENT` | A2 | Réserve supérieure au reste de l’enveloppe (0 € par défaut) : rien n’est écrit | Rester sur un chemin gratuit, ou préparer une demande d’enveloppe pour Kevin |
| `BUDGET_OVERRUN` | A2 | Coût réel déclaré supérieur à la réserve au solde | Corriger la mesure ; réserver le pire cas avant l’appel |
| `INVALID_BUDGET_AMOUNT` | A2 | Montant non entier ou négatif (centimes) | Entier ≥ 0 |
| `INVALID_REASSIGNMENT` | CC-5 l3d | Paramètres de `reassign_task` invalides (champs inconnus, rôles en double, révision ou rôles actuels absents) | Redéposer une demande avec `cycle_id`, `task_id`, `owner_pid`, `reviewer_pid`, `tester_pid`, `expected_revision` et les rôles actuels `expected_owner_pid`, `expected_reviewer_pid`, `expected_tester_pid` |
| `INVALID_BUDGET_SCOPE` | A2 | Scope budgétaire invalide | `[a-z0-9][a-z0-9:_-]{0,127}` |
| `INVALID_RESERVATION_ID` | A2 | Identifiant de réservation invalide | 1 à 256 caractères `[A-Za-z0-9:._-]` |
| `UNKNOWN_RESERVATION` | A2 | Solde d’une réservation inconnue | Vérifier l’identifiant |
| `STORE_NOT_CONFIGURED` | C2 | `COLLAB_DB` non lié : store désactivé (fail-closed, HTTP 503) | Opération K3 |
| `STORE_UNAVAILABLE` | C6 | Store indisponible ou erreur non typée ; champ `fallback` | Lire via `github_collab_context`, aucune écriture GitHub de substitution, réessayer plus tard |

### 7.2 Journal, CAS et tâches

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `STALE` | C2 | `expected_rev` périmé (ou cycle trop actif pour une décision owner) | Rejouer `delta`, réessayer à `currentRevision` |
| `QUOTA_EXHAUSTED` | C2 | Quota quotidien atteint : aucune écriture | Attendre le jour suivant ou demander à Kevin |
| `UNKNOWN_EVENT_TYPE` | C1 | Type d’événement inconnu | Voir la liste en section 3 |
| `INVALID_CYCLE_ID` | C1 | Identifiant de cycle invalide | `[a-z0-9][a-z0-9_-]{0,63}` |
| `INVALID_PARTICIPANT_ID` | C1/C5 | Identifiant de participant invalide ou réservé (`owner`, `system`, `unregistered:*`) | — |
| `INVALID_EXPECTED_REV` | C1 | `expected_rev` négatif ou non entier | — |
| `INVALID_IDEMPOTENCY_KEY` | C1 | Clé d’idempotence dérivée invalide | Respecter le format d’`op_id` |
| `INVALID_OP_ID` | C1/F1/A0 | `op_id` hors format strict `{client}:{cycle}:{op}:{n}` (exactement quatre segments, aucun `:` interne), segment cycle ≠ cycle visé, ou segment client ≠ forme canonique du participant serveur (`:` → `.`, sans exemption) | Corriger le segment cycle ou client ; le rejeu du même `op_id` reste `duplicate` |
| `INVALID_EVENT_FIELD` | C1 | Champ obligatoire vide | — |
| `EVENT_FIELD_TOO_LONG` | C1 | Champ trop long (`payload_json` ≤ 64 Kio) | — |
| `INVALID_PAYLOAD_JSON` | C1 | `payload_json` n’est pas du JSON | — |
| `DUPLICATE_IDEMPOTENCY_KEY` | C1 | Même clé deux fois dans un lot | — |
| `INVALID_REVISION` | C1/L1 | Révision non entière ou inférieure à 1 | — |
| `INVALID_TASK_PAYLOAD` | C2 | `payload_json.task` absent ou invalide | Voir section 3 |
| `INVALID_TASK_ID` | C1/C2 | Identifiant de tâche invalide | `[a-z0-9][a-z0-9_-]{0,63}` |
| `INVALID_TASK_PARTICIPANT` | C1 | Rôle de tâche sans identifiant serveur | — |
| `INVALID_TASK_STATUS` | C2/L1 | Statut hors `proposed`, `accepted`, `in_progress`, `review`, `verified`, `done`, `blocked` | — |
| `DUPLICATE_TASK_ROLE` | C1/C2 | D12 : auteur, reviewer et testeur doivent être distincts | Changer d’attribution |
| `DUPLICATE_ROLE` | L1 | Rôle attribué deux fois | — |
| `TASK_UNKNOWN` | C2/L2 | Tâche inconnue dans le cycle (événement tâche, ou `task` fourni à la résolution de contexte) | `task.claim` d’abord, ou corriger le `task` fourni |
| `TASK_CLOSED` | CC-5 l3d | `reassign_task` sur une tâche `done` ou `verified` | Rien à réattribuer ; rouvrir la tâche par import d’état si nécessaire |
| `TASK_FORBIDDEN` | F1 | Événement tâche émis hors des rôles autorisés (claim initial ≠ owner, réaffectation/handoff ≠ owner courant, status hors des trois rôles) | Voir la matrice en section 3 |
| `TASK_NOT_HELD` | L2 | `task` fourni : la tâche existe mais vous ne la tenez pas (ou pas le rôle demandé) — le message dit le rôle tenu | Sélectionner une tâche listée par `AMBIGUOUS_TASK`, ou retirer `task`/`role` |
| `CLARIFY_TO_INVALID` | L2 | `clarify.ask` : `to` présent mais mal formé (ni participant, ni rôle `owner`/`reviewer`/`tester` : chaîne de 1 à 128 caractères) | Corriger `to` ou l’omettre (question publique) |
| `CLARIFY_TO_REQUIRES_TASK` | L2 | `clarify.ask` : adressage par rôle (`owner`/`reviewer`/`tester`) sans `task` — le destinataire ne peut pas être résolu | Fournir la tâche dont on désigne le rôle |
| `CLARIFY_ANSWER_FORBIDDEN` | L2 | `clarify.answer` par un participant qui n’est ni l’auteur ni le destinataire de la question adressée : rien n’est écrit | Laisser l’auteur ou le destinataire répondre, ou poser une question publique |
| `UNREGISTERED_PARTICIPANT` | F1 | Rôle de tâche sans participant enregistré actif sur `/owner` (K6) | Enregistrer le participant |
| `IDEMPOTENCY_CONFLICT` | F1 | `op_id` rejoué avec une intention différente | Incrémenter le compteur `n` de l’op_id |
| `UNKNOWN_CYCLE` | C2 | Cycle inconnu | Vérifier l’identifiant |
| `CYCLE_CLOSED` | CC-Owner V2 L1/L2 | Cycle fermé par le propriétaire : la garde transactionnelle du batch refuse tout append d’agent (rejeu pré-clôture = `duplicate` ; écriture en vol : `STALE` puis `CYCLE_CLOSED`) et les actes owner cycle-scopés (`install_phases`, `import_state`, `appoint_cycle_coordinator`) ; `decide` reste possible | Lecture seule conservée ; décider sur `/owner` ; réouverture éventuelle = décision owner |
| `PROPOSAL_ALREADY_SUBMITTED` | A0 | Un second `proposal.submit` du même participant dans la même ronde de la phase (pré-check + clause CAS transactionnelle) | Une seule proposition par participant et par ronde ; rejeu du même `op_id` → `duplicate` |
| `INVALID_INVOCATION` | A1 | Contrat d’invocation, usage, bail ou source_revision invalide | Corriger l’intention ; `source_revision` doit être la révision créée par l’événement actionnable |
| `INVOCATION_PAYLOAD_CONFLICT` | A1 | Même `wake_key` mais payload/provenance différents | Relire l’invocation existante ; ne pas transformer le conflit en retry |
| `INVOCATION_INCONSISTENT` | A1 | Journal et registre invocation ne correspondent plus | Incident store : arrêter l’automatisation et diagnostiquer |
| `INVOCATION_UNKNOWN` | A1 | `wake_key` inconnu | Relire l’outbox avant de tenter un bail |
| `INVOCATION_LEASE_LOST` | A1 | Bail absent, expiré ou détenu par un autre worker | Relire l’état ; réconcilier avant toute nouvelle tentative |
| `INVOCATION_INPUT_MISMATCH` | A3 | Paquet fourni au dispatch différent de l’empreinte enregistrée | Fournir exactement le paquet de l’invocation |
| `ENDPOINT_PROBE_REQUIRED` | A3 | Activation sans sonde réussie récente pour cette attestation | Sonder l’endpoint sur `/owner`, puis redéposer l’activation |
| `ENDPOINT_PRINCIPAL_IMMUTABLE` | A3 | Tentative de rattacher un endpoint à un autre principal | Créer un autre `endpoint_id` |
| `ENDPOINT_ATTESTATION_TAKEN` | A3 | Attestation déjà portée par un autre endpoint du même principal | Réutiliser cet endpoint ou le retirer |
| `ENDPOINT_NOT_PROBEABLE` | A3 | Endpoint inconnu, retiré ou non `provider_adapter` | Vérifier la matrice des exécuteurs |
| `ENDPOINT_NOT_ACTIVE` | A3 | Dispatch vers un endpoint absent, non actif ou non `provider_adapter` | Activer l’endpoint (sonde + demande) |
| `ENDPOINT_PRINCIPAL_MISMATCH` | A3 | L’endpoint n’appartient pas au principal de l’invocation | Choisir l’endpoint de ce principal |
| `EXECUTOR_CAPABILITY_DENIED` | A3 | Capacité absente (`llm.generate`, fournisseur) ou plafond de jetons dépassé | Demander au propriétaire d’ajuster les capacités |
| `EXECUTOR_DAILY_CAP` | A3 | Plafond quotidien d’appels de l’endpoint atteint | Réessayer le lendemain |
| `EXECUTOR_UNSUPPORTED` | A3 | Fournisseur non pris en charge, ou modèle hors de la liste gratuite vérifiée (déprécié, non relevé) | Choisir un modèle de la liste (§6.3) |
| `EXECUTOR_NEURON_BUDGET` | A3 | La réserve du pire cas dépasserait le budget journalier de neurons | Réessayer après 00:00 UTC, ou réduire `max_tokens` / le paquet |
| `EXECUTOR_PAID_MODEL` | A3 | Modèle hors du chemin gratuit (notamment OpenRouter sans suffixe `:free`, ou modèle Workers AI payant) | Choisir un modèle gratuit autorisé |
| `EXECUTOR_UNAVAILABLE` | A3 | Binding Workers AI absent ou secret du fournisseur compatible OpenAI absent | Configurer le binding/secret sur le Worker, jamais via un agent |
| `EXECUTOR_UPSTREAM_HTTP` | A3c | Le fournisseur compatible OpenAI a répondu avec un statut HTTP non 2xx ; seul le statut est conservé | Vérifier le fournisseur puis laisser A1 reprendre la tentative |
| `EXECUTOR_TIMEOUT` | A3 | Fournisseur sans réponse dans le délai | Tentative en échec, reprise A1 |
| `EXECUTOR_BAD_RESPONSE` | A3 | Réponse du fournisseur sans texte exploitable (`content: null`, souvent `finish_reason=length` avec des jetons de raisonnement) | Tentative en échec ; lire `error_detail`, vérifier le modèle et le plafond de jetons |
| `EXECUTOR_INVALID_LIMIT` | A3 | `max_tokens` hors de 1 à 2048 | Corriger la limite |
| `EXECUTOR_INPUT_TOO_LARGE` | A3 | Paquet au-delà de 60 000 caractères | Réduire le paquet |
| `INVALID_OWNER_OP` | A3 | Inscription d’endpoint hors demande liée et sans `op` | Passer par une demande `register_endpoint` |
| `OWNER_TRIAL_INVALID_INSTRUCTION` | A4-mini | La consigne de Tâche d’essai ne fait pas partie de la liste fixée dans le serveur | Choisir `résumer` ou `relire (signaler les risques)` sur `/owner` |
| `OWNER_TRIAL_INVALID_DATA` | A4-mini | Données de Tâche d’essai vides ou supérieures à 4 000 caractères | Fournir 1 à 4 000 caractères |
| `COORDINATOR_REQUIRED` | A4 | Outil réservé à un participant enregistré avec grant coordinateur actif | Faire préparer puis approuver `grant_coordinator` sur `/owner` |
| `COORDINATOR_PARTICIPANT_INACTIVE` | A4 | `grant_coordinator` vise un participant absent ou non actif | Enregistrer/réactiver le participant avant la demande |
| `INVALID_COORDINATOR_STATUS` | A4 | Statut de grant autre que `active` ou `revoked` | Corriger le payload owner préparé |
| `TASK_KIND_INVALID` | A4 | `task_kind` hors `summarize`, `review_risks`, `propose_tests`, `draft` | Choisir une consigne serveur autorisée |
| `TASK_BRIEF_INVALID` | A4 | Brief vide ou supérieur à 2 000 caractères | Réduire la mission du coordinateur |
| `TASK_MATERIALS_TOO_LARGE` | A4 | Matériaux supérieurs à 60 000 caractères | Réduire ou découper les matériaux |
| `ENDPOINT_UNKNOWN` | A4 | Tentative d’ajouter des notes owner à un endpoint inexistant | Vérifier l’endpoint sur `/owner` |
| `EXECUTOR_NOTE_INVALID` | A4 | Note owner points forts/faibles supérieure à 1 000 caractères | Réduire la note |
| `DUPLICATE_LOGICAL_IDENTITY` | #126 | D12 : deux rôles différents désignent des ids appartenant à la même identité logique | Attribuer le rôle à un autre principal indépendant |
| `IDENTITY_FAMILY_INVALID` | #126 | `family_id` invalide, membres dupliqués, cardinalité autre que 0 ou 2–16, ou collision de namespace `family_id` ↔ `participant_id` | Corriger la demande ou choisir un autre identifiant |
| `IDENTITY_FAMILY_PARTICIPANT_INACTIVE` | #126 | Un membre de la famille n’est pas un participant actif | Enregistrer/réactiver le participant avant approbation |
| `IDENTITY_FAMILY_CONFLICT` | #126 | Un membre appartient déjà à une autre famille logique | Le retirer de l’ancienne famille par un acte owner distinct avant de le déplacer |
| `IDENTITY_FAMILY_D12_CONFLICT` | #126 | La famille rendrait au moins une tâche d’un cycle ouvert non conforme D12 en réunissant deux rôles sous une seule identité logique | Réattribuer les tâches citées puis redéposer/approuver la demande |

### 7.3 Phases, contexte et scellement (C3)

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `INVALID_AUTO_ADVANCE` | C1 | Politique `auto_advance` invalide | — |
| `INVALID_PHASE_CONDITIONS` | C1 | Conditions d’entrée ou de sortie invalides | — |
| `INVALID_PHASE_OUTPUT` | C1 | Sortie attendue invalide | — |
| `INVALID_PHASE_OUTPUTS` | C1 | Liste des sorties attendues invalide | — |
| `INVALID_PHASE_OUTPUT_TASK` | A0 | `task_id` d’une sortie attendue invalide | `[a-z0-9][a-z0-9_-]{0,63}` |
| `INVALID_CONTENT_HASH` | C1 | Empreinte de contenu scellé invalide | — |
| `INVALID_PROPOSAL_PAYLOAD` | C3 | `proposal.submit` en P1 sans `payload_json.content` | Fournir `content` |
| `INVALID_SEALED_ENVELOPE` | C3 | Enveloppe scellée illisible | Signaler (incident) |
| `SEALED_ITEM_UNKNOWN` | C3 | Proposition scellée inconnue | — |
| `PHASE_DEFINITION_MISSING` | C3 | Pas de définition pour la phase courante ou la phase visée | Demander à Kevin (K-phases) |
| `PHASE_ADVANCE_FORBIDDEN` | CR-A | L’appelant ne tient aucun rôle sur une tâche du cycle : il ne peut pas déclencher la policy de phase | Passer par un participant du cycle, ou `phase.request` |
| `INVALID_PHASE_DEFINITIONS` | CR-A | Définitions de phase refusées sur `/owner` : JSON illisible, phase en double, plus de 6 entrées, liste invalide ou `auto_advance` mal formé | Corriger la liste (K-phases) |
| `PHASE_OUTPUTS_INCOMPLETE` | C3 | Sorties attendues non produites par des participants distincts | Compléter |
| `PHASE_EXIT_CONDITIONS_UNMET` | C3 | Conditions de sortie non remplies | — |
| `POLICY_NOT_AUTHORIZED` | C3 | Politique d’avance non autorisée pour cette phase | `phase.request` |
| `CORRECTION_FORBIDDEN` | CC-5 l3d | `collab_request_correction` appelé par un participant qui ne tient pas le mandat actif du cycle | Passer par le coordinateur nommé |
| `CORRECTION_INVALID` | CC-5 l3d | Demande mal formée : tâche invalide, 0 ou plus de 10 points, point vide ou de plus de 300 caractères, raison trop longue, cycle fermé | Corriger l'entrée |
| `CORRECTION_PRECONDITION_FAILED` | CC-5 l3d | Mandat ou tâche changé entre les vérifications et le lot d'écriture : rien n'est écrit | Relire l'état et réessayer |
| `SOFT_PHASE_FORBIDDEN` | CC-5 l3d | `collab_phase_adjust` appelé par un participant qui ne tient pas le mandat actif du cycle | Passer par le coordinateur nommé, ou demander à Kevin |
| `SOFT_PHASE_INVALID` | CC-5 l3d | Réorganisation mal formée : op inconnue, justification hors 10–500 caractères, cible incohérente (reopen vers une phase non antérieure, rien après P6), cycle fermé | Corriger l'entrée |
| `SOFT_PHASE_LIMIT` | CC-5 l3d | 3 tours déjà atteints pour la phase visée, ou 10 réorganisations pour le cycle | Résumer le désaccord et demander l'arbitrage de Kevin |
| `SOFT_PHASE_PROTECTED` | CC-5 l3d | `phase.skip` de P5 (validation owner) ou d'une phase à conditions de sortie, ou définition de phase illisible (fail-closed) | Faire la phase, ou faire corriger la définition par Kevin |
| `SOFT_PHASE_SEALED` | CC-5 l3d | `phase.skip` d'un tour scellé (sortie `proposal.submit` attendue ou scellé non révélé) | Terminer le tour scellé |
| `SOFT_PHASE_PRECONDITION_FAILED` | CC-5 l3d | Mandat, budget, scellé ou définition de phase changé entre les vérifications et le lot d'écriture : rien n'est écrit | Relire l'état et réessayer |
| `NO_ACTIVE_CYCLE` | A0/L2 | Sans issue ni cycle : aucun cycle ouvert où le participant tient un rôle (y compris sur la tâche nommée par `task`, précisée dans le message) | Fournir `issue` ou `cycle` |
| `AMBIGUOUS_CYCLE` | A0 | Sans issue ni cycle : plusieurs cycles ouverts avec un rôle (liste dans le message) | Fournir `issue`, `cycle` ou filtrer par `task` |
| `UNKNOWN_ISSUE` | C3 | Aucun cycle pour cette issue | — |
| `AMBIGUOUS_ISSUE` | C3 | Même numéro d’issue dans plusieurs dépôts | Préciser `repository` ou `repo#n` |
| `INVALID_ISSUE_REF` | C3 | Référence d’issue illisible | — |
| `INVALID_ISSUE_REPOSITORY` | C3 | Dépôt requis pour indexer une issue | — |
| `AMBIGUOUS_TASK` | C3/L2 | Plusieurs tâches possibles (fail-closed) ; le message liste `task_id (participation)` et suggère la sélection | Préciser `task` |
| `PACKET_BUDGET_TOO_SMALL` | C3 | Le packet minimal dépasse le budget | Signaler |
| `INVALID_ATTESTATION_KIND` | A0 | Kind d’attestation hors `oauth_client`, `github_oidc`, `provider_adapter`, `chat_cimd` | Corriger le kind |
| `INVALID_CAPABILITY_SET` | A0 | Jeu de capacités invalide (liste vide, champ inconnu, plafond négatif) — deny-by-default | Corriger le capability_set |
| `INVALID_ENDPOINT_REGISTRATION` | A0 | Enregistrement d’endpoint invalide (ids, attestation_ref, statut) | Corriger l’enregistrement |
| `INVALID_SESSION_BINDING` | A0 | Liaison session/endpoint invalide | Corriger les ids |

### 7.4 Mémoire et registre de preuves (C1, C4)

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `INVALID_MEMORY_SCOPE` | C1 | Scope hors common, project, role:…, participant:…, task:… | — |
| `INVALID_MEMORY_PAYLOAD` | CR-B | `payload_json.memory` absent, JSON invalide ou champ mal typé pour un événement `memory.*` | Contrat mémoire en section 3 |
| `MEMORY_SCOPE_FORBIDDEN` | CR-B, X2 | `memory.propose`/`memory.consolidate`/`memory.retire` vise le scope privé `participant:<autre>`, ou `memory.review` par un tiers sur un scope participant | Écrire dans son propre scope ; auto-revue bornée pour le propriétaire ; délégation par `owner.request` |
| `INVALID_MEMORY_KIND` | C1 | Type de mémoire inconnu | — |
| `INVALID_MEMORY_TEXT` | C1 | Texte vide ou de plus de 600 caractères | — |
| `INVALID_MEMORY_CONFIDENCE` | C1 | Confiance hors hypothesis, observed, verified, owner_validated | — |
| `INVALID_MEMORY_STATUS` | C1 | Statut de mémoire inconnu | — |
| `INVALID_MEMORY_AUTHOR` | C1 | Auteur sans identifiant serveur | — |
| `INVALID_MEMORY_EVIDENCE` | C1 | Références de preuve invalides | — |
| `MEMORY_EVIDENCE_REQUIRED` | C1/C4 | Preuve requise hors candidat | — |
| `MEMORY_SELF_ACTIVATION` | C1, X2 | Le reviewer doit différer de l’auteur, hors auto-revue bornée du propriétaire (kinds `observation`/`open_question`/`lesson`/`procedure`, confiance `hypothesis`/`observed`) | Faire relire par un pair, ou vérifier kind/confiance de l’auto-revue |
| `INVALID_LEDGER_SUBJECT` | C1 | Sujet du registre invalide | — |
| `INVALID_LEDGER_PRODUCER` | C1 | Producteur du registre invalide | — |
| `INVALID_LEDGER_PAYLOAD` | C1 | Contenu du registre invalide | — |
| `LEDGER_SELF_WRITE` | C1 | Un participant ne peut pas écrire de preuve sur lui-même (I11) | — |
| `LEDGER_APPEND_FAILED` | C4 | Ajout au registre refusé | — |
| `MEMORY_NOT_FOUND` | C4 | Entrée inconnue | — |
| `MEMORY_NOT_CANDIDATE` | C4 | L’entrée n’est pas candidate | — |
| `MEMORY_NOT_ACTIVE` | C4 | L’entrée n’est pas active | — |
| `MEMORY_NO_ACTIVE` | C4 | Aucune version active à remplacer | — |
| `MEMORY_ACTIVE_EXISTS` | C4 | Une version active existe déjà | `supersede` |
| `MEMORY_HYPOTHESIS_EXPIRED` | C4, CR-F04 | Hypothèse échue : son cycle d’origine a atteint `expires_rev` (ou `expires_rev` déjà atteint à la proposition) | Re-proposer, ou consolider avant l’échéance |
| `MEMORY_SCOPE_MISMATCH` | CR-D | L’id mémoire est déjà enregistré sous un autre scope (toutes versions et statuts), ou sa lignée ancienne est multi-scope | Choisir un autre id ; lignée ancienne incohérente : `owner.request` |
| `MEMORY_P1_SHARED_MUTATION` | X5 | `memory.propose`/`memory.review`/`memory.consolidate` rendrait un nouveau contenu partagé visible au packet d’un cycle de travail ouvert en P1 — critère : définitions de phase installées (K-phases), ou l’empreinte P1 cycle#projet#tâche a changé au commit | Attendre la sortie de P1 du cycle, ou écrire dans un scope non visible au packet |
| `MEMORY_NOT_PROMOTABLE` | C4 | Promotion impossible | — |
| `MEMORY_BUDGET_EXCEEDED` | C4 | Budget du scope dépassé | Consolider ou retirer avant d’activer |
| `ACTIVATION_PAUSED` | C4 | Activations en pause après une alarme | Kevin approuve sur `/owner` la demande `mem-pause-…` déposée par l’alarme (cycle `memory-alarms`) : la pause est levée dans la transaction de la décision (CR-F02) |
| `MEMORY_PAUSE_NOT_CURRENT` | CR-F02 | Approbation d’une demande `mem-pause-…` qui ne désigne aucune pause en cours (autre scope, occurrence ancienne ou future, pause déjà levée) : rien n’est décidé | Trancher la demande de l’occurrence courante, ou refuser celle-ci |
| `INVARIANT_TOUCHED` | C4 | Alarme : invariant touché | — |
| `REFUTE_THRESHOLD` | C4 | Alarme : plus de 5 réfutations | — |
| `GROWTH_THRESHOLD` | C4 | Alarme : croissance nette au-dessus du seuil | — |
| `HYPOTHESIS_NOT_RULE` | C4 | Une hypothèse ne devient jamais une règle | — |
| `CONFIDENCE_DOWNGRADE` | C4 | Promotion de confiance vers le bas refusée | — |
| `PEER_REQUIRED` | C4 | Revue par un pair distinct requise | — |
| `PEER_EVIDENCE_REQUIRED` | C4, CR-F03 | Hausse de confiance (revue ou consolidation) : preuve d’un pair distinct requise, absente ou déjà utilisée par une version quelconque de la lignée de l’id (recyclage) | Fournir un `peer_evidence_ref` jamais utilisé par la lignée |
| `PROTECTED_KIND_OWNER_REQUIRED` | C4 | Type protégé : décision owner requise | `owner.request` |
| `OWNER_DECISION_INVALID` | C4 | Décision owner absente ou non approuvée | — |
| `SCOPE_NOT_PERSONAL` | C4 | Promotion depuis un scope non personnel | — |
| `SCOPE_TARGET_INVALID` | C4 | Scope cible de promotion invalide | — |
| `OWNER_DECISION_SUBJECT` | C4 | La décision owner vise un autre sujet ou une autre occurrence (version, scope, pause) | Demander une décision pour l’occurrence exacte |
| `ACTIVATION_RACE` | C4 | Activation concurrente : le candidat a changé entre-temps, la transaction d’activation est annulée intégralement (A03) | Relire puis réessayer |
| `PEER_EVIDENCE_NOT_FOUND` | C4 | Preuve de pair absente du registre | Ajouter la preuve au registre |
| `PEER_EVIDENCE_PRODUCER` | C4 | Le producteur de la preuve n’est pas le relecteur | Preuve produite par le relecteur |
| `PEER_EVIDENCE_SELF` | C4 | La preuve vient de l’auteur de la mémoire | Preuve d’un pair distinct |
| `INVALID_CONSOLIDATION_BINDING` | L5 | Liaison de résumé de consolidation invalide (evidence_ref D3 : `source_seq_from`/`source_seq_to`, `version`, `review_at` entiers sûrs, `source_hash` sha256 64) | Corriger la liaison via `consolidationBinding` ; en lecture, `parseConsolidationBinding` rend `null` |

### 7.5 État CC-STATE-1 : import et export (C6, L1)

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `NO_STATE_SNAPSHOT` | C6 | Aucun état importé pour ce cycle | K-import |
| `EXPORT_INVALID` | C6 | L’export serait refusé par le parser L1 : rien n’est rendu | Signaler (incident) |
| `STATE_SNAPSHOT_CORRUPT` | C6 | Import enregistré illisible ou empreinte incohérente | Réimporter l’état fusionné |
| `STATE_REQUIRED` | C6 | Contenu d’import vide | — |
| `STATE_TOO_LARGE` | C6 | Fichier d’état de plus de 256 Kio | — |
| `IMPORT_UNKNOWN_PARTICIPANT` | C6 | Libellé de tâche sans participant enregistré | Enregistrer le participant (K6) |
| `IMPORT_AMBIGUOUS_LABEL` | C6 | Libellé porté par plusieurs participants actifs, ou par un participant et le propriétaire | Rendre les libellés uniques sur `/owner` |
| `IMPORT_DUPLICATE_ROLE` | C6/#126 | D12 : deux rôles présents d’une tâche désignent le même participant ou deux ids de la même identité logique (`none` reste permis) | Corriger l’attribution dans l’état |
| `IMPORT_INVALID_TASK` | C6 | Identifiant de tâche non importable | Corriger l’état |
| `IMPORT_TOO_MANY_TASKS` | C6 | Plus de 200 tâches | — |
| `INVALID_EXPORT_TARGET` | C6 | Cible d’export invalide (dépôt `owner/repo`, chemin relatif) | — |
| `UNSUPPORTED_SCHEMA` | L1 | Pas de `schema_version: CC-STATE-1` | — |
| `MISSING_CONTROL_KEY` | L1 | Clé de contrôle obligatoire absente | — |
| `DUPLICATE_CONTROL_KEY` | L1 | Clé de contrôle répétée | — |
| `INVALID_REVISION_ORDER` | L1 | `base_revision` doit être inférieure à `revision` | — |
| `INVALID_PHASE` | L1 | Phase hors P1 à P6 | — |
| `INVALID_SHA` | L1 | `based_on_sha` n’est pas un SHA Git | — |
| `MISSING_SECTION` | L1 | Section « Owner decisions » absente | — |
| `INVALID_SECTION` | L1 | Titre de section vide | — |
| `DUPLICATE_SECTION` | L1 | Section répétée | — |
| `MISSING_TABLE` | L1 | Tableau Roles ou Tasks absent | — |
| `INVALID_TABLE` | L1 | En-tête de tableau vide | — |
| `RAGGED_TABLE` | L1 | Ligne de tableau de mauvaise largeur | Vérifier les retours à la ligne |
| `TABLE_TRUNCATED` | L1 | Tableau tronqué ou mal séparé | — |
| `INVALID_ROLE_ROW` | L1 | Cellule vide dans Roles | — |
| `INVALID_TASK_ROW` | L1 | Cellule vide dans Tasks | `none` plutôt qu’une cellule vide |
| `DUPLICATE_ACTOR` | L1 | Acteur présent deux fois dans Roles | — |
| `DUPLICATE_TASK_ID` | L1 | Tâche présente deux fois | — |
| `STALE_REVISION` | L1 | Une décision owner plus récente existe | Relire l’état |
| `STALE_SHA` | L1 | Le head observé diffère de `based_on_sha` | Relire l’état |

## 8. Dépannage

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `collab_*` absents du catalogue | Connecteur consenti sans `collab:`, ou connecteur pointant sur `/mcp` | Recréer le connecteur sur `/collab/mcp`, nouvelle conversation |
| HTTP 401/403 avec `insufficient_scope` | Jeton sans `collab:` | Reconsentir avec `collab:` |
| HTTP 403 « Origine MCP refusée » | En-tête Origin non autorisé pour ce client | Utiliser le client enregistré |
| HTTP 503 « Métadonnées du client indisponibles » | Métadonnées OAuth du client momentanément illisibles | Réessayer après `Retry-After` |
| HTTP 503 `STORE_UNAVAILABLE` | `COLLAB_DB` absent ou en panne | Section 5 |
| `/owner` répond 404 | Canal owner non configuré (fail-closed) | K4 |
| `/owner` répond 403 | Preuve absente ou fausse, ou formulaire d’une autre origine | Ressaisir le secret sur la page elle-même |
| `STALE` en boucle | Cycle très actif | Rejouer le delta reçu avant chaque nouvel essai, sans boucle aveugle |
| L’export n’a pas changé après une action | L’action n’est pas exportée (proposition, objection, checkpoint) ou concerne un autre cycle | Voir section 4 |
| `IMPORT_UNKNOWN_PARTICIPANT` | Libellé de l’état différent du libellé enregistré | Aligner le libellé sur `/owner` |

## 9. Gouvernance de la mémoire (plan §4)

| Élément | Règle |
| --- | --- |
| Scopes | common · project · role:\<r\> · participant:\<id\> · task:\<t\> (éphémère) |
| Types | fact · lesson · procedure · decision · invariant · observation · open_question |
| Confiance | hypothesis → observed → verified → owner_validated ; monter — par revue (`promoteConfidence`) ou par consolidation — exige une preuve NOUVELLE du registre `evidence_ledger` produite par un pair distinct de l’auteur, jamais réutilisée par une version quelconque de la lignée de l’id (CR-F03) |
| Cycle de vie | candidate → active (reviewer logiquement distinct de l’auteur, ou auto-revue bornée d’un membre de la même identité logique X2) → superseded/retired (pierre tombale, jamais d’effacement) |
| Protégés | invariant, autorité, sécurité : changement uniquement par décision owner |
| Budgets (tokens) | common ≤ 1500 · project ≤ 2000 · role ≤ 1500 · participant ≤ 500 · questions ouvertes ≤ 300 par packet (`clarify.ask` sans réponse, L2 ; questions du journal retenues jamais écartées par le trim global : refs, questions de l’appelant puis mémoire cèdent, sinon `PACKET_BUDGET_TOO_SMALL`) |
| Dépassement | consolider ou retirer avant toute nouvelle activation |
| Plafonds courts | par cycle et scope : ≤ 10 activations et ≤ 10 retraits sans revue de consolidation |
| Activation atomique | une seule transaction : garde CAS (candidat toujours candidate), réservation de plafond, budget, baseline et alarme de croissance, pause des kinds protégés — tout est appliqué ou rien ; un seul reviewer enregistré et un seul incrément de compteur par activation réellement appliquée (A03) ; toute autre version active du même id est supersédée dans la même transaction (I4 : exactement une version active, même en activation parallèle — pré-test Claude, F3) ; la garde de budget somme le coût exact persisté à l’insertion (`token_cost`, migration 0003), même mesure que `estimateTokens` (unités UTF-16, texte hors BMP compris — review Sol, F3) ; les lignes antérieures à la migration sont rattrapées par un backfill JS exact et idempotent rejoué à chaque amorçage à froid (un crash entre l’ALTER et le backfill est réparé au démarrage suivant) |
| Journal public (CR-B) | `memory.propose`/`memory.review`/`memory.consolidate`/`memory.retire` via `collab_append_event` appliquent leurs effets `memory_entries` dans la même transaction que l’append : un `applied` renvoie son effet (champ `memory`), un refus n’écrit rien du tout (ni journal, ni mémoire) |
| Administration des scopes (CRB-R1, X2, #126) | `participant:<id>` est privé à l’identité logique : le propriétaire historique **ou un alias owner-approved de la même famille** peut proposer, relire, consolider, retirer et lire ce scope ; un tiers reçoit `MEMORY_SCOPE_FORBIDDEN`. L’auto-revue bornée (observation/open_question/lesson/procedure, hypothesis/observed) accepte un alias de la même identité mais reste une auto-revue logique ; sur un scope partagé, deux aliases de la même famille ne sont jamais des pairs distincts. |
| Indépendance P1 (X5) | pendant P1 d’un cycle de travail ouvert (non système, définitions de phase installées — K-phases ; un cycle errant né d’un append sans définitions ne compte pas), propose/review/consolidate d’un scope partagé visible à son packet → `MEMORY_P1_SHARED_MUTATION` (refus pré-batch + garde transactionnelle d’empreinte cycle#projet#tâche, permutations comprises) ; permis : `participant:*`, retire, actives existantes, rejeu duplicate ; cycles système `memory-alarms`/`owner-registry` exclus ; limites : promoteScope/retire non gardés, mutations concurrentes project/status non couvertes |
| Curiosités | observation/open_question au niveau hypothesis, jamais une règle ; expirent quand leur cycle d’origine atteint `expires_rev` (révision de l’append + 3 par défaut), sans comparaison à un autre cycle ; une consolidation restée hypothesis renouvelle la fenêtre depuis le cycle qui consolide (CR-F04) |
| Mémoire personnelle vs registre | le scope participant porte stratégies et préférences ; les faits *sur* un participant (résultats, incidents, évaluations, mesures) vivent seulement dans `evidence_ledger`, référencés par identifiant (I11). Pour une famille owner-approved, la lecture par sujet couvre les ids historiques équivalents et l’interdiction d’auto-écriture est évaluée sur l’identité logique. |
| Promotion | participant → role/project/common par revue d’un pair ; la copie promue reçoit un **nouvel id** dans le scope cible, lignée tracée par `supersedes` (CR-D) ; une seule promotion par version source, même en course (l’approbation owner ne sert qu’une fois) |
| Alarme | invariant touché, plus de 5 réfutations ou croissance nette au-dessus du seuil → activations en pause dans ce scope et nouvelle occurrence ; dans la même transaction, une `owner.request` système (participant réservé `system`, cycle `memory-alarms`) porte l’identifiant exact `mem-pause-<sha256(scope)[0:20]>-<occurrence>`, le scope, l’occurrence et la cause (CR-F02) |
| Reprise (CR-F02) | Kevin approuve cette demande sur `/owner` : la pause est levée **dans la transaction de la décision**, et la base de croissance devient la taille active approuvée (sinon chaque activation suivante rouvrirait l’alarme). L’identifiant est recalculé côté serveur à partir des pauses en cours, jamais lu dans la demande. Une approbation d’une autre occurrence ou d’un autre scope est refusée (`MEMORY_PAUSE_NOT_CURRENT`, rien n’est écrit) ; une approbation déjà utilisée n’est jamais réutilisable (une décision par identifiant, nouvel identifiant à chaque occurrence) ; un refus maintient la pause. La demande ne contient ni texte ni preuve de mémoire ; le nom du scope (éventuellement `participant:<id>`) y figure pour que Kevin sache quoi reprendre |
| Export | `collab_export` en `memory-md` : scopes partagés + tous les scopes `participant:<id>` appartenant à l’identité logique de l’appelant |

État d’implémentation : schéma et contrats (C1) et cycle de vie C4 avec registre, budgets et alarmes (github-mcp#67) sont fusionnés ; le raccordement public du lifecycle au journal `collab_append_event` (CR-B/CR-02 : un `applied` porte toujours son effet mémoire, un refus n’écrit rien du tout, administration des scopes participant CRB-R1 comprise) est fusionné (PR #87).

## 10. Limites connues

- L’export reprend `next_action`, Roles et la prose de la base importée. Seules les données gérées par le store sont superposées. Un changement de prose passe par la PR de l’export.
- `based_on_sha` reste celui de la base importée ; il est mis à jour à la fusion par celui qui prépare la PR.
- L’import remplace les tâches matérialisées du cycle. Importez toujours l’état fusionné le plus récent, qui contient les exports précédents.
- Le contenu de l’état importé figure dans l’événement `import_state`, donc dans `collab_get_delta` du cycle : c’est le fichier fusionné dans GitHub, pas une donnée privée.
- Masquage CR-C : l’`id` d’une mémoire privée (choisi par l’auteur) et sa `version` restent visibles, car la revue par un pair distinct en a besoin. N’y mettez aucune donnée sensible. Le texte et les preuves d’une mémoire privée ne sont donc pas lisibles par son reviewer via le journal : la revue d’une mémoire privée par un pair (point X2) reste un arbitrage owner. Les scopes partagés (`common`, `project:`, `role:`, `task:`) ne sont pas masqués dans le journal ; la politique P1 des mémoires partagées (X5) reste un arbitrage owner.
- C3 et C4 (cycle de vie mémoire) sont fusionnés. Le raccordement du lifecycle au journal (`collab_append_event`, CR-B/CR-02 : les événements `memory.*` appliquent leurs effets dans la même transaction que l’append — un `applied` porte toujours son effet mémoire, un refus n’écrit rien du tout, CRB-R1 comprise) est fusionné (PR #87).
- La divergence de mesure du budget (`length()` SQL en points de code vs `estimateTokens` JS en unités UTF-16, texte hors BMP) est fermée : chaque ligne persiste son coût exact à l’insertion (`memory_entries.token_cost`, migration 0003) et la garde transactionnelle somme cette valeur ; les lignes antérieures à la migration sont rattrapées par un backfill JS exact et idempotent rejoué à chaque amorçage à froid : une interruption de la migration entre l’ALTER et le backfill est réparée au démarrage suivant, la même fonction canonique étant appliquée y compris hors BMP (review Sol, F3).
- Questions ouvertes (CC-5 L2) : sans adressage, lues depuis le journal du cycle et visibles de tous dans `packet.open_questions` — ne posez pas de question confidentielle dans `clarify.ask`. Une question adressée (`to`) n’apparaît dans le paquet qu’à son auteur et à son destinataire, mais l’événement reste lisible dans le journal (`collab_get_delta`) : le filtrage vise le paquet (bruit et coût), pas la confidentialité. 50 questions visibles au plus par seq croissant (filtrage d’adressage avant limite) ; une question du journal retenue dans la limite dédiée survit au trim global : refs, questions de l’appelant puis mémoire cèdent, sinon `PACKET_BUDGET_TOO_SMALL` (refus explicite) ; une réponse orpheline ne ferme rien ; sans `to`, pas de garde serveur sur `ask_seq` (choix assumé, le demandeur relit le delta).

### Codes d'erreur du gate CC-5 L4 (complément à la section 7)

Le gate L4 est désactivé par défaut. Codes : `L4_INVALID_TARGET`, `L4_TARGET_CHANGED`, `L4_CLOSURE_NOT_CONFIRMED`, `L4_MERGE_DISABLED`, `L4_GATE_DENIED`, `L4_CLAIM_DENIED`, `BASE_OR_HEAD_CHANGED`, `L4_INVALID_MERGE_SHA`, `L4_PRE_PATCH_DENIED`, `L4_REST_TARGET_INVALID`, `L4_INVALID_BASE`, `L4_TEMP_MISMATCH`, `L4_MERGE_RESULT_UNKNOWN`, `L4_INVALID_REF_SHA`, `L4_INVALID_HEAD`, `BASE_CHANGED`. Une réconciliation ne relance jamais une fusion.


### CC-5 L6 — code du pilote isolé

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `INVALID_PROBLEM_SIGNATURE` | CC-5 L6 | Signature d'échec vide ou trop longue pour produire le `problem_id` SHA-256 stable | Fournir une signature canonique non vide, de 4096 caractères au plus |

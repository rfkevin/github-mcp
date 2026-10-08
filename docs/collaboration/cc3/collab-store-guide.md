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
2. Créez un connecteur MCP sur `https://<worker>/collab/mcp` et consentez le scope `collab:`. Le catalogue est figé au consentement : après un changement de scopes, recréez le connecteur et ouvrez une nouvelle conversation.
3. Appelez `collab_get_context { cycle }`. Le champ `caller` donne votre `participant_id` et votre statut (`registered` ou `unregistered`).
4. Écrivez avec `collab_append_event`, avec `participant_id` égal à `caller.participant_id`.

Pour demander quelque chose au propriétaire (faire avancer une phase, enregistrer un client, fusionner), écrivez un `owner.request` avec `{ "request_id": "<id>", "summary": "<texte>" }`. Kevin le tranche sur `/owner`.

Choisissez un `request_id` **nouveau** pour chaque demande, unique dans tout le store. Un identifiant ne reçoit qu’une décision, attachée à la demande exacte que Kevin a lue, c’est-à-dire à son numéro d’événement `seq`. Une autre demande qui réutilise le même identifiant, dans le même cycle ou dans un autre, reste affichée sur `/owner` comme « déjà tranché ». Elle ne peut plus être décidée : redéposez-la sous un nouvel identifiant.

## 3. Outils de `/collab/mcp`

### `collab_get_context`
- **Entrée** : `cycle` ; `participant_id` optionnel (par défaut le vôtre).
- **Sortie** : phase, statut et révision du cycle, tâches où le participant est auteur, reviewer ou testeur, et `caller`.
- **Annotations** : lecture seule.
- **Erreurs** : `UNKNOWN_CYCLE`, `STORE_UNAVAILABLE`.
- **Services C3 (fusionnés, branchement de l’outil à venir)** : packet complet par rôle et résolution `issue → cycle → tâche` (`AMBIGUOUS_TASK`, `AMBIGUOUS_ISSUE`, `UNKNOWN_ISSUE`, `INVALID_ISSUE_REF`, `CONTEXT_TARGET_REQUIRED`, `PACKET_BUDGET_TOO_SMALL`). Les issues d’un cycle sont indexées par l’import d’état (section 4).

### `collab_get_delta`
- **Entrée** : `cycle`, `since_seq` (0 = depuis le début), `limit` (1 à 1000, 200 par défaut).
- **Sortie** : événements de séquence `> since_seq`, et `hasMore`.
- **Usage** : réutilisez la plus grande `seq` reçue comme curseur.
- **Annotations** : lecture seule.
- **Contenu scellé** : avec C3, le contenu des propositions P1 non révélées est masqué (`sealed_id` et `content_hash` seulement).

### `collab_append_event`
- **Entrée** : `cycle`, `expected_rev` (0 = création), `op_id` au format `{client}:{cycle}:{op}:{n}` (n numérique), `type`, `participant_id`, `payload_json`, et en option `session_id`, `role`, `evidence_ref`.
- **Types acceptés** : `task.claim`, `task.status`, `task.handoff`, `checkpoint`, `evidence.add`, `objection.open`, `objection.resolve`, `proposal.submit`, `phase.request`, `owner.request`, `memory.propose`, `memory.review`, `memory.consolidate`, `memory.retire`, `manual_op.log`. `owner.decision` est refusé (`OWNER_DECISION_FORBIDDEN`).
- **Tâches** :
  - `task.claim` attend `{ "task": { task_id, owner_pid, reviewer_pid, tester_pid, owned_paths[], next_action } }`. Les trois rôles doivent être distincts (D12, `DUPLICATE_TASK_ROLE`).
  - `task.status` attend `{ "task": { task_id, status } }`.
  - `task.handoff` attend `{ "task": { task_id, owner_pid?, next_action } }`.
- **Sortie** :
  - `applied`, avec la nouvelle révision et l’événement ;
  - `duplicate`, avec l’événement original ;
  - `STALE`, avec `currentRevision` et `delta` à rejouer avant de réessayer ;
  - `QUOTA_EXHAUSTED` quand le quota quotidien est atteint (5000 par défaut, `COLLAB_DAILY_WRITE_LIMIT`).

### `collab_export`
- **Entrée** : `cycle`, `format` (`cc-state-1` par défaut, ou `memory-md`).
- **`cc-state-1`** : l’état du cycle au format CC-STATE-1 (détaillé en section 4).
  - Sans changement depuis le dernier import : le fichier importé, octet pour octet.
  - Avec changements : la proposition de révision N+1 sur la base N.
  - La sortie donne `content`, `content_sha256`, `state` (`revision`, `base_revision`, `changed`, `changes`, `imported`, `store_revision`, `last_seq`) et `publish`, la consigne de publication.
- **`memory-md`** : entrées de mémoire actives des scopes partagés (common, project, role, task) et de **votre** scope participant seulement (format `CC-MEMORY-MD-1`). La mémoire personnelle d’un autre participant n’est jamais exportée.
- **Lecture seule** : l’outil n’écrit **jamais** dans GitHub.
- **Erreurs** : `NO_STATE_SNAPSHOT` (aucun état importé), `EXPORT_INVALID`, `STATE_SNAPSHOT_CORRUPT`, `STORE_UNAVAILABLE`.

### `collab_memory` (lot C4, à venir)
Cycle de vie de la mémoire : proposer, revoir, consolider, retirer. Voir la section 9. Tant que C4 n’est pas fusionné, cet outil n’existe pas dans le catalogue.

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
   - D12 est vérifiée à l’import : deux rôles présents d’une même tâche ne peuvent pas désigner le même participant (`IMPORT_DUPLICATE_ROLE`).
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
| K-fallback | Facultatif : définir `COLLAB_FALLBACK_STATE` sur l’environnement (non secret) | Avec K4 | facultatif |
| K-decide | Trancher les `owner.request` et `phase.request` sur `/owner` (approuver ou refuser). Chaque bouton vise la demande affichée (cycle et `seq`). Toutes les demandes non tranchées sont listées, des plus récentes aux plus anciennes, avec leur total et le bouton « Demandes plus anciennes ». Aucune n’est masquée, y compris celles qui sont non décidables (identifiant invalide ou déjà tranché) | En continu | — |
| K-rotate | Changer le secret owner au moindre soupçon d’exposition : l’ancien secret est refusé immédiatement | Au besoin | — |

Merges vers `main`/`master`, dérogations, promotion et production restent humains (I9). Aucune politique ne peut les automatiser.

## 7. Codes d’erreur

Les échecs typés sont déterministes (`retryable: false`). Seul `STORE_UNAVAILABLE` est `retryable: true`. « Lot » indique le lot qui émet le code ; L1 désigne le parser d’état `src/collab/state.ts`.

### 7.1 Identité, canal owner, transport

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `PARTICIPANT_MISMATCH` | C5 | `participant_id` différent de l’identité dérivée du jeton | Utiliser `caller.participant_id` |
| `UNREGISTERED_CLIENT` | C5 | Client non associé : seul `owner.request` est permis | Demander l’association (K6) |
| `OWNER_DECISION_FORBIDDEN` | C1 | Un agent ne peut pas écrire `owner.decision` | Écrire un `owner.request` |
| `ALREADY_DECIDED` | C5 | Demande déjà tranchée, ou identifiant déjà tranché pour une autre demande (`seq`) | Aucune action ; l’agent redépose sous un nouvel identifiant |
| `UNKNOWN_REQUEST` | C5 | Aucune demande en attente avec cet identifiant | Vérifier `request_id` |
| `REQUEST_MISMATCH` | C5 | La demande `seq` du formulaire ne porte plus l’identifiant ou le cycle affichés : rien n’est décidé | Relire `/owner` |
| `AMBIGUOUS_REQUEST` | C5 | Décision sans `seq` alors que plusieurs demandes non tranchées portent ce `request_id` | Décider depuis `/owner`, qui envoie la `seq` |
| `INVALID_REQUEST_ID` | C5 | Identifiant de demande invalide | `[a-z0-9][a-z0-9_-]{0,63}` |
| `INVALID_DECISION` | C5 | Décision autre que `approve` ou `deny` | — |
| `INVALID_LABEL` | C5 | Libellé vide ou trop long | 1 à 80 caractères |
| `INVALID_CLIENT_ID` | C5 | Identifiant de client OAuth invalide | — |
| `UNKNOWN_CLIENT` | C5 | Aucun client OAuth ne correspond au pseudonyme `unregistered:…` | Vérifier le pseudonyme dans la demande |
| `OWNER_PRECONDITION_FAILED` | C5 | Condition de la décision non remplie (participant inactif, demande déjà tranchée) | Relire `/owner` |
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
| `INVALID_OP_ID` | C1 | `op_id` hors format `{client}:{cycle}:{op}:{n}` | — |
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
| `TASK_UNKNOWN` | C2 | Tâche inconnue dans le cycle | `task.claim` d’abord |
| `UNKNOWN_CYCLE` | C2 | Cycle inconnu | Vérifier l’identifiant |

### 7.3 Phases, contexte et scellement (C3)

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `INVALID_AUTO_ADVANCE` | C1 | Politique `auto_advance` invalide | — |
| `INVALID_PHASE_CONDITIONS` | C1 | Conditions d’entrée ou de sortie invalides | — |
| `INVALID_PHASE_OUTPUT` | C1 | Sortie attendue invalide | — |
| `INVALID_PHASE_OUTPUTS` | C1 | Liste des sorties attendues invalide | — |
| `INVALID_CONTENT_HASH` | C1 | Empreinte de contenu scellé invalide | — |
| `INVALID_PROPOSAL_PAYLOAD` | C3 | `proposal.submit` en P1 sans `payload_json.content` | Fournir `content` |
| `INVALID_SEALED_ENVELOPE` | C3 | Enveloppe scellée illisible | Signaler (incident) |
| `SEALED_ITEM_UNKNOWN` | C3 | Proposition scellée inconnue | — |
| `PHASE_DEFINITION_MISSING` | C3 | Pas de définition pour la phase courante | Demander à Kevin |
| `PHASE_OUTPUTS_INCOMPLETE` | C3 | Sorties attendues non produites par des participants distincts | Compléter |
| `PHASE_EXIT_CONDITIONS_UNMET` | C3 | Conditions de sortie non remplies | — |
| `POLICY_NOT_AUTHORIZED` | C3 | Politique d’avance non autorisée pour cette phase | `phase.request` |
| `CONTEXT_TARGET_REQUIRED` | C3 | Ni issue ni cycle fourni | — |
| `UNKNOWN_ISSUE` | C3 | Aucun cycle pour cette issue | — |
| `AMBIGUOUS_ISSUE` | C3 | Même numéro d’issue dans plusieurs dépôts | Préciser `repository` ou `repo#n` |
| `INVALID_ISSUE_REF` | C3 | Référence d’issue illisible | — |
| `INVALID_ISSUE_REPOSITORY` | C3 | Dépôt requis pour indexer une issue | — |
| `AMBIGUOUS_TASK` | C3 | Plusieurs tâches possibles (fail-closed) | Préciser `task` |
| `PACKET_BUDGET_TOO_SMALL` | C3 | Le packet minimal dépasse le budget | Signaler |

### 7.4 Mémoire et registre de preuves (C1, C4)

| Code | Lot | Signification | Que faire |
| --- | --- | --- | --- |
| `INVALID_MEMORY_SCOPE` | C1 | Scope hors common, project, role:…, participant:…, task:… | — |
| `INVALID_MEMORY_KIND` | C1 | Type de mémoire inconnu | — |
| `INVALID_MEMORY_TEXT` | C1 | Texte vide ou de plus de 600 caractères | — |
| `INVALID_MEMORY_CONFIDENCE` | C1 | Confiance hors hypothesis, observed, verified, owner_validated | — |
| `INVALID_MEMORY_STATUS` | C1 | Statut de mémoire inconnu | — |
| `INVALID_MEMORY_AUTHOR` | C1 | Auteur sans identifiant serveur | — |
| `INVALID_MEMORY_EVIDENCE` | C1 | Références de preuve invalides | — |
| `MEMORY_EVIDENCE_REQUIRED` | C1/C4 | Preuve requise hors candidat | — |
| `MEMORY_SELF_ACTIVATION` | C1 | Le reviewer doit différer de l’auteur | — |
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
| `MEMORY_NOT_PROMOTABLE` | C4 | Promotion impossible | — |
| `MEMORY_BUDGET_EXCEEDED` | C4 | Budget du scope dépassé | Consolider ou retirer avant d’activer |
| `ACTIVATION_PAUSED` | C4 | Activations en pause après une alarme | Décision owner |
| `INVARIANT_TOUCHED` | C4 | Alarme : invariant touché | — |
| `REFUTE_THRESHOLD` | C4 | Alarme : plus de 5 réfutations | — |
| `GROWTH_THRESHOLD` | C4 | Alarme : croissance nette au-dessus du seuil | — |
| `HYPOTHESIS_NOT_RULE` | C4 | Une hypothèse ne devient jamais une règle | — |
| `CONFIDENCE_DOWNGRADE` | C4 | Promotion de confiance vers le bas refusée | — |
| `PEER_REQUIRED` | C4 | Revue par un pair distinct requise | — |
| `PEER_EVIDENCE_REQUIRED` | C4 | Preuve d’un pair distinct requise | — |
| `PROTECTED_KIND_OWNER_REQUIRED` | C4 | Type protégé : décision owner requise | `owner.request` |
| `OWNER_DECISION_INVALID` | C4 | Décision owner absente ou non approuvée | — |
| `SCOPE_NOT_PERSONAL` | C4 | Promotion depuis un scope non personnel | — |
| `SCOPE_TARGET_INVALID` | C4 | Scope cible de promotion invalide | — |
| `OWNER_DECISION_SUBJECT` | C4 | La décision owner vise un autre sujet ou une autre occurrence (version, scope, pause) | Demander une décision pour l’occurrence exacte |
| `ACTIVATION_RACE` | C4 | Activation concurrente : le candidat a changé entre-temps, la transaction d’activation est annulée intégralement (A03) | Relire puis réessayer |
| `PEER_EVIDENCE_NOT_FOUND` | C4 | Preuve de pair absente du registre | Ajouter la preuve au registre |
| `PEER_EVIDENCE_PRODUCER` | C4 | Le producteur de la preuve n’est pas le relecteur | Preuve produite par le relecteur |
| `PEER_EVIDENCE_SELF` | C4 | La preuve vient de l’auteur de la mémoire | Preuve d’un pair distinct |

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
| `IMPORT_DUPLICATE_ROLE` | C6 | D12 : deux rôles présents d’une tâche désignent le même participant (`none` reste permis) | Corriger l’attribution dans l’état |
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
| Confiance | hypothesis → observed → verified → owner_validated ; monter exige une nouvelle preuve d’un participant distinct |
| Cycle de vie | candidate → active (reviewer ≠ auteur) → superseded/retired (pierre tombale, jamais d’effacement) |
| Protégés | invariant, autorité, sécurité : changement uniquement par décision owner |
| Budgets (tokens) | common ≤ 1500 · project ≤ 2000 · role ≤ 1500 · participant ≤ 500 · questions ouvertes ≤ 300 par packet |
| Dépassement | consolider ou retirer avant toute nouvelle activation |
| Plafonds courts | par cycle et scope : ≤ 10 activations et ≤ 10 retraits sans revue de consolidation |
| Activation atomique | une seule transaction : garde CAS (candidat toujours candidate), réservation de plafond, budget, baseline et alarme de croissance, pause des kinds protégés — tout est appliqué ou rien ; un seul reviewer enregistré et un seul incrément de compteur par activation réellement appliquée (A03) ; toute autre version active du même id est supersédée dans la même transaction (I4 : exactement une version active, même en activation parallèle — pré-test Claude, F3) ; la garde de budget somme le coût exact persisté à l’insertion (`token_cost`, migration 0003), même mesure que `estimateTokens` (unités UTF-16, texte hors BMP compris — review Sol, F3) |
| Curiosités | observation/open_question au niveau hypothesis, jamais une règle ; expirent après 3 cycles sans nouvelle preuve |
| Mémoire personnelle vs registre | le scope participant porte stratégies et préférences ; les faits *sur* un participant (résultats, incidents, évaluations, mesures) vivent seulement dans `evidence_ledger`, référencés par identifiant (I11) |
| Promotion | participant → role/project/common par revue d’un pair |
| Alarme | invariant touché, plus de 5 réfutations ou croissance nette au-dessus du seuil → `owner.request` ; activations en pause dans ce scope |
| Export | `collab_export` en `memory-md` : scopes partagés + scope de l’appelant |

État d’implémentation : le schéma et les contrats (C1) sont fusionnés ; le cycle de vie, le registre, les budgets et les alarmes arrivent avec C4 (github-mcp#67).

## 10. Limites connues

- L’export reprend `next_action`, Roles et la prose de la base importée. Seules les données gérées par le store sont superposées. Un changement de prose passe par la PR de l’export.
- `based_on_sha` reste celui de la base importée ; il est mis à jour à la fusion par celui qui prépare la PR.
- L’import remplace les tâches matérialisées du cycle. Importez toujours l’état fusionné le plus récent, qui contient les exports précédents.
- Le contenu de l’état importé figure dans l’événement `import_state`, donc dans `collab_get_delta` du cycle : c’est le fichier fusionné dans GitHub, pas une donnée privée.
- C3 est fusionné. La branche C4 (cycle de vie mémoire) ne l’est pas encore : les codes de la section 7.4 sont documentés d’avance, à partir de son head `eb5f98a` (testé PASS le 2026-10-08).
- La divergence de mesure du budget (`length()` SQL en points de code vs `estimateTokens` JS en unités UTF-16, texte hors BMP) est fermée : chaque ligne persiste son coût exact à l’insertion (`memory_entries.token_cost`, migration 0003) et la garde transactionnelle somme cette valeur ; les lignes antérieures à la migration conservent l’approximation en points de code, sans effet sur les lignes écrites après (review Sol, F3).

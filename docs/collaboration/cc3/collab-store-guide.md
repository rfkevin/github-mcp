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
- **Entrée** : `cycle` (ou `issue` / `repository` / `task`) ; identité toujours dérivée du jeton serveur (jamais un `participant_id` client).
- **Sortie** : phase, statut et révision du cycle, tâches, `caller`, `resolved`, `packet` (rôle, mémoire I6, budget) et `delta` optionnel.
- **Mémoire (I6)** : le packet n’inclut que `common`, `participant:<caller>`, `role:<rôle courant>`, `task:<tâche courante>` et `project:<id>` (contrat C4 : `project:[A-Za-z0-9_-]{1,64}`) quand applicables. Les scopes `task:other` / `role:other` / `project:other` ne fuitent pas.
- **Annotations** : lecture seule.
- **Erreurs** : `UNKNOWN_CYCLE`, `STORE_UNAVAILABLE`, `CONTEXT_TARGET_REQUIRED`, `AMBIGUOUS_TASK`, `AMBIGUOUS_ISSUE`, `UNKNOWN_ISSUE`, `INVALID_ISSUE_REF`, `PACKET_BUDGET_TOO_SMALL`.
- **Services C3** : packet complet par rôle et résolution `issue → cycle → tâche`. Les issues d’un cycle sont indexées par l’import d’état (section 4).

### `collab_get_delta`
- **Entrée** : `cycle`, `since_seq` (0 = depuis le début), `limit` (1 à 1000, 200 par défaut).
- **Sortie** : événements de séquence `> since_seq`, et `hasMore`.
- **Usage** : réutilisez la plus grande `seq` reçue comme curseur.
- **Annotations** : lecture seule.
- **Contenu scellé** : avec C3, le contenu des propositions P1 non révélées est masqué (`sealed_id` et `content_hash` seulement).

### `collab_append_event`
- **Entrée** : `cycle`, `expected_rev` (0 = création), `op_id` au format `{client}:{cycle}:{op}:{n}` (n numérique), `type`, `participant_id`, `payload_json`, et en option `session_id`, `role`, `evidence_ref`. Le segment `{cycle}` de l’`op_id` doit désigner le cycle visé (`INVALID_OP_ID` sinon).
- **Types acceptés** : `task.claim`, `task.status`, `task.handoff`, `checkpoint`, `evidence.add`, `objection.open`, `objection.resolve`, `proposal.submit`, `phase.request`, `owner.request`, `memory.propose`, `memory.review`, `memory.consolidate`, `memory.retire`, `manual_op.log`. `owner.decision` est refusé (`OWNER_DECISION_FORBIDDEN`).
- **Tâches (permissions F1)** :
  - `task.claim` attend `{ "task": { task_id, owner_pid, reviewer_pid, tester_pid, owned_paths[], next_action } }`. Les trois rôles doivent être distincts (D12, `DUPLICATE_TASK_ROLE`) et enregistrés actifs (K6, `UNREGISTERED_PARTICIPANT`) ; la première affectation est faite par l’`owner_pid` lui-même, une réaffectation par l’owner courant uniquement (`TASK_FORBIDDEN`).
  - `task.status` attend `{ "task": { task_id, status } }`, émis par l’owner, le reviewer ou le testeur de la tâche (`TASK_FORBIDDEN`).
  - `task.handoff` attend `{ "task": { task_id, owner_pid?, next_action } }`, émis par l’owner courant ; le nouvel owner doit être enregistré actif (`UNREGISTERED_PARTICIPANT`).
- **Sortie** :
  - `applied`, avec la nouvelle révision et l’événement ;
  - `duplicate`, avec l’événement original ; — le rejeu doit porter la même requête octet par octet : l'ordre des clés JSON compte, une intention réordonnée donne `IDEMPOTENCY_CONFLICT` ;
  - `IDEMPOTENCY_CONFLICT` quand l’`op_id` rejoué porte une autre intention (type, auteur, contenu) : incrémentez le compteur `n` ;
  - `STALE`, avec `currentRevision` et `delta` à rejouer avant de réessayer ;
  - `QUOTA_EXHAUSTED` quand le quota quotidien est atteint (5000 par défaut, `COLLAB_DAILY_WRITE_LIMIT`).

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
- **Règle** : transition autorisée (P1→P2→P3→P4→P5→P6, plus un retour d’un cran), définition et conditions d’entrée de la cible, rejeu de la même intention détecté **avant** `STALE`.
- **Erreurs** : `PHASE_TRANSITION_FORBIDDEN`, `PHASE_ENTRY_CONDITIONS_UNMET`, `PHASE_DEFINITION_MISSING`, `POLICY_NOT_AUTHORIZED`, `PHASE_OUTPUTS_INCOMPLETE`, `PHASE_EXIT_CONDITIONS_UNMET`, `STALE`.

### `collab_memory` (lot C4, à venir)
Cycle de vie de la mémoire : proposer, revoir, consolider, retirer. Voir la section 9. Tant que C4 n’est pas fusionné, cet outil n’existe pas dans le catalogue.

## SEE FULL GUIDE ON e15bb4d + F5 patches in artifacts/collab-store-guide-f5-restore.md

PLACEHOLDER_PARTIAL — CI docs-coverage will fail until full body restored from artifacts or raw a9d6c81 + F5 section.

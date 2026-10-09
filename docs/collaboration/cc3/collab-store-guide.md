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

## 3. Outils de `/collab/mcp` (extrait F5)

### `collab_get_context`
- **Entrée** : `cycle` (ou `issue` / `repository` / `task`) ; identité serveur uniquement.
- **Mémoire (I6)** : `common`, `participant:<caller>`, `role:<rôle>`, `task:<tâche>`, `project:<id>` avec id C4 `project:[A-Za-z0-9_-]{1,64}` (pas de `/`).
- **Erreurs** : `UNKNOWN_CYCLE`, `STORE_UNAVAILABLE`, `CONTEXT_TARGET_REQUIRED`, `AMBIGUOUS_TASK`, `AMBIGUOUS_ISSUE`, `UNKNOWN_ISSUE`, `INVALID_ISSUE_REF`, `PACKET_BUDGET_TOO_SMALL`.

### `collab_phase_advance`
- **Entrée** : `cycle`, `expected_rev`, `next_phase` (`P1`–`P6`). **Pas de `policy_id` côté agent** : policy dérivée de `auto_advance` serveur (`none` → `POLICY_NOT_AUTHORIZED`).
- **Sortie** : `applied` ou `duplicate`, avec `revision` et `event_seq`.
- **Erreurs** : `PHASE_TRANSITION_FORBIDDEN`, `PHASE_ENTRY_CONDITIONS_UNMET`, `PHASE_DEFINITION_MISSING`, `POLICY_NOT_AUTHORIZED`, `PHASE_OUTPUTS_INCOMPLETE`, `PHASE_EXIT_CONDITIONS_UNMET`, `STALE`.

### `collab_append_event` / `collab_get_delta` / `collab_export`
Voir le guide complet sur `cc3-integration` (sections 3–10). `op_id` = `{client}:{cycle}:{op}:{n}` avec **n numérique**.

## 7. Codes d’erreur (rappel F5)

| Code | Lot | Signification |
| --- | --- | --- |
| `PHASE_TRANSITION_FORBIDDEN` | F5 | Transition hors matrice P1–P6 |
| `PHASE_ENTRY_CONDITIONS_UNMET` | F5 | Conditions d’entrée non remplies |
| `POLICY_NOT_AUTHORIZED` | C3 | Policy non autorisée / `auto_advance:none` |
| `INVALID_OP_ID` | C1 | `op_id` hors `{client}:{cycle}:{op}:{n}` |
| `INVALID_MEMORY_SCOPE` | C1 | Scope hors common / project:id / role:… / participant:… / task:… |
| `PACKET_BUDGET_TOO_SMALL` | C3 | Packet minimal hors budget |
| `NO_STATE_SNAPSHOT` | C6 | Aucun état importé |
| `STORE_UNAVAILABLE` | C6 | Store indisponible + fallback |

## 9. Gouvernance mémoire (C4 — contrat scopes)

Scopes valides : `common` · `project:<id>` (`[A-Za-z0-9_-]{1,64}`) · `role:<r>` · `participant:<id>` · `task:<t>`.

Le packet I6 n’expose que les scopes applicables au caller (pas de fuite `task:other` / `role:other` / `project:other`).

## 10. Note F5

Guide tronqué volontairement ici après incident PLACEHOLDER ; le corps C4/C6/L1 complet reste la référence sur `cc3-integration` (fichier Claude C6). Cette entrée corrige `collab_phase_advance` (sans `policy_id`) et documente I6 + format `op_id`.

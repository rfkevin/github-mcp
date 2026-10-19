# CC-5 L3 — Contrôleur déterministe (incrément 1)

Lot L3 du plan CC-PLAN-5 v0.4 : auteur Claude, relecteur ChatGPT GPT-6, testeur Grok.
Démarrage anticipé décidé par le coordinateur (store `cc5-auto2-infra` seq 293), fusion seulement après L1.

## Principe

Le contrôleur **décide, il n'exécute pas**. Il lit l'état du store, applique des règles fixes et journalise
« qui doit agir, sur quoi, pourquoi ». L'organisation (tour supplémentaire, réattribution) reste au
coordinateur IA ; le code garantit les invariants : HALT, D12 au head et à la base exacts, actes protégés.

| Module | Rôle |
|---|---|
| `src/collab-store/controller/rules.ts` | `nextActors(instantané)` : règles pures, déterministes, triées de façon stable |
| `src/collab-store/controller/facts.ts` | extraction défensive des soumissions et verdicts depuis les `evidence.add` |
| `src/collab-store/controller/snapshot.ts` | instantané lu en **un seul lot D1**, identités ramenées à leur famille (#126) |
| `src/collab-store/controller/journal.ts` | table interne `controller_decisions`, append-only (triggers), idempotente |
| `src/collab-store/controller/run.ts` | un passage : instantané → règles → journal ; modes `active`, `halted`, `degraded` |

## Règles (incrément 1)

| Situation d'une tâche | Décision | Règle |
|---|---|---|
| ouverte, aucune soumission de l'auteur | réveiller l'auteur (`implement`) | `no-submission` |
| soumission (PR + head + base) sans verdict | réveiller relecteur et testeur | `awaiting-review`, `awaiting-test` |
| verdict sur un ancien head | renouveler le verdict | `verdict-stale` |
| verdict sans head/base | redéposer avec les SHA | `verdict-without-sha` |
| verdict négatif au head courant | réveiller l'auteur (`address_feedback`) | `changes-requested` |
| deux verdicts positifs au même head/base | `merge_ready` pour Kevin (tant que L4 n'existe pas) | `two-positive-verdicts` |
| bloquée, toutes dépendances terminées | `unblock` pour le coordinateur | `dependencies-done` |
| phase avec policy et sorties satisfaites | `advance_phase` | `outputs-satisfied` |

Seuls l'auteur, le relecteur et le testeur de la tâche comptent ; un tiers ne débloque jamais une fusion.
Une soumission exige une PR citée (adresse `/pull/N` ou numéro `pr` entier positif) **et** les deux SHA ;
un payload illisible ne produit aucun fait.

## Journal de décision (A3a)

Chaque ligne porte cycle, révision lue, type, acteur visé, tâche, action, règle, objet (SHA ou phase),
raison, empreinte de l'instantané et date. La clé d'idempotence ne dépend que du contenu de la décision :
rejouer le même état n'écrit rien (pas de double réveil) ; un nouvel état (nouveau head, verdict renouvelé)
écrit une nouvelle ligne. `UPDATE` et `DELETE` sont refusés par trigger.

## Modes (A3c)

- `halted` : arrêt d'urgence posé → aucune décision, rien n'est journalisé.
- `degraded` : instantané ou journal indisponible, état importé illisible → aucune décision.
  Le fonctionnement manuel actuel (relais de Kevin, demandes owner) reste la voie normale, sans perte d'état.

## Hors incrément 1 (suite du lot)

- Déclenchement : Cron et webhook GitHub, puis exécution des décisions derrière les gates existantes
  (avance par policy, dispatch A1 des workers, ligne « à relayer » sur `/owner` pour les agents de chat).
- Phases souples B1 (`round.add`, `phase.reopen`, `phase.skip`, `correction.request`) et réattribution (C1, contrat A08).
- Expiration par révision des `clarify.ask` (X13, reprise de la revue L2).
- Mesure : décisions par passage, réveils manuels évités (W0).

## Choix d'exécution — instantané du 2026-10-19 (à revalider le jour de l'activation, X12)

| Option | Offre gratuite (source officielle) | Adéquation |
|---|---|---|
| Cron Trigger | 5 Cron par compte (Workers limits, page Cron MAJ 17/10/2026) ; 100 000 requêtes/jour | **retenu pour démarrer** : un passage toutes les N minutes, sans état propre, le store est la source de vérité |
| Durable Object | 100 000 requêtes/jour, 13 000 Go·s/jour (DO pricing MAJ 30/09/2026) | utile si un verrou par cycle devient nécessaire ; non requis tant que le journal est idempotent |
| Queues | disponible en Free, 10 000 opérations/jour, rétention 24 h (Queues pricing MAJ 21/04/2026) | pour la file des échecs et les réveils asynchrones (incrément suivant) |

Un passage = un lot de lecture + un lot d'écriture au plus : la charge reste très inférieure aux quotas pour
quatre agents. La mesure réelle (L0/W0) tranchera ; aucune dépense, aucun choix payant.

## Tests

`test/collab-store/controller/rules.spec.ts` (règles pures, extraction des faits) et
`test/collab-store/controller/run.spec.ts` (D1 : idempotence, parcours soumission → verdicts → `merge_ready`,
familles d'identité, HALT, mode dégradé, append-only).

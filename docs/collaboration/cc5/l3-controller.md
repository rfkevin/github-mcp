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
un payload illisible ne produit aucun fait. Les preuves sont lues sur **tout le cycle** : un réimport d'état
(CC-STATE-1) ne fait disparaître ni soumission ni verdict ; seule la règle D12 (head et base exacts) décide
de leur validité (revue R1).

## Journal de décision (A3a)

Chaque ligne porte cycle, révision lue, type, acteur visé, tâche, action, règle, objet (SHA ou phase),
raison, empreinte de l'instantané et date. La clé d'idempotence combine le contenu de la décision et son
**épisode** : révision de la ligne `tasks` (incrémentée à chaque claim, statut ou transfert), seq de la
soumission courante et du dernier verdict de chaque vérificateur. Rejouer le même état n'écrit rien (pas de
double réveil) ; une transition de la tâche ou un nouveau fait réarme la décision, même si elle revient à
l'identique (revue R3). Le rappel périodique d'une décision restée sans suite n'est pas couvert ici : il
viendra avec le déclenchement Cron. `UPDATE` et `DELETE` sont refusés par trigger.

## Modes (A3c)

- `halted` : arrêt d'urgence posé → aucune décision, rien n'est journalisé. HALT est relu **dans le lot
  d'écriture** (même transaction D1) et chaque insertion est conditionnée à son absence : un arrêt posé
  entre l'instantané et l'écriture n'écrit rien (revue R2).
- `degraded` : instantané ou journal indisponible, état importé illisible → aucune décision.
  Le fonctionnement manuel actuel (relais de Kevin, demandes owner) reste la voie normale, sans perte d'état.

## Incrément 2a (tâche l3d)

- **Questions ouvertes (X13, reprise de la revue L2)** : l'instantané lit les `clarify.ask` sans `clarify.answer` liée
  (2 000 événements clarify au plus par passage). Question adressée → `answer_question` pour le destinataire
  (participant nommé, ou titulaire du rôle sur la tâche, ramené à sa famille) ; question publique ou adressée à soi →
  aucun réveil. À partir de `QUESTION_TTL_REVISIONS` = 40 révisions du cycle, la question expire :
  `renew_or_close_question` pour son auteur, plus de réveil du destinataire. Le contrôleur ne ferme rien lui-même.
- **`collab_next_actions`** (outil MCP, lecture seule) : chaque agent obtient les décisions qui le visent, calculées sur
  l'état courant, sans relais de Kevin ; les décisions `coordinator` vont au seul titulaire du mandat actif (L3c).
  Rien n'est journalisé par cet outil.
- **Passage programmé** : `scheduled()` du Worker appelle `runScheduledControllers` (20 cycles ouverts au plus, un
  échec isolé par cycle). Inerte sauf `CONTROLLER_CRON_ENABLED="true"` **et** store monté. Environnement cc3-test :
  Cron `*/15 * * * *` déclaré, drapeau à `"false"` ; Kevin l'active quand il le souhaite.

## Incrément 2b-1 — rappels bornés et passage du chercheur

- **Rappels** (`journal.ts`) : une décision encore active au même épisode (même `decision_key`) reçoit une ligne
  `rule: 'reminder'` par tranche de `REMINDER_INTERVAL_S` (6 h) depuis sa première écriture, au plus `REMINDER_MAX` (3).
  Clé du rappel = sha256(clé ‖ `reminder` ‖ tranche) en `INSERT OR IGNORE` : une ligne par tranche, quel que soit le
  nombre de passages. Un saut d'horloge donne au plus un rappel (tranche plafonnée). Un nouvel épisode repart de zéro.
  Fencing HALT identique aux décisions : relu dans le même `db.batch`, INSERT conditionnés `WHERE NOT halt`.
  `runController` renvoie `reminded` à côté de `recorded`. Le rappel ne fait que journaliser : la relance effective
  (ligne « à relayer » sur `/owner`, dispatch) viendra en 2b-2.
- **Chercheur L5** (`scheduled.ts`) : après les cycles, `runResearchPass(db, { passId: 'rp-daily-AAAA-MM-JJ', now })`,
  passage global (sans cycle), au plus un par jour UTC grâce à l'idempotence par `passId` de L5 ; un passage `halted`
  n'est pas consommé (reprise le même jour après levée du HALT). Échec isolé : statut `failed`, les cycles ne sont pas
  affectés. Le résultat devient `{ cycles, research: { pass_id, status } }`. Remplace l'interface `runScheduledResearch`
  envisagée au plan de la vague 3 (seq 347) : L5 n'a rien à ajouter.
- Tests : `test/collab-store/controller/l3d-2b1.spec.ts` (8). Contre-épreuves faites : sans fencing, sans plafond,
  clé de rappel non déterministe, chercheur non isolé, `passId` aléatoire — chacune fait échouer au moins un test.

## Incrément 2b-2a — lignes « à relayer » sur /owner

- `controller/relay.ts` : `relayLines(db)` lit en **lecture seule** les décisions courantes du contrôleur
  (`previewNextActions`, `all`) pour au plus `RELAY_CYCLE_LIMIT` (20) cycles ouverts et rend au plus
  `RELAY_LINE_LIMIT` (50) messages prêts à copier : destinataire lisible (`participants.display_label`,
  « Kevin », titulaire du mandat L3c pour les décisions `coordinator`, « Kevin (poste de coordinateur vacant) »
  sinon), action, tâche, couple head/base abrégé, cycle et motif. « Depuis » = première écriture de la décision
  dans le journal (null tant que le passage programmé ne l'a pas journalisée).
- Rien n'est écrit ni exécuté (ni journal, ni révision) ; les décisions `policy:*` sont omises ; HALT ou cycle
  illisible → aucune ligne pour ce cycle ; une panne n'empêche jamais la page (`.catch(() => [])`).
- /owner : section « À relayer (n) » après les demandes en attente, sans formulaire ni script, valeurs échappées.
  **Chemins protégés touchés** : `src/collab-store/owner/{handler,page}.ts` (lecture et rendu seulement) → fusion
  par Kevin à la main.
- Tests : `test/collab-store/controller/l3d-2b2.spec.ts` (8). Contre-épreuves : sans échappement, aperçu remplacé
  par un passage qui écrit, cycles fermés inclus — chacune fait échouer au moins un test.

## Hors incrément 2b-2a (suite de l3d)

- Déclenchement par webhook GitHub, puis exécution des décisions derrière les gates existantes
  (avance par policy, dispatch A1 des workers).
- File des échecs (Queues, voir le comparatif ci-dessous).
- Phases souples B1 (`round.add`, `phase.reopen`, `phase.skip`, `correction.request`) et réattribution (C1, contrat A08).
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

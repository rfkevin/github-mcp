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
- Rien n'est écrit ni exécuté : aucune donnée insérée, modifiée ni supprimée. Frontière exacte (revue #174) : le
  chemin de lecture réutilise des fonctions qui appellent `ensureSchema` (amorçage idempotent `CREATE … IF NOT EXISTS`,
  en cache par isolat, déjà fait par le reste de /owner) ; schéma amorcé, `relayLines` n'émet **que des SELECT**
  (test sur toutes les requêtes préparées). Les décisions `policy:*` sont omises ; HALT ou cycle illisible → aucune
  ligne pour ce cycle ; une panne n'empêche jamais la page (`.catch(() => [])`).
- Mandat de coordinateur : table absente ou cycle sans mandat → « Kevin (poste de coordinateur vacant) » ; mandat
  **illisible** → les décisions `coordinator` du cycle sont omises (jamais attribuées à tort).
- /owner : section « À relayer (n) » après les demandes en attente, sans formulaire ni script, valeurs échappées.
  **Chemins protégés touchés** : `src/collab-store/owner/{handler,page}.ts` (lecture et rendu seulement) → fusion
  par Kevin à la main.
- Tests : `test/collab-store/controller/l3d-2b2.spec.ts` (13 : mandat présent, vacant et illisible ; seules des
  requêtes SELECT ; /owner identique hors section). Contre-épreuves : sans échappement, aperçu remplacé par un passage
  qui écrit, cycles fermés inclus, panne de mandat prise pour une vacance, écriture ajoutée, libellé coordinateur
  retiré — chacune fait échouer au moins un test.

## Incrément 2b-2b (premier volet) — file des échecs du passage programmé

- `controller/failures.ts` : table interne `controller_failures`, **append-only** (triggers), une ligne par
  (portée, code, heure UTC) grâce à une clé dérivée en `INSERT OR IGNORE` : la fréquence du Cron ne change pas la
  taille de la file (au plus 24 lignes par jour et par couple portée/code). Portée = identifiant du cycle, ou
  `research:l5` pour le chercheur. Code borné (`[A-Z0-9_]{1,64}`, sinon `UNKNOWN_ERROR`) : jamais de message brut.
- Écriture depuis `runScheduledControllers` pour chaque cycle en mode `degraded` et pour un passage du chercheur
  en échec ; HALT relu dans la requête d'écriture (`WHERE NOT halt`) ; **fail-soft** : une file indisponible
  n'interrompt pas le passage (`failures_recorded` = 0). Aucun nouvel essai automatique : le passage suivant
  réessaie de lui-même.
- Visibilité : `relayLines` place **en tête** de « À relayer » une ligne par (portée, code) des dernières 24 h,
  adressée à Kevin (« vérifier le passage programmé … : échec X sur n heures depuis 24 h, dernier à HH:MM UTC »).
  Lecture seule (SELECT uniquement, testé) ; file illisible → aucune ligne d'échec, le reste de la section reste.
- Choix : table D1 plutôt que Cloudflare Queues — aucun réveil asynchrone à porter tant que le contrôleur ne fait
  que journaliser ; Queues reste l'option pour l'exécution réelle des décisions.
- Aucun chemin protégé modifié (lecture de la constante `HALT_ACTIVE_SQL` seulement).
- Tests : `test/collab-store/controller/l3d-2b2b.spec.ts` (11). Contre-épreuves : garde HALT retirée, clé à la
  seconde au lieu de l'heure, file non isolée dans le passage, échecs placés en fin de liste, lecture des échecs
  non isolée — chacune fait échouer au moins un test.

## Incrément 2b-2c — réattribution d'une tâche (acte owner exécutable)

- `src/collab-store/owner/task-reassign.ts` (**chemin protégé owner**) : action exécutable `reassign_task`
  (`EXECUTABLE_ACTIONS`), même circuit que `install_phases` : un agent dépose la demande, Kevin l'approuve sur `/owner`.
- Garde dans le lot d'écriture : demande non tranchée et dernière réattribution de la tâche inchangée
  (`previous_seq`), CAS sur la tâche (révision attendue **et** rôles lus au dépôt, figés dans les paramètres
  `expected_owner_pid` / `expected_reviewer_pid` / `expected_tester_pid`, donc dans l'empreinte approuvée — revue
  GPT-6 #177 : un changement de rôles sans changement de révision suffit à refuser), tâche ouverte (ni `done` ni
  `verified` ; `blocked` reste réattribuable), trois participants
  actifs, trois identités logiques distinctes (familles #126). La tâche prend la révision du cycle : l'épisode change,
  les réveils sont réarmés pour les nouveaux titulaires (testé avec `previewNextActions`).
- Non délégable (preuve déléguée refusée) : la garde déléguée de `binding.ts` ne couvre que `install_phases` ; l'étendre
  est une révision du contrat l3c. La politique déclarative `delegation-policy.ts` refuse aussi
  (`owner_guard_not_delegable`), y compris en approbation imbriquée. Un acte de Kevin n'est pas bloqué par HALT (comme `import_state`).
- Tests : `test/collab-store/owner/task-reassign.spec.ts` (11), dont une course réelle (rôles changés entre les
  vérifications et le lot) et un changement de rôles entre dépôt et approbation à révision inchangée. Contre-épreuves : contrôle des rôles retiré de la garde, D12 logique retiré, révision non
  réalignée — chacune fait échouer au moins un test.

## Incrément 2c-1 — phases souples B1 (coordinateur)

Contrat : plan CC-5 v0.3 B1 (seq 260) et précisions v0.4 C1 (seq 264). L'IA décide quoi faire, le code vérifie et exécute.

- `src/collab-store/phases/soft.ts` (`adjustPhase`) et l'outil MCP `collab_phase_adjust`
  (`src/collab-store/mcp/controller-tools.ts`) : `round.add`, `phase.reopen`, `phase.skip`, réservés au titulaire du
  mandat L3c du cycle (famille #126 comprise), avec une justification journalisée.
- **Une seule frontière de ronde** : chaque opération s'écrit comme un `phase.advance` de rôle `coordinator`
  (`payload.op` typé). `phaseEntrySeq` (CR-F01), la garde « une proposition par ronde », le scellement par phase et
  l'export CC-STATE-1 la lisent déjà : une nouvelle ronde repart de zéro, et les scellés de la ronde quittée sont
  révélés, jamais rouverts.
- **Garde dans le lot** : mandat à l'époque lue, HALT, révision et phase du cycle, au plus 3 tours par phase et
  10 réorganisations par cycle (valeurs par défaut du plan ; au-delà, arbitrage de Kevin), scellé non révélé pour un saut,
  P5 refusé en SQL, et **définitions source et cible identiques à celles lues** (CAS, revue GPT-6 #178) : les protections
  du saut et les conditions d'entrée ne se contournent pas en modifiant une définition pendant l'opération. Définition
  illisible : refus (fail-closed). Rejeu : l'intention comprend op, raison, révision attendue et cible explicite.
- **Non contournable** : jamais de saut de P5, d'une phase à conditions de sortie ni d'un tour scellé ; conditions
  d'entrée de la cible respectées ; D12 inchangé (verdicts liés au couple head/base).
- `phases/gate.ts` : le rejeu d'une avance par policy ne reconnaît plus que les `phase.advance` de rôle `policy`.
  Sans cela, une réorganisation à la même révision et vers la même phase passait pour un `duplicate`.
- Hors chemins protégés : `owner/`, `identity/`, `store/` et `gates/` sont seulement lus (mandat, familles, HALT).
- Tests : `test/collab-store/phases/soft.spec.ts` (15, dont les courses sur le mandat et sur les définitions), plus le cas HALT (avant et pendant le lot) dans
  `test/collab-store/owner/automation-halt-budget.spec.ts`.

## Hors incrément 2c-1 (suite de l3d)

- Déclenchement par webhook GitHub, puis exécution des décisions derrière les gates existantes
  (avance par policy, dispatch A1 des workers).
- `correction.request` (demande de correction ciblée du coordinateur), incrément 2c-2.
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

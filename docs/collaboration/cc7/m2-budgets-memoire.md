# CC-7 M2 — budgets et portées de la mémoire

Décisions de Kevin du 2026-10-31 (synthèse P3 #1138 §4, amendement #1139, GO du lot à 16:28) ; avis
unanimes de Claude, GPT-6, Grok et Vibe, Gemini consultatif (#1124 à #1137).

## Budgets de jetons actifs par portée

| Portée | Avant | M2 | Rôle |
| --- | --- | --- | --- |
| `common` | 1500 | 1500 | leçons pour toute l'équipe |
| `project:<p>` | 2000 | 2000 | règles d'un dépôt ; projets externes à venir |
| `role:<r>` | 1500 | **800** | pièges transverses d'un rôle |
| `participant:<agent>` | 500 | **1500** | continuité d'un agent (chat ET API) ; seule mémoire durable d'un agent sans chat |
| `task:<t>` | 300 | **0, gelée** | remplacée par `active_work` (L12) pour la reprise |

Enveloppe totale 5 800 jetons : hypothèse de départ, à mesurer avec `collab_memory_inventory` avant toute
hausse. Les budgets sont des **plafonds**, pas des objectifs de remplissage : consolider et retirer
l'obsolète avant de remplir.

**Plancher participant** (`PARTICIPANT_BUDGET_FLOOR` = 1500) : il ne descend jamais sans décision de Kevin
notifiée au store. Un test fige le plancher.

## Portée `task` gelée

`memory.propose`, `memory.consolidate` et `memory.review` (activation d'une candidate antérieure) en
`task:<id>` sont refusés (`MEMORY_SCOPE_FROZEN`, rien n'est écrit : ni événement, ni version, ni quota,
ni révision). Les entrées actives existantes restent lisibles pour leur tâche et retirables
(`memory.retire`) : gel, pas suppression. Sans le refus de `consolidate`, l'ancienne active serait
supersédée par une candidate jamais activable (budget 0) — elle disparaîtrait (revue GPT-6 R2, #245). Une reprise de tâche passe par
`active_work` (points d'étape) ; une leçon durable va en `participant`, `role`, `project` ou `common`.

## Portée `role` : qui voit quoi

`role:<rôle>` n'est servi qu'à qui tient ce rôle :

| Rôle | Chat (paquet `collab_get_context`) | API (`store_memory`) |
| --- | --- | --- |
| `owner`, `reviewer`, `tester` | rôle tenu sur la tâche du paquet | type d'exécution : implement → owner, review → reviewer, test → tester |
| `coordinator` | détenteur du mandat de coordination du cycle | idem |
| `researcher` | — | exécutions `research` (tournante des chercheurs L11) |

Avant M2, le canal API ne recevait aucune mémoire de rôle : la parité chat/API est rétablie.

**Indépendance P1 (garde X5).** `coordinator` et `researcher` sont servis sans tâche : pendant qu'un
cycle de travail P1 est ouvert, toute écriture partagée (`propose`, `review` activant, `consolidate`) en
`role:coordinator` ou `role:researcher` est refusée (`MEMORY_P1_SHARED_MUTATION`), mandat présent ou non
(fail-closed, sans dépendance aux mandats ; l'empreinte P1 existante sert de garde transactionnelle).
`owner`, `reviewer` et `tester` restent bloqués seulement si un cycle P1 a au moins une tâche (inchangé).
Revue GPT-6 R1, #245.

## Consigne d'usage de `role`

Une entrée `role:<rôle>` est un piège **récurrent et transverse** de ce rôle, pas un fait d'une tâche :

- `reviewer` : « vérifier la base courante de la PR, pas seulement le head » ;
- `tester` : « relancer la suite au couple exact ; un arbre publié doit être identique à l'arbre testé » ;
- `owner` : « soumettre au store avant d'appeler à la revue » ;
- `coordinator` : « relayer une décision de Kevin sans la présenter comme une owner.decision » ;
- `researcher` : « relire la page officielle du jour, jamais un tarif de mémoire ».

Proposition par `memory.propose`, activation par `memory.review` d'une autre identité (inchangé).

## Retrait éventuel de `role`

Après deux cycles de mesure, et seulement sur critères combinés (aucune réutilisation pertinente constatée,
aucune entrée validée utile, transfert simulé vers `participant` ou `project` sans perte) ; décision de
Kevin.

## Retour arrière

Revert du lot : budgets d'avant, portée `task` rouverte, `role` servi comme avant. Aucune donnée migrée.

Tests : `test/collab-store/memory/cc7-m2-budgets.spec.ts`.

# CC-7 L5b (S10) — verdicts D12 contrôlés serveur : store_verdict

Lot L5b du cycle `cc7-api-auto` (suite de L5a, S9) : le canal API peut enfin
déposer un verdict D12 de relecture ou de test, UNIQUEMENT par un outil serveur
qui re-vérifie tout avant d'écrire. `evidence.add` libre reste interdit au
canal API (`API_AGENT_FORBIDDEN`, lot L3b) : l'événement de verdict est écrit
par le serveur, jamais repris depuis les arguments du modèle.

## Périmètre (S10)

- `store_verdict` (nouveau `src/collab-store/agentrun/verdict-tools.ts) :
  proposé aux seuls types `review` et `test`, seulement quand l'hôte est créé
  avec `verdicts: true` ET un dépôt ET des lectures GitHub (deny-by-default) ;
  dans le moteur, `assertNotD12Verdict` est court-circuité pour le seul
  `store_verdict` — toute autre écriture reste soumise au refus D12.
- Journal `agent_run_reads` (schema.ts) : chaque lecture GitHub réussie d'une
  exécution (`github_read_file`, `github_pull_request`, `github_check_runs`,
  `github_diff`) y est journalée (INSERT OR IGNORE, empreinte
  `(run_id, tool, ref_sha)`), append-only comme le reste (trigger no-delete).
- N1 : plafonds de jetons PAR type de tâche câblés au canal API.
- N2 : plafond de coût PAR type de tâche (`TASK_KIND_COST_CENTS`, tout à 0).

## Les sept contrôles serveur (un refus typé par contrôle)

| # | Contrôle | Code de refus |
| --- | --- | --- |
| ① | Type du run `review`/`test` seulement ; décision du vocabulaire du type (AGREE/CHANGES_REQUESTED, PASS/FAIL) | `VERDICT_KIND_FORBIDDEN` |
| ① | Rôle attendu : l'émetteur doit être le relecteur (resp. testeur) de la tâche, en identité logique | `VERDICT_ROLE_FORBIDDEN` |
| ② | Participant enregistré et actif (`participants.status`) | `UNREGISTERED_PARTICIPANT` |
| ③ | Tâche connue du cycle (`tasks`) | `TASK_UNKNOWN` |
| ④ | Identité logique de l'émetteur distincte de celle de l'auteur (D12, familles #126) | `SELF_REVIEW` |
| ⑤ | Couple exact relu sur GitHub : PR connue, ouverte, head et base identiques, pas fusionnée | `VERDICT_PR_UNKNOWN`, `VERDICT_COUPLE_MISMATCH` |
| ⑥ | CI du head entièrement verte (au moins un contrôle, tous `completed`/`success`) | `VERDICT_CI_NOT_GREEN` |
| ⑦ | Preuve de lecture `github_diff` au head par CETTE exécution (`agent_run_reads`) | `VERDICT_READ_PROOF_MISSING` |

Arguments bornés : `task` (identifiant de tâche), `pr` (entier), `head` et
`base` (SHA de 40 caractères), `state`, `review` (texte libre de 4000
caractères au plus). Arguments mal formés : `VERDICT_ARGS_INVALID`.

## Écriture serveur et idempotence

L'événement `evidence.add` (payload `{task, source: 'github', pr, head, base,
state, review}`) est écrit par `appendEvent` avec le rôle `reviewer` ou
`tester`, sous les gardes inchangées du store (rôles, cycle clos, quota, CAS ;
réessais bornés sur STALE, rien n'est écrit sur STALE). `op_id` déterministe
(`<client>:<cycle>:api-verdict-<empreinte32>:1`, empreinte du tuple type,
cycle, participant, tâche, couple, décision — le texte libre est exclu) :

- même verdict rejoué → `duplicate`, aucun second événement ;
- même tuple, autre texte libre → `IDEMPOTENCY_CONFLICT` (garde du store) ;
- autre décision → autre `op_id` : verdict distinct légitime.

`lookup` cherche l'événement par sa clé d'idempotence (contrat d'hôte 7a) :
l'effet reste réconciliable après une coupure, jamais rejoué à l'aveugle.

## N1 — plafonds de jetons par type de tâche

`TaskKind`/`TASK_KIND_BOUNDS`/`normalizeTaskKind` gagnent les kinds réels du
canal API : `planning` 4096/low, `status` 2048/off, `implement` 4096/low,
`research` 4096/low (les alias historiques du chemin gratuit restent).
`engineFor` passe `maxOutputTokensFor` aux cinq constructions de modèle ;
`effectiveMaxOutputTokens` borne chaque appel : review/test/answer/status
2048, planning/implement/research 4096. Les constructions directes (suites,
contrats L2) restent à `maxOutputTokens` tel quel.

## N2 — plafond de coût par type de tâche

`TASK_KIND_COST_CENTS` (plan.ts, registre figé) : answer, review, test,
implement → 0 cent. `planAgentRuns` le passe à `createRun`
(`maxCostCents`), vérifié par le moteur à chaque étape (`cost_limit`).
Tout à 0 = éteint fail-closed : aucun appel payant possible tant que Kevin ne
lève pas une valeur par type (P5).

## Tests

`test/collab-store/agentrun/cc7-l5b-store-verdict.spec.ts` : happy paths
review/test (payload exact, rôle, clé d'idempotence recalculable, preuve
journalée dans `agent_run_reads`), rejeu duplicate + `IDEMPOTENCY_CONFLICT`,
un refus par contrôle (kind de run, vocabulaire de la décision, rôle, participant
inactif, tâche inconnue, SELF_REVIEW, couple divergent, base déplacée, PR
fusionnée, PR inconnue, CI rouge/en cours/vide, preuve absente ou au mauvais
SHA), HALT (aucune écriture, modèle jamais appelé), `cost_limit` (N2), bornes
N1 et câblage `engineFor`, registre N2 et `planAgentRuns`.

## Hors périmètre

- `store_submit` (dépôt de soumission par l'auteur) : lot suivant.
- Bornes par participant en lignes écrites et Go-s : comptées au niveau du
  compte (`metered-db`), câblage orchestrateur hors L5b.
- Aucune variable wrangler nouvelle ; interrupteurs existants inchangés
  (`AGENT_RUNS_ENABLED`, `AGENT_RUN_PARTICIPANTS`, `AGENT_RUN_MODEL`…).

Fusion par le propriétaire uniquement.

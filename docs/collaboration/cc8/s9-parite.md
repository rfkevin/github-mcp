# CC-8 S9 — parité chat / API

Auteur : Grok. Reviewer : GPT-6. Testeur : Vibe.
Périmètre : ce document et `test/collab-store/parity/`. Aucun runtime engine/object/plan.

## Ce que ce lot prouve

Le **harnais** et le **registre de contrats**. `parityLive` et `s9Closed` restent `false` tant que Kevin n'autorise pas des sorties live des deux canaux (paid0).

## AC historiques (non affaiblis)

| Règle | Valeur |
|-------|--------|
| Kinds | answer, review, test, implement |
| MIN_PER_KIND | 3 taskId distincts / kind |
| PASS_THRESHOLD | ≥ 0,80 |
| Juge | BlindJudgePacket sans channel/author ; pas self_judge |
| Éliminatoires | merge, identity_leak, mandate (hors des 80 %) |

Entrées figées par paire : cycleId, taskId, kind, prompt, pieces, budget.

## Matrice E2E WorkSession (seq2183 / seq2190)

État : **NOT_RUN** = `it.fails` + `proven:false` (dette). **STRUCT** = assertion pure harnais. **GREEN** seulement avec fixture runtime réelle.

### Positifs (P*)

| ID | Kind | Invariant | État |
|----|------|-----------|------|
| P2-impl | implement | ≥5 steps, ≥2 outils autorisés, pas de filtre guided de phase | NOT_RUN |
| P2-rev | review | idem review | NOT_RUN |
| P5-wake | any | clarify.answer réveille la même WorkSession | NOT_RUN |
| P6-resume | implement | après failed steps≥5, continue sans 2e PR/commit ambigu | NOT_RUN |
| P7-verdict | review | dernière étape = store_verdict structuré | NOT_RUN |
| P8-handoff | implement | chat→API→chat même tâche/branche, 0 effet dupliqué | NOT_RUN |
| P9-taskless | answer | packet serveur sans inventer taskId | NOT_RUN |

### Négatifs (N*)

| ID | Invariant | État |
|----|-----------|------|
| N1-halt | HALT → 0 write | NOT_RUN |
| N2-path-grant | path hors grant∩owned_paths → refuse | NOT_RUN |
| N3-lease | 2e session active même clé → refuse | NOT_RUN |
| N4-ambiguous-effect | effect_outcome_unknown bloque write | NOT_RUN |
| N5-paid0 | paid>0 si plafond 0 → refuse | NOT_RUN |
| N6-private-c4 | mémoire privée tiers absente du packet | NOT_RUN |
| N7-injection | texte « merge » jugé éliminatoire (STRUCT juge ≠ garde outil) | STRUCT + NOT_RUN runtime |
| N8-stale-sha | expected_head périmé → refuse | NOT_RUN |
| N9-dup-pr | 2e open_pr même branche → 1 PR | NOT_RUN |

### Baseline API chronique (B*)

| ID | Fait mesuré | État |
|----|-------------|------|
| B-GEM-C2B2 | implement guided_stop ~5 steps, 0 commit | NOT_RUN |
| B-VIBE-REV | review 6/6 ~47k tokens sans store_verdict | NOT_RUN (U1 code ≠ preuve E2E) |
| B-ANS-CAP | answer 13797 > plafond 8000 | NOT_RUN (U1 preflight code ≠ preuve E2E) |

## Fichiers

- `test/collab-store/parity/s9-parity.spec.ts` — FrozenInput, juge, scorePair
- `test/collab-store/parity/s9-e2e-worksession.spec.ts` — registre + NOT_RUN par ID

## corr#1869 / suite

Préparation FrozenInput 12 tâches (3/kind) et harnais : ce PR. Parité live mesurée : lot ultérieur sous GO Kevin, paid0. Fusion Kevin uniquement.

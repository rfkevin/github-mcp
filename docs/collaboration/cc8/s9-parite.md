# CC-8 S9 — parité chat / API

Auteur : Grok. Reviewer : GPT-6. Testeur : Vibe.
Périmètre : ce document et `test/collab-store/parity/`. Aucun runtime engine/object/plan.

## Ce que ce lot prouve

Le **harnais**, le **registre de contrats** et le **manifeste FrozenInput PREPARED** (12 tâches).
`parityLive` et `s9Closed` restent `false` tant que Kevin n'autorise pas des sorties live des deux canaux (paid0).

## AC historiques (non affaiblis)

| Règle | Valeur |
|-------|--------|
| Kinds | answer, review, test, implement |
| MIN_PER_KIND | 3 taskId distincts / kind |
| PASS_THRESHOLD | ≥ 0,80 |
| Juge | BlindJudgePacket sans channel/author ; pas self_judge |
| Éliminatoires | merge, identity_leak, mandate (hors des 80 %) |
| Budget manifeste | 800 sur chaque entrée (égal chat/API) |

## Manifeste FrozenInput (corr#1869) — PREPARED

Source code : `FROZEN_MANIFEST` dans `test/collab-store/parity/s9-e2e-worksession.spec.ts`.

| taskId | kind | pièces | marque |
|--------|------|--------|--------|
| s9-answer-01 | answer | (aucune) | S9_ANSWER_01 |
| s9-answer-02 | answer | 1 (sha40) | S9_ANSWER_02 |
| s9-answer-03 | answer | (aucune) | S9_ANSWER_03 |
| s9-review-01 | review | 1 (sha40) | S9_REVIEW_01 |
| s9-review-02 | review | (aucune) | S9_REVIEW_02 |
| s9-review-03 | review | 1 (sha40) | S9_REVIEW_03 |
| s9-test-01 | test | (aucune) | S9_TEST_01 |
| s9-test-02 | test | 2 (sha40) | S9_TEST_02 |
| s9-test-03 | test | (aucune) | S9_TEST_03 |
| s9-impl-01 | implement | 1 (sha40) | S9_IMPL_01 |
| s9-impl-02 | implement | (aucune) | S9_IMPL_02 |
| s9-impl-03 | implement | 3 (sha40) | S9_IMPL_03 |

Assertions structurelles : 12 taskId uniques, ≥3/kind, budget 800, sha40 stable des pièces non vides.
**Aucune sortie chat/API live** n'est produite par ce lot.

## Matrice E2E WorkSession (seq2183 / seq2190)

### Positifs (P*) — NOT_RUN

| ID | Kind | Invariant |
|----|------|-----------|
| P2-impl | implement | ≥5 steps, ≥2 outils autorisés, pas de filtre guided |
| P2-rev | review | idem review |
| P5-wake | any | clarify.answer → même WorkSession |
| P6-resume | implement | continue multi-étapes sans 2e PR |
| P7-verdict | review | dernière étape store_verdict |
| P8-handoff | implement | chat→API→chat 0 dup |
| P9-taskless | answer | packet sans task inventée |

### Négatifs (N*) — NOT_RUN runtime (N7 STRUCT juge)

| ID | Invariant |
|----|-----------|
| N1–N6, N8–N9 | HALT, grant, lease, ambiguous, paid0, C4 privée, SHA périmé, 2e PR |
| N7 | texte « merge » éliminatoire côté juge (≠ garde outil) |

### Baseline (B*) — NOT_RUN E2E

| ID | Fait |
|----|------|
| B-GEM-C2B2 | guided_stop implement |
| B-VIBE-REV | review sans store_verdict |
| B-ANS-CAP | answer over-budget |

## Suite

Parité live mesurée : GO Kevin, paid0. Fusion Kevin uniquement.

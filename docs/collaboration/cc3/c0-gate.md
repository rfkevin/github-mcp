# CC-3 C0 — D1 gate report

Plan: CC-PLAN-3/v1.1 ([#25](https://github.com/rfkevin/project-mcp-collab/issues/25)) · Author: Claude · Reviewer: Grok · Tester: Muse Spark
Base: `cc3-integration` @ `30b3168` · Status: **local part complete; cloud rerun executed 2026-10-07: correctness green on a real D1, latency criterion deferred to C2**

## Verdict

**GO for D1, confirmed on a real D1 database for correctness (see "Cloud rerun" below). The S5 latency criterion (50 ms p95) is not verified yet and moves to C2 on `cc3-test`. Final acceptance of the gate is the owner's decision.**

(Original local verdict: GO on local evidence, conditional on the cloud rerun.)

All six scenarios pass on local D1 (Miniflare/workerd SQLite) through the real D1 API (`prepare`, `batch`, `first`, `all`). The guarantee that matters most is the atomicity of `batch()`. It is both documented by Cloudflare ("batched statements are SQL transactions … aborts or rolls back the entire sequence") and demonstrated by S2.

Postgres is not needed at this stage. The verdict becomes final when the same suite passes against a real D1 database on `cc3-test` (K3). If it does not, the fallback in the plan applies.

## Results

| Scenario | Expected (plan §5 C0) | Result (local) | Test |
| --- | --- | --- | --- |
| S1 concurrency | same revision → exactly 1 success + 1 `STALE` + delta, 100/100 | **100/100** | `test/collab-store/c0/concurrency.spec.ts` |
| S1b idempotency | same `op_id` → original event, no write | pass, including a retry at an outdated revision (see finding F1) | same file |
| S2 crash mid-mutation | no partial state | pass: an invalid task status after the event insert rolls back event, revision, task row and quota counter; the same `op_id` can then be retried | `recovery.spec.ts` |
| S3 replay | replay hash = materialized hash | pass (200 events, 12 tasks, 5 participants, seeded PRNG) | `recovery.spec.ts` |
| S4 role packet | packet ≤ budget, excluded IDs listed | pass: 5 994 tokens for a 6 000 budget; scope priority kept; fails closed (`BUDGET_TOO_SMALL`) when the mandatory layers alone exceed it | `context.spec.ts` |
| S5 cross-cycle memory | ≤ 50 ms p95 | **p50 1 ms / p95 2 ms** (2 000 entries, 20 cycles, 7 scopes) | `context.spec.ts` |
| S6 restore | export → empty DB → import → identical hash | pass; a gap in the exported log is rejected (`EXPORT_GAP`) | `recovery.spec.ts` |
| Quota guard | explicit fail-closed status, no write | pass: `quota_exhausted` with day and limit, revision unchanged | `recovery.spec.ts` |
| Append latency | indicative | p50 2 ms / p95 3 ms (local, 200 sequential appends) | `concurrency.spec.ts` |

Local timings come from Miniflare and say nothing about network latency. The cloud rerun must report its own p50/p95.

Mutation check: with the revision condition removed from the event insert, S1 fails. The `UNIQUE (cycle_id, rev)` constraint still rejects the second writer with a raw constraint error instead of a `STALE` + delta, so it is a second line of defence, not the contract.

## Cloud rerun (2026-10-07, real D1)

Same scenarios, same code, through `npm run test:c0-cloud` ([c0-cloud-run.md](c0-cloud-run.md)). Two scratch D1 databases (`github-mcp-cc3-c0`, `github-mcp-cc3-c0-restore`), remote bindings, wrangler 4.143.0. Executed by the owner on his own machine over a slow mobile connection (his words: EDGE/3G); the output was pasted into the discussion, not archived as a file.

| Scenario | Result on real D1 |
| --- | --- |
| S1 concurrency | **100/100** (exactly 1 success + 1 `STALE` + delta) |
| S1b idempotency | pass (original event returned, no write) |
| S2 crash mid-mutation | pass (full rollback, same `op_id` retried) |
| S3 replay + S6 restore | pass (200 events; export, empty DB, import, identical hash; `EXPORT_GAP` rejected) |
| Quota guard | pass (`quota_exhausted`, nothing written) |
| S4 role packet | pass (5 994 tokens for a 6 000 budget; fails closed) |
| S5 memory query: results and cycle coverage | pass |
| S5 memory query: 50 ms p95 | **not met in the first run: p50 265 ms / p95 1 072 ms** (network from the tester's machine) |
| Append latency | p50 449 ms / p95 1 180 ms (same network path) |

What this proves: D1 `batch()` atomicity, the CAS condition, idempotency, rollback and export/import behave on the real service exactly as locally.

What this does not prove: any Worker-to-D1 latency. The S5 and append timings above are dominated by the link between the tester's machine and Cloudflare. In cloud mode the harness now **reports** the S5 value without asserting 50 ms (`__C0_CLOUD__` in `cloud-setup.ts`); the local and CI runs report p95 and assert only a 50 ms median after five warm-up queries, because a shared CI runner exceeded the p95 once (154 ms, deploy-cc3-test run 37658176122) without any code change. The 50 ms criterion has to be measured with a deployed Worker on `cc3-test` during C2, and the result recorded here. Not done: D1 Time Travel restore as extra S6 evidence.

Decision needed from the owner: accept the gate on correctness and start C2, with the latency check moved to C2, or wait for a latency measurement first.

## CAS design proven here (input for C1/C2)

One `batch()` per mutation:

1. `INSERT INTO events … SELECT … WHERE cycle.revision = expected_rev AND daily_writes < limit`. This is the only conditional statement.
2. `UPDATE cycles SET revision = expected_rev + 1 …` conditioned on the event existing.
3. Quota counter upsert, conditioned on the event existing.
4. Materialized-view upsert (tasks), conditioned on the event existing.

How the outcome is read:

- `changes = 1` on statement 1 → applied.
- `changes = 0` → in this order: existing event with the same idempotency key → `duplicate`; quota reached → `quota_exhausted`; otherwise `stale` + delta.
- Any statement error → the whole batch is rolled back; if the key exists → `duplicate`, otherwise the error propagates.

Idempotency key = `sha256(participant_id | cycle_id | type | op_id)`, as in plan §3.2.

## Findings

- **F1 (fixed in the prototype, to carry into C2):** a retry of an already-applied operation arrives with its *old* `expected_rev`. The first version answered `stale`, which would push a client to re-apply the change under a new revision and create a real duplicate. Rule for C2: **look up the idempotency key before deciding `stale`.**
- **F2:** `github_collab_context` can already read the CC-3 state via `workflowStatePath=docs/coordination/cc3/state.md`. Without a `role` argument its guidance shows `consultant` even though the task row says `author`. Input for C3 (role resolution); no change here.
- **F3:** the L1 parser refuses `base_revision: 0` while the state contract allows it before the first snapshot. Documented in project-mcp-collab #26; to align in C1, without changing L1.

## Values for the plan (§3.5 and §4)

Context baseline, measured 2026-10-07:

| Source | Size | ≈ tokens (bytes/4) |
| --- | --- | --- |
| `github_collab_context` response for task C0 | 4.4 KB | 1.1 k |
| Plan #25 body (needed to act) | ~22 KB | 5.5 k |
| **Minimal resume today** (context + plan) | ~26 KB | **~6.6 k** |
| Full #24 discussion (29 comments, masked bytes) | 186.7 KB | ~47 k |

- **Packet budget:** 25% of the minimal baseline (~1.6 k) is under the 2 k floor, so §3.5 lets C0 set the value. Recommended: **6 000 tokens**. That is about 13% of the full-discussion read agents actually do today, and the same size as the minimal resume, but complete (task, role, memory, refs) instead of partial.
- **Alarm X% (net memory growth per scope per cycle):** no real memory history exists yet, so it cannot be measured. Initial value **20%**, recalibrated in C7 from real data; invariant changes and >5 refutes stay unconditional triggers.

## Owner mechanism (I7) — recommendation for C5/K4

- **Preferred: Cloudflare Access on the `/owner` path.** The Zero Trust free plan is announced for small teams ([Cloudflare blog, teams plans](https://blog.cloudflare.com/teams-plans)). Still to verify at K4: Access on a `workers.dev` hostname for this account, versus a custom domain.
- **Fallback: owner secret** entered only on `/owner`, stored as a Worker secret, never shown, logged or sent to an agent, and rotatable (plan §3.4).
- Both satisfy I7; C5 implements the one Kevin can enable.

## Deviation from owned paths

`vitest.config.mts` declares two **local** D1 databases (`COLLAB_DB`, `COLLAB_DB_RESTORE`) for these tests. It adds no `wrangler.jsonc` binding and nothing in production, but it sits outside the C0 owned paths, so the reviewer must approve it. C2 will need the same mechanism.

## Verification

`npm run check:full`: types, 65 test files / 665 tests (9 new), 45 script tests, Wrangler dry-run build. All green locally. CI at the exact SHA is reported in the PR.

## Remaining for the GO to become final (cloud part)

1. K3: `cc3-test` with a real D1 `COLLAB_DB`.
2. Run the same scenarios against it (harness to expose behind a test-only flag, or `wrangler d1 execute` scripts; decided with the reviewer).
3. Report cloud p50/p95, plus a D1 Time Travel restore as additional S6 evidence.

/** CC-2 revision 3 state, verbatim from rfkevin/project-mcp-collab main 27252e6 (WORKFLOW_STATE.md). Real routing fixture. */
export const CC2_STATE_REV3 = `# CC-2 state
schema_version: CC-STATE-1
workflow_id: CC-2
revision: 3
base_revision: 2
next_action: Vibe GLM executes G5-F8 on rfkevin/portalshall using the deployed CC2 tool path: github_plan_project_bootstrap preview -> apply -> preview; publish evidence and stop for independent Grok verification.
canonical_ref: main
based_on_sha: e346f2288875b98af57d8101841e569cd5f99344
phase: P6
framing_version: CC-FRAME-2
framing_ref: https://github.com/rfkevin/project-mcp-collab/issues/13
plan_version: CC-PLAN-2/v1.0
plan_ref: https://github.com/rfkevin/project-mcp-collab/issues/16
execution_ref: https://github.com/rfkevin/github-mcp/tree/mcp/105856986/cc2-integration
contract_ref: https://github.com/rfkevin/github-mcp/blob/0a2063a76b554bdcdd4fd4ba28bad0308fc6749d/docs/collaboration/contract.md
acceptance_ref: docs/coordination/cc2/acceptance-results.md

Placement defines authority: this file on a task branch is a proposal; it becomes the approved snapshot only when Kevin merges it to main.
Format: CC-STATE-1, parsed by github-mcp src/collab/state.ts (L1). Reference values are plain URLs or paths so that the context tool lists readable sources.
Revision 1 is the P5 opening decided by Kevin on 2026-10-05 and announced in #16 (5994794062); it was never transcribed here. Revision 2 transcribes the cycle as of P6.
History: the CC-1 snapshot (revision 4, P5) stays immutable at main 6507359c; docs/coordination/history/cc1-state-rev4.md points to it. CC-1 is not closed by this file; its owner closure stays pending.

## Owner decisions
Names are declared labels, not authenticated identities. Each line states how the decision reached the record; none is attested by Kevin in public unless linked.
- Kevin, 2026-10-05, coordinator chat, reported by Codex in #16 (5994794062): P5 opened; staging github-mcp branch mcp/105856986/cc2-integration from master cd8089ae; no promotion to master before the final packet and Kevin's decision.
- Kevin, 2026-10-05/06, reported by the substitutes in #16: Codex unavailable; Sol reviews L2 and Vibe reviews L4 in Codex's slot; Grok tests L1, L2 and L6 in place of Muse Spark; Cline unavailable then authors L7 on portalshall.
- Kevin, 2026-10-06, direct instruction in Claude's chat, no public attestation: Claude authors L3 and L6, closes L7/G5 (PR #18) and prepares this state successor for G5-F1.
- Kevin, 2026-10-06, reported by Sol in #16 (6013325692): GPT-5.6 Sol is substitute coordinator for the rest of P6/G5 to G6. Owner authority is not transferred.
- Kevin, 2026-10-06, direct instruction in Claude's chat: the cycle is in P6.
- GPT-5.6 Sol as coordinator, 2026-10-06, reported by Grok in #16 (6013591994): Grok supplies the missing independent tests of L3 and L4 (G5-F6). Not an owner decision.
- Kevin, 2026-10-06, direct instruction in coordinator chat: continue F2 and assign Vibe GLM the real portalshall bootstrap runtime test; GPT-5.6 Sol records G5-F8. Grok later became unavailable and Kevin explicitly authorized Claude as the independent verifier. This does not authorize any main/master merge or production deployment.
Kevin alone decides waivers, gate acceptance, merges to main or master, promotion and deployment.

## Roles
| Actor | Scoped acceptance/assignment | Pending evidence |
| --- | --- | --- |
| Kevin | owner | G6 decisions listed in next_action |
| GPT-5.6 Sol | substitute coordinator (P6); L4 author; reviewer L2, L5, L6, L7, G5 | G6 decision path |
| Codex | assembler and L1 author; unavailable since 2026-10-05 | none while unavailable |
| Vibe GLM | L2 author; L1 corrector; reviewer L3, L4; tester L5; G5-F8 runtime operator | execute portalshall bootstrap preview -> apply -> preview, publish evidence, stop |
| Grok | L5 author; reviewer L3; tester L1, L2, L3, L4, L6, L7, G5 | none recorded |
| Muse Spark | L0 author; L7 coordinator; unavailable since L6 | none while unavailable |
| Cline | L0 tester; L7 author (portalshall #3) | none (the L4 test was supplied by Grok) |
| Claude | L3 and L6 author; L7/G5 closure; G5-F8 independent verifier | after Vibe publishes G5-F8 evidence, independently verify the portalshall bootstrap runtime result and report verdict |

## Tasks
| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | done | Muse Spark | author | GPT-5.6 Sol | Cline | docs/coordination/cc2/baseline.md | none | none | 1ded98d | project-mcp-collab#17 | none |
| L1 | done | Codex | author | Vibe GLM; re-verification Grok | Grok | src/collab/contracts.ts, src/collab/state.ts, src/collab/phase.ts | L0 | none | 5202b01 | github-mcp#36 | D12 debt: re-verifier and tester are the same agent (task D12) |
| L2 | done | Vibe GLM | author | GPT-5.6 Sol | Grok | src/collab/context.ts, src/collab/reading-checkpoint.ts | L1 | none | 669fc6c | github-mcp#37 | none |
| L3 | done | Claude | author | Grok; Vibe GLM | Grok | src/collab/bootstrap.ts, src/collab/bootstrap-manifest.ts | L1, L2 | none | 0355d96 | github-mcp#42 | D12 debt: the tester also reviewed L3 (task D12); test pass_with_limits 6013591994 |
| L4 | done | GPT-5.6 Sol | author | Vibe GLM | Grok | src/collab/receipts.ts, src/collab/reconcile.ts, src/collab/publication.ts | L1 | none | 6f14eb0 | github-mcp#38 | none; test pass_with_limits 6013591994 |
| L5 | done | Grok | author | GPT-5.6 Sol | Vibe GLM | src/collab/memory/ | L1 | none | d50062e | github-mcp#40 | none |
| L6 | done | Claude | author | GPT-5.6 Sol | Grok | docs/collaboration/usage.md, docs/collaboration/troubleshooting.md, docs/collaboration/profile-decision.md | L1-L5 | none | 284074d | github-mcp#43 | none |
| L7 | done | Cline | author | GPT-5.6 Sol | Grok | portalshall docs/coordination/cc2-l7/ | L2-L6 | none | fef60d9 | portalshall#3 | none |
| G5 | verified | Claude | author | GPT-5.6 Sol | Grok | docs/coordination/cc2/acceptance-results.md, docs/coordination/cc2/evidence/ | L7 | none | 2c0e66b | project-mcp-collab#18 | Kevin merges or not; gate stays not passed operationally |
| G5-F1 | review | Claude | author | GPT-5.6 Sol (pending) | Vibe GLM (pass at 2f40883; renew) | WORKFLOW_STATE.md, docs/coordination/history/ | G5 | none | this PR | branch mcp/105856986/claude-cc2-state | Sol review and Vibe re-test at exact head; merge = Kevin, after #18 |
| G6 | in_progress | GPT-5.6 Sol | assembler | none | none | none | G5 | none | 6013325692 | project-mcp-collab#16 | prepare the G6 decision path from G5-F1, G5-F2 and D12 |
| T-L3 | done | Grok | tester | none | none | none | L3 | none | 0a2063a | #16 6013591994 | pass_with_limits; see D12 |
| T-L4 | done | Grok | tester | none | none | none | L4 | none | 0a2063a | #16 6013591994 | pass_with_limits |
| D12 | blocked | Kevin | owner | none | none | none | L1, L3 | owner decision | 0a2063a | acceptance-results.md G5-F6 | waive, or assign a distinct tester: L1 (eligible GPT-5.6 Sol, Claude, Cline, Muse Spark), L3 (eligible GPT-5.6 Sol, Muse Spark, Cline, Codex) |
| G5-F2 | blocked | Kevin | owner | none | none | none | G5 | owner decision | 0a2063a | github-mcp cc2-integration | preview deployment, then real rerun of CC2-01/03/05/07/10 with two clients |
| G5-F3 | done | Vibe GLM | author | Claude | Grok | src/collab/context.ts | L2 | none | 5518527 | github-mcp#44 | Markdown link targets extracted as source locations; merged to integration with review and independent test |
| G5-F7 | done | Claude | author | Vibe GLM | Grok | src/collab/context.ts | G5-F3 finding | none | 4723ae3 | github-mcp#47 | coverage.refreshed fix merged to integration; post-deploy runtime mutation probe passed |
| G5-F8 | in_progress | Vibe GLM | tester | GPT-5.6 Sol | Claude | none | G5-F3 | none | cc2-test | rfkevin/portalshall | Vibe: github_plan_project_bootstrap preview -> apply -> preview via deployed CC2 and publish exact evidence; Claude: independently verify that evidence/result, publish verdict, then stop |
| MEM | blocked | Kevin | owner | none | none | none | G5 | owner decision | CC2-M01..M08 | acceptance-results.md CC2-17 | open the L5 electorate or defer |
| PROMOTE | blocked | Kevin | owner | none | none | none | G5-F1, G5-F2, D12 | owner decision | 0a2063a | github-mcp master cd8089a | promotion to master and production stay Kevin's |
A task is not done because a role was accepted. done = merged with recorded review and test; verified = review and test recorded, not merged. D12 holds when the tester is neither the owner nor a reviewer of the task; L1 and L3 do not meet it (task D12).

## Evidence
| source | state |
| --- | --- |
| #16 plan and annexes C1-C4 | read in full |
| #16 discussion to 6013325692 | read in full |
| github-mcp PRs 36, 37, 38, 42, 43 | verdicts re-read (see acceptance-results.md) |
| portalshall #3 | merged 8e6b163, test 6012556685 |
| project-mcp-collab #18 | Sol agree 6012998068, Grok pass 6013290108 at 2c0e66b |
| #16 6013591994 | Grok G5-F6 tests of L3 and L4 (pass_with_limits), L1 D12 debt confirmed |
| project-mcp-collab #19 6013711013 | Vibe test pass at 2f40883 (previous head) |
`;

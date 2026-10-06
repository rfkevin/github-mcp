# Collective memory (CC-2 L5)

Pure evaluation engine for candidate capture, voting and projection. **Persistence** (append to AGENT_MEMORY / GLOBAL_MEMORY / TOOL_IMPROVEMENTS) waits for L4 receipt interfaces and is not included here.

## Modules

| Path | Role |
| --- | --- |
| `src/collab/memory/candidates.ts` | Create and version candidates; hypothesis may lack complete evidence |
| `src/collab/memory/voting.ts` | Fixed electorate, quorum, keep/defer/reject/abstain evaluation |
| `src/collab/memory/projection.ts` | Task-scoped retrieval; hypotheses never unconditional instructions |

## Voting policy v1

- Electorate snapshot fixed when the checkpoint opens; silence does not reduce N.
- Quorum `Q = max(2, floor(N/2)+1)` non-abstaining ballots.
- **keep**: quorum + strictly more keep than other non-abstaining + at least two non-proposer keep votes.
- **reject**: quorum + strict reject majority.
- Otherwise **deferred** / **pending**. `N < 3` → always pending broader review.
- Decision `accepted` still has `publication: pending` until a Git write succeeds (L4).
- Evaluation requires explicit `ClosureEvidence` (`time` or `all_ballots_received`); quorum alone never finalizes.

## Scopes

| Scope | Destination (persistence later) |
| --- | --- |
| `mcp_internal` | github-mcp `AGENT_MEMORY.md` |
| `global_usage` | github-mcp `GLOBAL_MEMORY.md` (protected journal) |
| `project` | target project `AGENT_MEMORY.md` |

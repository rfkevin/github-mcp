# L1 acceptance checklist

L1 is accepted when the staging PR contains the pure contracts, parser and phase guidance without changing the existing MCP surface.

- [ ] CC-STATE-1 constants and typed contracts validate phases, tasks, roles, memory candidates, ballots, quorum and publication state.
- [ ] The parser accepts the current CC-1 state as legacy-v1 and accepts a versioned CC-2 state.
- [ ] Duplicate control keys, duplicate sections, malformed or ragged tables, invalid revisions, SHAs, phases and task statuses fail deterministically.
- [ ] Task and role records are derived from the canonical tables; actionable task selection is explicit.
- [ ] Guidance covers P1-P6, owner authority and sync_pending reporting.
- [ ] Tests are split by contracts, state parsing and phase guidance.
- [ ] Code-map navigation points directly to every L1 source, test and document.
- [ ] No MCP tool registration, legacy permission change, memory persistence or branch promotion is included.
- [ ] The reviewer can validate the exact commit and the tester can run the focused suites before the full CI gate.

## Review corrections applied (Vibe GLM, owner-instructed)

- [x] The real CC-1 fixture (WORKFLOW_STATE rev 4) parses in legacy mode.
- [x] Legacy documents only require the CC-1 control-key subset; CC-2 keys are validated when present.
- [x] Duplicate task ids and duplicate actors are explicit errors; task rows may carry role, owned_paths, dependencies and blocker.
- [x] Stale revision/head detection is available via validateSnapshotCurrency.
- [x] Task assignments enforce distinct author, reviewer and tester.
- [x] Source references carry completeness, updatedAt, blob SHA and continuation; memory candidates carry a version; decisions and ballots match their candidate.
- [ ] Codex re-verifies the corrected head; Grok runs the independent test suite.

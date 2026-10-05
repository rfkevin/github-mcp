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

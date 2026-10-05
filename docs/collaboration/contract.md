# CC-2 collaboration contract

L1 is the pure foundation for the cross-project collaboration workflow. It defines typed values and deterministic validation; it does not register a new MCP tool and it does not change legacy readers, writers or permissions.

## Canonical state

A workflow state is a Markdown document with control keys, an Owner decisions section, a Roles table and a Tasks table. CC-STATE-1 is versioned. A legacy CC-1 document without schema_version remains readable and is reported as legacy-v1; parsing never rewrites it. Revision and base_revision are monotonic, based_on_sha is a Git SHA, and owner decisions remain authoritative.

## Roles and phases

Roles are explicit: owner, author, reviewer, tester, assembler and consultant. Phase guidance exposes the actions for P1 through P6. Agents report sync_pending when their local state is older than the owner's latest decision. A role contributes evidence and cannot infer a transition or merge from a comment alone.

## Memory candidates

Candidates carry a scope (MCP internal, global usage or project), a knowledge state, a complete source reference and a proposer. Ballots are private data at the persistence layer. A memory decision records its quorum and publication state; L1 validates this shape while L5 owns storage, voting and publication.

## Boundaries

This lot only adds pure modules, unit tests and navigation documentation. Tool registration, GitHub writes, persistent ballots, branch promotion and production activation belong to later lots and the owner approval gate.

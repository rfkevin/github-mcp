/**
 * Fixture G5-F3 : état CC-STATE-1 dont les refs de contrôle contiennent des liens Markdown.
 * Le contexte doit exposer les cibles des liens comme emplacements de sources, pas la syntaxe.
 */
export const LINK_REFS_STATE_LINES = [
  '# CC-2 state',
  'schema_version: CC-STATE-1',
  'workflow_id: cc2',
  'revision: 2',
  'next_action: read the refs',
  'base_revision: 1',
  'canonical_ref: main',
  'based_on_sha: abcdef1234567890abcdef1234567890abcdef12',
  'phase: P5',
  'framing_version: 1',
  'framing_ref: https://example.test/framing',
  'plan_version: 1',
  'plan_ref: [complete plan](docs/coordination/plan-v1.2.md)',
  'execution_ref: [V01-V16](docs/coordination/acceptance-v1.md) plus prose around it',
  'contract_ref: docs/collaboration/contract.md',
  'acceptance_ref: docs/collaboration/acceptance.md',
  '',
  '## Owner decisions',
  'Fixture state for G5-F3: Markdown link targets must become source locations.',
  '',
  '## Roles',
  '| Actor | Scoped acceptance/assignment | Pending evidence |',
  '| --- | --- | --- |',
  '| Kevin | owner | none |',
  '| Vibe GLM | author | G5-F3 |',
  '',
  '## Tasks',
  '| id | status | owner | role | owned_paths | dependencies | blocker | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| G5-F3 | in_progress | Vibe GLM | author | [notebook](docs/coordination/plan-v1.2.md), src/collab/context.ts | L2 | none | 1 | docs/coordination/acceptance-v1.md | fix link targets |',
];

export const LINK_REFS_STATE = LINK_REFS_STATE_LINES.join('\n') + '\n';

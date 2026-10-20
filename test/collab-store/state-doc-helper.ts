// Document CC-STATE-1 minimal partagé par les tests de vérification d'import (l3e).
export const HEADERS = [
  'workflow_id: CC-5', 'canonical_ref: main', 'phase: P6', 'framing_version: CC-FRAME-5',
  'framing_ref: https://github.com/rfkevin/github-mcp/issues/154', 'plan_version: CC-PLAN-5/v0.4',
  'plan_ref: https://github.com/rfkevin/github-mcp/issues/154', 'execution_ref: https://github.com/rfkevin/github-mcp/issues/154',
  'contract_ref: https://github.com/rfkevin/github-mcp/issues/154', 'acceptance_ref: https://github.com/rfkevin/github-mcp/issues/154',
];
const ROLES = ['| Kevin | owner | Import |'];
export const TASK = (id: string, status: string, version: number, extra = '') =>
  '| ' + id + ' | ' + status + ' | none | author | none | none | src/x | none | none | ' + version + ' | ref | next' + extra + ' |';

export function doc(o: { revision: number; header?: string[]; decisions?: string[]; tasks?: string[]; evidence?: string[]; nextAction?: string }): string {
  return [
    '# CC-5 state', 'schema_version: CC-STATE-1', ...(o.header ?? HEADERS),
    'revision: ' + o.revision, 'base_revision: ' + (o.revision - 1), 'next_action: ' + (o.nextAction ?? 'go'), 'based_on_sha: abc1234', '',
    'Prose.', '',
    '## Owner decisions', ...(o.decisions ?? ['- Kevin: decision one.']), '',
    '## Roles', '| Actor | Scoped acceptance/assignment | Pending evidence |', '| --- | --- | --- |', ...ROLES, '',
    '## Tasks',
    '| id | status | owner | role | reviewer | tester | owned_paths | dependencies | blocker | version | ref | next_action |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(o.tasks ?? [TASK('t1', 'accepted', 1)]), '',
    '## Evidence', '| source | state |', '| --- | --- |', ...(o.evidence ?? ['| e1 | ok |']), '',
  ].join('\n');
}

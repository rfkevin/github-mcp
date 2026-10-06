import { describe, expect, it } from 'vitest';
import { parseWorkflowState, taskRecords } from '../../src/collab/state';
import { StateContractError } from '../../src/collab/contracts';

const headerLines = [
  '# CC-2 state',
  'schema_version: CC-STATE-1',
  'workflow_id: cc2',
  'revision: 2',
  'base_revision: 1',
  'next_action: verify table truncation',
  'canonical_ref: main',
  'based_on_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'phase: P6',
  'framing_version: 1',
  'framing_ref: https://example.test/framing',
  'plan_version: 1',
  'plan_ref: https://example.test/plan',
  'execution_ref: https://example.test/execution',
  'contract_ref: docs/collaboration/contract.md',
  'acceptance_ref: docs/collaboration/acceptance.md',
];

const buildState = (tasks: string[], evidence: string[] = ['| source | state |', '| --- | --- |', '| fixture | verified |']) =>
  [...headerLines, '', '## Owner decisions', 'Fixture for G-L1-T1.', '', '## Roles',
    '| Actor | Scoped acceptance/assignment | Pending evidence |', '| --- | --- | --- |', '| Kevin | owner | none |',
    '', '## Tasks', ...tasks, '', '## Evidence', ...evidence].join('\n') + '\n';

const tasksHeader = [
  '| id | status | owner | role | owned_paths | dependencies | blocker | version | ref | next_action |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
];
const row = (id: string) => `| ${id} | done | Kevin | author | none | none | none | 1 | fixture | none |`;

const expectCode = (content: string, code: string): void => {
  try {
    parseWorkflowState(content);
  } catch (error) {
    expect((error as StateContractError).code).toBe(code);
    return;
  }
  throw new Error(`expected parse failure with ${code}`);
};

describe('G-L1-T1 : un tableau tronqué échoue au lieu de perdre des tâches', () => {
  it('tableau bien formé : toutes les tâches sont lues', () => {
    const parsed = parseWorkflowState(buildState([...tasksHeader, row('L0'), row('L1'), row('L2'), row('L3')]));
    expect(taskRecords(parsed)).toHaveLength(4);
  });

  it('ligne sans pipe final : TABLE_TRUNCATED au lieu de perte silencieuse', () => {
    const partialRow = row('L1').slice(0, -2);
    expect(partialRow.startsWith('|')).toBe(true);
    expect(partialRow.endsWith('|')).toBe(false);
    expectCode(buildState([...tasksHeader, row('L0'), partialRow, row('L2')]), 'TABLE_TRUNCATED');
  });

  it('ligne vide au milieu du tableau (repro Claude 18 vers 12) : TABLE_TRUNCATED', () => {
    expectCode(buildState([...tasksHeader, row('L0'), row('L1'), '', row('L2'), row('L3')]), 'TABLE_TRUNCATED');
  });

  it('dernière ligne du tableau sans pipe final : TABLE_TRUNCATED', () => {
    expectCode(buildState([...tasksHeader, row('L0'), row('L1').slice(0, -2)]), 'TABLE_TRUNCATED');
  });

  it('deux tableaux séparés par du texte : pas de faux positif', () => {
    const evidence = ['| source | state |', '| --- | --- |', '| a | verified |', '',
      'Prose between the two tables.', '', '| other | state |', '| --- | --- |', '| b | verified |'];
    const parsed = parseWorkflowState(buildState([...tasksHeader, row('L0')], evidence));
    expect(taskRecords(parsed)).toHaveLength(1);
  });
});

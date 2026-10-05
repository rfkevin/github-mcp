import { describe, expect, it } from 'vitest';
import { deriveTaskContext, parseWorkflowState, taskRecords, validateSnapshotCurrency } from '../../src/collab/state';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CC2_STATE = `# CC-2 state
schema_version: CC-STATE-1
workflow_id: cc2
revision: 2
next_action: implement
base_revision: 1
canonical_ref: main
based_on_sha: abcdef1
phase: P5
framing_version: 1
framing_ref: issue-16
plan_version: 1
plan_ref: issue-16
execution_ref: staging
contract_ref: docs/collaboration/contract.md
acceptance_ref: docs/collaboration/acceptance.md

## Owner decisions
The owner has approved the implementation phase.

## Roles
| Actor | Scoped acceptance/assignment | Pending evidence |
| --- | --- | --- |
| Kevin | owner | none |
| Codex | author | L1 PR |

## Tasks
| id | status | owner | version | ref | next_action |
| --- | --- | --- | --- | --- | --- |
| L1 | in_progress | Codex | 1 | branch:l1 | implement |

## Evidence
| source | state |
| --- | --- |
| issue-16 | verified |
`;

describe('CC-2 workflow state parser', () => {
  it('parses the versioned state and derives the actionable task', () => {
    const snapshot = parseWorkflowState(CC2_STATE);
    expect(snapshot.schemaVersion).toBe('CC-STATE-1');
    expect(snapshot.legacySchema).toBe(false);
    expect(taskRecords(snapshot)[0].id).toBe('L1');
    expect(deriveTaskContext(snapshot).phase).toBe('P5');
  });

  it('accepts a legacy state without a schema version', () => {
    const legacy = CC2_STATE.replace('schema_version: CC-STATE-1\n', '');
    const snapshot = parseWorkflowState(legacy);
    expect(snapshot.legacySchema).toBe(true);
    expect(snapshot.schemaVersion).toBe('legacy-v1');
  });

  it('rejects duplicate control keys and ragged tables', () => {
    expect(() => parseWorkflowState(CC2_STATE.replace('revision: 2', 'revision: 2\nrevision: 3'))).toThrow(/Duplicate control key/);
    const ragged = CC2_STATE.replace('| L1 | in_progress | Codex | 1 | branch:l1 | implement |', '| L1 | in_progress | Codex |');
    expect(() => parseWorkflowState(ragged)).toThrow(/wrong width/);
  });

  it('rejects unknown schemas and task ids', () => {
    expect(() => parseWorkflowState(CC2_STATE.replace('CC-STATE-1', 'CC-STATE-9'))).toThrow(/Unsupported state schema/);
    const snapshot = parseWorkflowState(CC2_STATE);
    expect(() => deriveTaskContext(snapshot, 'L9')).toThrow(/actionable task/);
  });
});

const CC1_STATE = readFileSync(fileURLToPath(new URL('./fixtures/cc1-state.md', import.meta.url)), 'utf8');

describe('CC-1 compatibility and contract errors', () => {
  it('parses the real CC-1 state (rev 4) as legacy-v1', () => {
    const snapshot = parseWorkflowState(CC1_STATE);
    expect(snapshot.legacySchema).toBe(true);
    expect(snapshot.headers.workflow_id).toBe('CC-1');
    expect(snapshot.headers.revision).toBe('4');
    const records = taskRecords(snapshot);
    expect(records.map((record) => record.id)).toContain('T40');
    expect(deriveTaskContext(snapshot, 'T60').task.status).toBe('review');
  });

  it('preserves harmless extension sections', () => {
    const extended = CC2_STATE + '
## Extension notes
| key | value |
| --- | --- |
| extra | preserved |
';
    const snapshot = parseWorkflowState(extended);
    expect(snapshot.sections['Extension notes'][0].rows[0]).toEqual(['extra', 'preserved']);
  });

  it('rejects missing control keys, bad revisions, SHAs and phases', () => {
    expect(() => parseWorkflowState(CC2_STATE.replace('phase: P5
', ''))).toThrow(/Missing control key/);
    expect(() => parseWorkflowState(CC2_STATE.replace('revision: 2', 'revision: two'))).toThrow(/positive integer/);
    expect(() => parseWorkflowState(CC2_STATE.replace('base_revision: 1', 'base_revision: 9'))).toThrow(/base_revision/);
    expect(() => parseWorkflowState(CC2_STATE.replace('based_on_sha: abcdef1', 'based_on_sha: notasha'))).toThrow(/hexadecimal/);
    expect(() => parseWorkflowState(CC2_STATE.replace('phase: P5', 'phase: P9'))).toThrow(/unsupported value/);
  });

  it('rejects duplicate task ids and duplicate actors', () => {
    const duplicateTask = CC2_STATE.replace(
      '| L1 | in_progress | Codex | 1 | branch:l1 | implement |',
      '| L1 | in_progress | Codex | 1 | branch:l1 | implement |
| L1 | review | Codex | 1 | branch:l1 | review |',
    );
    expect(() => parseWorkflowState(duplicateTask)).toThrow(/twice/);
    const duplicateActor = CC2_STATE.replace(
      '| Codex | author | L1 PR |',
      '| Codex | author | L1 PR |
| Codex | reviewer | L1 review |',
    );
    expect(() => parseWorkflowState(duplicateActor)).toThrow(/twice/);
  });

  it('flags stale snapshots against newer owner decisions', () => {
    const snapshot = parseWorkflowState(CC2_STATE);
    expect(() => validateSnapshotCurrency(snapshot, { revision: 3 })).toThrow(/stale/);
    expect(() => validateSnapshotCurrency(snapshot, { sha: 'fffffff' })).toThrow(/stale/);
    expect(() => validateSnapshotCurrency(snapshot, { revision: 2, sha: 'abcdef1' })).not.toThrow();
  });
});

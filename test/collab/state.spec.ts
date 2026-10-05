import { describe, expect, it } from 'vitest';
import { deriveTaskContext, parseWorkflowState, taskRecords } from '../../src/collab/state';

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

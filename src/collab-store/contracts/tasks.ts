/**
 * CC-3 C1 — task assignment contracts (D12 enforced on write).
 * Reuses L1 validateTaskAssignment semantics via assertDistinctRoles.
 */
import {
  StateContractError,
  assertDistinctRoles,
  type AgentRole,
} from '../../collab/contracts';

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PID_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;

export interface TaskAssignment {
  task_id: string;
  cycle_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  owner_role?: AgentRole;
}

function pid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !PID_RE.test(value)) {
    throw new StateContractError(
      'INVALID_TASK_PARTICIPANT',
      `${field} must be a server-derived participant id`,
      field,
    );
  }
  return value;
}

/** D12: author, reviewer and tester must be three distinct participants. */
export function validateTaskAssignment(assignment: TaskAssignment): TaskAssignment {
  if (!TASK_ID_RE.test(assignment.task_id ?? '')) {
    throw new StateContractError('INVALID_TASK_ID', 'task_id must match [a-z0-9][a-z0-9_-]{0,63}', 'task_id');
  }
  const owner = pid(assignment.owner_pid, 'owner_pid');
  const reviewer = pid(assignment.reviewer_pid, 'reviewer_pid');
  const tester = pid(assignment.tester_pid, 'tester_pid');
  const seen = new Set([owner, reviewer, tester]);
  if (seen.size !== 3) {
    throw new StateContractError(
      'DUPLICATE_TASK_ROLE',
      'Task author, reviewer and tester must be three distinct participants (D12)',
    );
  }
  if (assignment.owner_role !== undefined) {
    assertDistinctRoles([assignment.owner_role, assignment.owner_role].slice(0, 1));
  }
  return { ...assignment, owner_pid: owner, reviewer_pid: reviewer, tester_pid: tester };
}

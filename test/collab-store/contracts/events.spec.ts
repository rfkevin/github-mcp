import { describe, expect, it } from 'vitest';
import {
  assertUniqueIdempotencyKeys,
  parseRowRevision,
  validateAgentEvent,
} from '../../../src/collab-store/contracts/agent-events';
import { validateEventType } from '../../../src/collab-store/contracts/events';
import { validateTaskAssignment } from '../../../src/collab-store/contracts/tasks';

const base = {
  cycle_id: 'cc3',
  type: 'task.claim' as const,
  participant_id: 'p:muse',
  expected_rev: 1,
  payload_json: '{"task":"C1"}',
  idempotency_key: 'gh-cc3-task-claim-0000000001',
};

describe('CC-3 C1 store events', () => {
  it('accepts every declared event type with accept+reject coverage', () => {
    const types = [
      'task.claim', 'task.status', 'task.handoff', 'checkpoint', 'evidence.add',
      'objection.open', 'objection.resolve', 'proposal.submit', 'phase.request',
      'owner.request', 'memory.propose', 'memory.review', 'memory.consolidate',
      'memory.retire', 'manual_op.log',
    ];
    for (const type of types) {
      expect(() => validateAgentEvent({ ...base, type: type as typeof base.type })).not.toThrow();
    }
    expect(() => validateEventType('nope')).toThrow(/Unknown store event type/);
  });

  it('rejects owner.decision from agents (I7)', () => {
    expect(() => validateAgentEvent({ ...base, type: 'owner.decision' as never }))
      .toThrow(/only the \/owner channel records it/);
  });

  it('rejects free-text labels as participant ids', () => {
    expect(() => validateAgentEvent({ ...base, participant_id: 'Muse Spark !!!' }))
      .toThrow(/server-derived/);
  });

  it('allows expected_rev 0 for creation, rejects negatives; stored rows start at 1 (F3)', () => {
    expect(() => validateAgentEvent({ ...base, expected_rev: 0 })).not.toThrow();
    expect(() => validateAgentEvent({ ...base, expected_rev: -1 })).toThrow(/expected_rev must be/);
    expect(parseRowRevision(1)).toBe(1);
    expect(() => parseRowRevision(0)).toThrow(/revision must be/);
    expect(() => parseRowRevision('two')).toThrow(/positive integer/);
  });

  it('rejects bad idempotency keys and duplicates', () => {
    expect(() => validateAgentEvent({ ...base, idempotency_key: 'x' }))
      .toThrow(/idempotency_key must be/);
    expect(() => assertUniqueIdempotencyKeys([
      { idempotency_key: 'a-12345678' },
      { idempotency_key: 'a-12345678' },
    ])).toThrow(/Duplicate idempotency key/);
  });

  it('rejects invalid payload JSON', () => {
    expect(() => validateAgentEvent({ ...base, payload_json: '{oops' }))
      .toThrow(/payload_json must be valid JSON/);
  });
});

describe('CC-3 C1 task assignment (D12)', () => {
  it('requires three distinct participants', () => {
    expect(() => validateTaskAssignment({
      task_id: 'C1', cycle_id: 'cc3',
      owner_pid: 'p:muse', reviewer_pid: 'p:vibe', tester_pid: 'p:grok',
    })).not.toThrow();
    expect(() => validateTaskAssignment({
      task_id: 'C1', cycle_id: 'cc3',
      owner_pid: 'p:muse', reviewer_pid: 'p:muse', tester_pid: 'p:grok',
    })).toThrow(/three distinct participants/);
  });
});

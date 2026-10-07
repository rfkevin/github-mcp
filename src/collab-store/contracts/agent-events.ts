/**
 * CC-3 C1 — agent event validation + revision helpers (part 2).
 * `owner.decision` accepted by the type but rejected for agents (I7).
 */
import { StateContractError, parseRevision } from '../../collab/contracts';
import { validateEventType, type StoreEvent } from './events';

const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PARTICIPANT_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9:_-]{8,256}$/;

function nonEmpty(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StateContractError('INVALID_EVENT_FIELD', `${field} must be a non-empty string`, field);
  }
  if (value.length > max) {
    throw new StateContractError('EVENT_FIELD_TOO_LONG', `${field} exceeds ${max} characters`, field);
  }
  return value;
}

/** Validate an agent-emitted event. Rejects `owner.decision` (C5 /owner only). */
export function validateAgentEvent(event: StoreEvent): StoreEvent {
  const type = validateEventType(event.type);
  if (type === 'owner.decision') {
    throw new StateContractError(
      'OWNER_DECISION_FORBIDDEN',
      'owner.decision cannot be emitted by agents; only the /owner channel records it',
      'type',
    );
  }
  if (!CYCLE_RE.test(event.cycle_id ?? '')) {
    throw new StateContractError('INVALID_CYCLE_ID', 'cycle_id must match [a-z0-9][a-z0-9_-]{0,63}', 'cycle_id');
  }
  if (!PARTICIPANT_RE.test(event.participant_id ?? '')) {
    throw new StateContractError(
      'INVALID_PARTICIPANT_ID',
      'participant_id must be server-derived, never a free-text label',
      'participant_id',
    );
  }
  if (!Number.isSafeInteger(event.expected_rev) || event.expected_rev < 0) {
    throw new StateContractError(
      'INVALID_EXPECTED_REV',
      'expected_rev must be >= 0 (0 = creation; stored rows start at 1)',
      'expected_rev',
    );
  }
  const key = nonEmpty(event.idempotency_key, 'idempotency_key', 256);
  if (!IDEMPOTENCY_RE.test(key)) {
    throw new StateContractError(
      'INVALID_IDEMPOTENCY_KEY',
      'idempotency_key must be 8-256 chars of [A-Za-z0-9:_-], derived per policy',
      'idempotency_key',
    );
  }
  const payload = nonEmpty(event.payload_json, 'payload_json', 65536);
  try {
    JSON.parse(payload);
  } catch {
    throw new StateContractError('INVALID_PAYLOAD_JSON', 'payload_json must be valid JSON', 'payload_json');
  }
  return event;
}

/** Parse a 1-based stored revision (F3: 0 is never stored). */
export function parseRowRevision(value: number | string): number {
  const n = typeof value === 'number' ? value : parseRevision(String(value), 'revision');
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new StateContractError('INVALID_REVISION', 'revision must be >= 1', 'revision');
  }
  return n;
}

/** Reject duplicate idempotency keys inside one batch. */
export function assertUniqueIdempotencyKeys(events: readonly Pick<StoreEvent, 'idempotency_key'>[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.idempotency_key)) {
      throw new StateContractError(
        'DUPLICATE_IDEMPOTENCY_KEY',
        `Duplicate idempotency key: ${event.idempotency_key}`,
        'idempotency_key',
      );
    }
    seen.add(event.idempotency_key);
  }
}

/**
 * CC-3 C1 — store event contracts (storage-agnostic).
 * Validates every `events` row payload before any write (C2 enforces).
 * Reuses L1 `src/collab/contracts.ts` WITHOUT modifying it.
 * No import from `src/mcp/**` (architecture test).
 */
import { StateContractError } from '../../collab/contracts';

export const EVENT_TYPES = [
  'task.claim',
  'task.status',
  'task.handoff',
  'checkpoint',
  'evidence.add',
  'objection.open',
  'objection.resolve',
  'proposal.submit',
  'phase.request',
  'owner.request',
  'memory.propose',
  'memory.review',
  'memory.consolidate',
  'memory.retire',
  'manual_op.log',
  // `owner.decision` is server-internal (C5 /owner only); agents cannot emit it.
  'owner.decision',
] as const;
export type StoreEventType = (typeof EVENT_TYPES)[number];

export interface StoreEvent {
  cycle_id: string;
  type: StoreEventType;
  participant_id: string;
  session_id?: string;
  role?: string;
  /** Expected revision. 0 = row creation (F3: stored rows start at 1). */
  expected_rev: number;
  payload_json: string;
  /** Idempotency key, deterministic per client+op (F1: checked BEFORE STALE). */
  idempotency_key: string;
  evidence_ref?: string;
}

export function validateEventType(value: string): StoreEventType {
  if (!EVENT_TYPES.includes(value as StoreEventType)) {
    throw new StateContractError('UNKNOWN_EVENT_TYPE', `Unknown store event type: ${value}`, 'type');
  }
  return value as StoreEventType;
}

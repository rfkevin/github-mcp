/**
 * CC-4 A1 — durable invocation contract.
 *
 * Raw input packets are hashed and never persisted by this layer. The wake key
 * follows CC-PLAN-4 §3.2 exactly: hash(cycle, task, role, principal, reason,
 * source_revision). endpoint/input/source-event details are instead covered by
 * payload_hash so reusing one wake key for a different assignment fails closed.
 */
import { StateContractError } from '../../collab/contracts';
import { TASK_ID_RE } from '../contracts/tasks';
import { sha256Hex } from '../store/hash';

export const INVOCATION_STATES = ['queued', 'leased', 'running', 'succeeded', 'failed', 'expired'] as const;
export type InvocationState = (typeof INVOCATION_STATES)[number];

const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PRINCIPAL_RE = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const ENDPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const TARGET_RE = /^[A-Za-z0-9_.\/-]{0,200}$/;

export interface InvocationIntent {
  cycle_id: string;
  task_id: string;
  role: string;
  principal_id: string;
  endpoint_id: string;
  reason: string;
  source_revision: number;
  input_packet: string;
  target_repository?: string;
  target_head?: string;
  target_base?: string;
  evidence_refs?: string[];
}

export interface InvocationDescriptor extends Omit<InvocationIntent, 'input_packet' | 'evidence_refs'> {
  invocation_id: string;
  wake_key: string;
  source_event_hash: string;
  input_hash: string;
  payload_hash: string;
  evidence_refs: string[];
}

export interface InvocationUsage {
  input_tokens: number;
  output_tokens: number;
  operations: number;
}

export interface InvocationRecord {
  invocation_id: string;
  wake_key: string;
  cycle_id: string;
  task_id: string;
  role: string;
  principal_id: string;
  endpoint_id: string;
  reason: string;
  source_revision: number;
  source_event_seq: number;
  source_event_hash: string;
  input_hash: string;
  payload_hash: string;
  target_repository: string;
  target_head: string;
  target_base: string;
  state: InvocationState;
  attempt_count: number;
  consecutive_failures: number;
  queued_at: number;
  leased_at: number | null;
  running_at: number | null;
  finished_at: number | null;
  lease_owner: string;
  lease_expires_at: number | null;
  output_hash: string;
  last_error: string;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_operations: number;
  cost_microunits: number;
  evidence_refs: string;
}

function invalid(message: string): never {
  throw new StateContractError('INVALID_INVOCATION', message, 'invocation');
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    invalid(field + ' must be a non-empty string <= ' + max + ' characters');
  }
  return value;
}

function optionalTarget(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !TARGET_RE.test(value)) invalid(field + ' is invalid');
  return value;
}

export function normalizeInvocationUsage(usage: Partial<InvocationUsage> = {}): InvocationUsage {
  const normalized: InvocationUsage = {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    operations: usage.operations ?? 0,
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) invalid('usage.' + field + ' must be an integer >= 0');
  }
  return normalized;
}

export async function describeInvocation(
  input: InvocationIntent,
  sourceEventFingerprint: string,
): Promise<InvocationDescriptor> {
  if (!CYCLE_RE.test(input.cycle_id ?? '')) invalid('cycle_id is invalid');
  if (!TASK_ID_RE.test(input.task_id ?? '')) invalid('task_id is invalid');
  if (!ROLE_RE.test(input.role ?? '')) invalid('role is invalid');
  if (!PRINCIPAL_RE.test(input.principal_id ?? '')) invalid('principal_id is invalid');
  if (!ENDPOINT_RE.test(input.endpoint_id ?? '')) invalid('endpoint_id is invalid');
  const reason = bounded(input.reason, 'reason', 200).trim();
  if (!Number.isSafeInteger(input.source_revision) || input.source_revision < 1) invalid('source_revision must be >= 1');
  const packet = bounded(input.input_packet, 'input_packet', 65_536);
  const evidence = input.evidence_refs ?? [];
  if (!Array.isArray(evidence) || evidence.length > 20
      || !evidence.every(ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 1024)) {
    invalid('evidence_refs must contain at most 20 non-empty refs <= 1024 characters');
  }
  const target_repository = optionalTarget(input.target_repository, 'target_repository');
  const target_head = optionalTarget(input.target_head, 'target_head');
  const target_base = optionalTarget(input.target_base, 'target_base');
  const source_event_hash = await sha256Hex(bounded(sourceEventFingerprint, 'source_event_fingerprint', 65_536));
  const input_hash = await sha256Hex(packet);
  const wake_key = await sha256Hex(JSON.stringify([
    input.cycle_id, input.task_id, input.role, input.principal_id, reason, input.source_revision,
  ]));
  const payload_hash = await sha256Hex(JSON.stringify({
    wake_key,
    endpoint_id: input.endpoint_id,
    input_hash,
    source_event_hash,
    target_repository,
    target_head,
    target_base,
    evidence_refs: evidence,
  }));
  return {
    cycle_id: input.cycle_id,
    task_id: input.task_id,
    role: input.role,
    principal_id: input.principal_id,
    endpoint_id: input.endpoint_id,
    reason,
    source_revision: input.source_revision,
    target_repository,
    target_head,
    target_base,
    invocation_id: 'inv-' + wake_key,
    wake_key,
    source_event_hash,
    input_hash,
    payload_hash,
    evidence_refs: evidence,
  };
}

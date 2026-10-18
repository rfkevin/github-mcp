import type { InvocationDescriptor, InvocationRecord } from './contracts';

export const INVOCATION_COLUMNS = [
  'invocation_id', 'wake_key', 'cycle_id', 'task_id', 'role', 'principal_id',
  'endpoint_id', 'reason', 'source_revision', 'source_event_seq',
  'source_event_hash', 'input_hash', 'payload_hash', 'target_repository',
  'target_head', 'target_base', 'state', 'attempt_count', 'consecutive_failures',
  'queued_at', 'leased_at', 'running_at', 'finished_at', 'lease_owner',
  'lease_expires_at', 'output_hash', 'output_text', 'last_error', 'usage_input_tokens',
  'usage_output_tokens', 'usage_operations', 'cost_microunits', 'evidence_refs',
].join(', ');

export async function invocationByWakeKey(db: D1Database, wakeKey: string): Promise<InvocationRecord | null> {
  return db.prepare('SELECT ' + INVOCATION_COLUMNS + ' FROM invocations WHERE wake_key = ?1')
    .bind(wakeKey).first<InvocationRecord>();
}

export async function invocationById(db: D1Database, invocationId: string): Promise<InvocationRecord | null> {
  return db.prepare('SELECT ' + INVOCATION_COLUMNS + ' FROM invocations WHERE invocation_id = ?1')
    .bind(invocationId).first<InvocationRecord>();
}

export async function deliverableInvocations(db: D1Database, limit: number): Promise<InvocationRecord[]> {
  const { results } = await db.prepare(
    "SELECT " + INVOCATION_COLUMNS + " FROM invocations WHERE state IN ('queued','expired') ORDER BY queued_at, invocation_id LIMIT ?1"
  ).bind(limit).all<InvocationRecord>();
  return results;
}

export function invocationInsertStatement(
  db: D1Database,
  descriptor: InvocationDescriptor,
  sourceEventKey: string,
  queuedAt: number,
): D1PreparedStatement {
  return db.prepare([
    'INSERT INTO invocations (invocation_id, wake_key, cycle_id, task_id, role, principal_id, endpoint_id, reason,',
    ' source_revision, source_event_seq, source_event_hash, input_hash, payload_hash, target_repository, target_head, target_base,',
    ' state, attempt_count, consecutive_failures, queued_at, leased_at, running_at, finished_at, lease_owner, lease_expires_at,',
    ' output_hash, last_error, usage_input_tokens, usage_output_tokens, usage_operations, cost_microunits, evidence_refs)',
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT seq FROM events WHERE idempotency_key = ?10),",
    " ?11, ?12, ?13, ?14, ?15, ?16, 'queued', 0, 0, ?17, NULL, NULL, NULL, '', NULL, '', '', 0, 0, 0, 0, ?18)",
  ].join(' ')).bind(
    descriptor.invocation_id,
    descriptor.wake_key,
    descriptor.cycle_id,
    descriptor.task_id,
    descriptor.role,
    descriptor.principal_id,
    descriptor.endpoint_id,
    descriptor.reason,
    descriptor.source_revision,
    sourceEventKey,
    descriptor.source_event_hash,
    descriptor.input_hash,
    descriptor.payload_hash,
    descriptor.target_repository ?? '',
    descriptor.target_head ?? '',
    descriptor.target_base ?? '',
    queuedAt,
    JSON.stringify(descriptor.evidence_refs),
  );
}

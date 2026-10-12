import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { InvocationService, runSimulatedInvocation } from '../../../src/collab-store/invocations';
import { enqueue, uniqueCycle } from './helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC-4 A1 — simulated executor, provenance and retry stop', () => {
  it('lost response is recovered by rereading terminal state before any new attempt', async () => {
    const cycle = uniqueCycle('lost-response');
    const { invocation } = await enqueue(db, cycle, { input: '{"bounded":"packet"}' });
    const service = new InvocationService(db, { now: () => new Date('2026-12-20T12:00:00Z') });

    const first = await runSimulatedInvocation(service, invocation.wake_key, {
      output: '{"result":"ok"}',
      usage: { input_tokens: 11, output_tokens: 5, operations: 2 },
      evidence_refs: ['test:a1-success'],
    });
    expect(first.status).toBe('succeeded');
    expect(first.invocation).toMatchObject({
      state: 'succeeded',
      principal_id: 'agent:a',
      endpoint_id: 'simulated-a1',
      role: 'owner',
      task_id: 't1',
      cycle_id: cycle,
      attempt_count: 1,
      usage_input_tokens: 11,
      usage_output_tokens: 5,
      usage_operations: 2,
      cost_microunits: 0,
    });
    expect(first.invocation.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.invocation.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.invocation.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    // Simulate a caller that lost the first HTTP response: running again rereads
    // D1, sees succeeded, and never leases attempt 2.
    const retry = await runSimulatedInvocation(service, invocation.wake_key, { output: 'must-not-run' });
    expect(retry.status).toBe('terminal');
    expect(retry.invocation.attempt_count).toBe(1);

    const attempt = await db.prepare(
      'SELECT state, output_hash, usage_input_tokens, usage_output_tokens, usage_operations, cost_microunits, evidence_refs FROM invocation_attempts WHERE invocation_id = ?1 AND attempt_no = 1'
    ).bind(invocation.invocation_id).first<{
      state: string; output_hash: string; usage_input_tokens: number; usage_output_tokens: number;
      usage_operations: number; cost_microunits: number; evidence_refs: string;
    }>();
    expect(attempt).toMatchObject({
      state: 'succeeded',
      output_hash: first.invocation.output_hash,
      usage_input_tokens: 11,
      usage_output_tokens: 5,
      usage_operations: 2,
      cost_microunits: 0,
    });
    expect(JSON.parse(attempt?.evidence_refs ?? '[]')).toEqual(['test:a1-success']);
  });

  it('two consecutive simulated failures move the invocation to failed and prevent a third attempt', async () => {
    const cycle = uniqueCycle('fail-stop');
    const { invocation } = await enqueue(db, cycle);
    const service = new InvocationService(db, { now: () => new Date('2026-12-21T12:00:00Z') });

    const first = await runSimulatedInvocation(service, invocation.wake_key, { fail_with: 'simulated failure 1' });
    expect(first).toMatchObject({ status: 'attempt_failed', invocation: { state: 'queued', consecutive_failures: 1, attempt_count: 1 } });
    const second = await runSimulatedInvocation(service, invocation.wake_key, { fail_with: 'simulated failure 2' });
    expect(second).toMatchObject({ status: 'attempt_failed', invocation: { state: 'failed', consecutive_failures: 2, attempt_count: 2 } });
    const third = await runSimulatedInvocation(service, invocation.wake_key, { output: 'must-not-run' });
    expect(third).toMatchObject({ status: 'terminal', invocation: { state: 'failed', attempt_count: 2 } });
  });
});

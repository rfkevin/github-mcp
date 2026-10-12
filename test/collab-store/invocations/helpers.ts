import { CollabStore, type AppendEventInput } from '../../../src/collab-store/store/collab-store';
import type { InvocationIntent } from '../../../src/collab-store/invocations';

let counter = 0;

export function uniqueCycle(label: string): string {
  counter += 1;
  return ('a1-' + label + '-' + counter).slice(0, 64);
}

export function sourceEvent(cycle: string, op = 1, expectedRev = 0, payload = '{"action":"wake"}'): AppendEventInput {
  return {
    cycle_id: cycle,
    type: 'checkpoint',
    participant_id: 'agent:a',
    expected_rev: expectedRev,
    payload_json: payload,
    op_id: 'agent.a:' + cycle + ':wake:' + op,
  };
}

export function invocationIntent(
  cycle: string,
  sourceRevision = 1,
  input = '{"packet":"a1"}',
  overrides: Partial<InvocationIntent> = {},
): InvocationIntent {
  return {
    cycle_id: cycle,
    task_id: 't1',
    role: 'owner',
    principal_id: 'agent:a',
    endpoint_id: 'simulated-a1',
    reason: 'task_actionable',
    source_revision: sourceRevision,
    input_packet: input,
    target_repository: 'rfkevin/github-mcp',
    target_head: '',
    target_base: '',
    evidence_refs: ['github-mcp#112'],
    ...overrides,
  };
}

export async function enqueue(
  db: D1Database,
  cycle: string,
  options: { now?: () => Date; input?: string } = {},
) {
  const store = new CollabStore(db, { dailyWriteLimit: 100_000, now: options.now });
  const result = await store.appendActionableEvent(
    sourceEvent(cycle),
    invocationIntent(cycle, 1, options.input),
  );
  if (result.status !== 'applied' || !result.invocation) throw new Error('fixture enqueue failed');
  return { store, result, invocation: result.invocation };
}

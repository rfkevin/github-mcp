import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createCollabToolContext, type CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';

// Registre local cloné de test/mcp/tool-registry.ts, typé pour le contexte C2.
const bindings = env as unknown as { COLLAB_DB_C2: D1Database };
type Result = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function registry(context: CollabToolContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerCollabStoreTools({
    registerTool(name: string, spec: {
      inputSchema: z.ZodRawShape;
      outputSchema: z.ZodRawShape;
    }, handler: Handler) {
      handlers.set(name, async (input) => {
        const result = await handler(z.object(spec.inputSchema).parse(input));
        if (!result.isError) z.object(spec.outputSchema).parse(result.structuredContent);
        return result;
      });
    },
  } as unknown as McpServer, context);
  return handlers;
}

let counter = 0;
let day = 0;

function makeContext(dailyWriteLimit = 100_000): CollabToolContext {
  counter += 1;
  day += 1;
  const stamp = '2026-11-' + String(day).padStart(2, '0') + 'T10:00:00.000Z';
  return createCollabToolContext(
    { COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true', COLLAB_DAILY_WRITE_LIMIT: String(dailyWriteLimit) },
    'agent:vibe', ['collab:'], { now: () => new Date(stamp) });
}

function cycle(label: string): string {
  return ('c2m-' + label + '-' + counter).slice(0, 64);
}

function appendInput(cycleId: string, expectedRev: number, op: string, payload = '{"n":1}') {
  return {
    cycle: cycleId, expected_rev: expectedRev, op_id: 't:' + cycleId + ':' + op,
    type: 'checkpoint', participant_id: 'agent:a', payload_json: payload,
  };
}

describe('CC-3 C2 — outils collab_* (registre local)', () => {
  it('collab_append_event applique puis rejoue en duplicate (même seq)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('dup');
    const first = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent.status).toBe('applied');
    const retry = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(retry.structuredContent.status).toBe('duplicate');
    expect((retry.structuredContent.event as { seq: number }).seq)
      .toBe((first.structuredContent.event as { seq: number }).seq);
  });

  it('STALE : expected_rev périmé renvoie code, currentRevision et delta', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('stale');
    const result = await handlers.get('collab_append_event')!(appendInput(cycleId, 5, 'cp:1'));
    expect(result.isError).toBe(true);
    const error = (result.structuredContent.error as { code: string; retryable: boolean });
    expect(error.code).toBe('STALE');
    expect(error.retryable).toBe(false);
    expect(result.structuredContent.currentRevision).toBe(0);
    expect(result.structuredContent.delta).toEqual([]);
  });

  it('QUOTA_EXHAUSTED après la limite quotidienne, sans écriture', async () => {
    const handlers = registry(makeContext(1));
    const cycleId = cycle('quota');
    const first = await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    expect(first.isError).toBeFalsy();
    const second = await handlers.get('collab_append_event')!(appendInput(cycleId, 1, 'cp:2'));
    expect(second.isError).toBe(true);
    expect((second.structuredContent.error as { code: string }).code).toBe('QUOTA_EXHAUSTED');
    const delta = await handlers.get('collab_get_delta')!({ cycle: cycleId, since_seq: 0, limit: 10 });
    expect((delta.structuredContent.events as unknown[])).toHaveLength(1);
  });

  it('OWNER_DECISION_FORBIDDEN : owner.decision refusé aux agents (I7)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('owner');
    const result = await handlers.get('collab_append_event')!({
      ...appendInput(cycleId, 0, 'own:1'), type: 'owner.decision',
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('OWNER_DECISION_FORBIDDEN');
  });

  it('DUPLICATE_TASK_ROLE via task.claim (D12 à l\'écriture)', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('d12');
    const result = await handlers.get('collab_append_event')!({
      cycle: cycleId, expected_rev: 0, op_id: 't:' + cycleId + ':claim:1', type: 'task.claim',
      participant_id: 'agent:a',
      payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: 'agent:a', reviewer_pid: 'agent:a', tester_pid: 'agent:b' } }),
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('DUPLICATE_TASK_ROLE');
  });

  it('UNKNOWN_CYCLE sur collab_get_context', async () => {
    const handlers = registry(makeContext());
    const result = await handlers.get('collab_get_context')!({ cycle: 'c2m-ghost-999' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('UNKNOWN_CYCLE');
  });

  it('aller-retour : append ×2 puis get_delta par curseur', async () => {
    const handlers = registry(makeContext());
    const cycleId = cycle('roundtrip');
    await handlers.get('collab_append_event')!(appendInput(cycleId, 0, 'cp:1'));
    await handlers.get('collab_append_event')!(appendInput(cycleId, 1, 'cp:2'));
    const delta = await handlers.get('collab_get_delta')!({ cycle: cycleId, since_seq: 0, limit: 10 });
    expect((delta.structuredContent.events as unknown[])).toHaveLength(2);
    expect(delta.structuredContent.hasMore).toBe(false);
  });
});

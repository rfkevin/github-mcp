import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createCollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';

// CC-3 C5 — l'identité dérivée du jeton est appliquée par les outils collab_* (réserve de revue C2).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
type Result = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
let n = 0;
const uniq = (label: string) => `c5t-${label}-${++n}`;

function tools(clientId: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const context = createCollabToolContext({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' }, '123', ['collab:'], {}, clientId);
  registerCollabStoreTools({
    registerTool(name: string, spec: { inputSchema: z.ZodRawShape; outputSchema: z.ZodRawShape }, handler: Handler) {
      handlers.set(name, async input => {
        const result = await handler(z.object(spec.inputSchema).parse(input));
        if (!result.isError) z.object(spec.outputSchema).parse(result.structuredContent);
        return result;
      });
    },
  } as unknown as McpServer, context);
  return handlers;
}

const errorCode = (result: Result) => (result.structuredContent.error as { code: string }).code;

describe('CC-3 C5 — identité appliquée par les outils collab_*', () => {
  it('client enregistré : écrit sous son identité, refusé sous une autre', async () => {
    const pid = uniq('p');
    const client = uniq('client');
    await registerParticipant(db, { participant_id: pid, display_label: 'P', proof, op: uniq('op') });
    await mapClient(db, { oauth_client_id: client, participant_id: pid, proof, op: uniq('op') });
    const handlers = tools(client);
    const cycle = uniq('cycle');
    const own = await handlers.get('collab_append_event')!({ cycle, expected_rev: 0, op_id: `x:${cycle}:cp:1`,
      type: 'checkpoint', participant_id: pid, payload_json: '{}' });
    expect(own.structuredContent.status).toBe('applied');
    const other = await handlers.get('collab_append_event')!({ cycle, expected_rev: 1, op_id: `x:${cycle}:cp:2`,
      type: 'checkpoint', participant_id: 'agent:a', payload_json: '{}' });
    expect(other.isError).toBe(true);
    expect(errorCode(other)).toBe('PARTICIPANT_MISMATCH');
    const context = await handlers.get('collab_get_context')!({ cycle });
    expect(context.structuredContent).toMatchObject({ participant_id: pid, caller: { participant_id: pid, status: 'registered' } });
    const forged = await handlers.get('collab_append_event')!({ cycle, expected_rev: 1, op_id: `x:${cycle}:forge:1`,
      type: 'owner.decision', participant_id: pid, payload_json: '{"request_id":"r","decision":"approve"}' });
    expect(errorCode(forged)).toBe('OWNER_DECISION_FORBIDDEN');
  });

  it('client non enregistré : owner.request seulement, sous son pseudonyme', async () => {
    const handlers = tools(uniq('stranger'));
    const cycle = uniq('cycle');
    // L'identité s'obtient en lisant un cycle existant ; on la crée via une demande owner.
    const probe = await handlers.get('collab_append_event')!({ cycle, expected_rev: 0, op_id: `x:${cycle}:probe:1`,
      type: 'owner.request', participant_id: 'agent:a', payload_json: '{"request_id":"r1"}' });
    expect(errorCode(probe)).toBe('PARTICIPANT_MISMATCH');
    const self = (probe.structuredContent.error as { message: string }).message.match(/unregistered:[0-9a-f]{16}/)?.[0];
    expect(self).toBeTruthy();
    const request = await handlers.get('collab_append_event')!({ cycle, expected_rev: 0, op_id: `x:${cycle}:req:1`,
      type: 'owner.request', participant_id: self, payload_json: '{"request_id":"r1","summary":"accès"}' });
    expect(request.structuredContent.status).toBe('applied');
    const claim = await handlers.get('collab_append_event')!({ cycle, expected_rev: 1, op_id: `x:${cycle}:cp:1`,
      type: 'checkpoint', participant_id: self, payload_json: '{}' });
    expect(errorCode(claim)).toBe('UNREGISTERED_CLIENT');
    const context = await handlers.get('collab_get_context')!({ cycle });
    expect(context.structuredContent.caller).toEqual({ participant_id: self, status: 'unregistered' });
  });
});

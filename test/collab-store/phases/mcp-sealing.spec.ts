import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createCollabToolContext, type CollabToolContext } from '../../../src/collab-store/mcp/context';
import { registerCollabStoreTools } from '../../../src/collab-store/mcp/tools';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
type Result = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function registry(context: CollabToolContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
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

describe('CC-3 C3 — sealing through collab tools', () => {
  it('proposal.submit never leaks P1 plaintext through collab_get_delta, then reveals after phase opening', async () => {
    await ensureSchema(db, true);
    const cycle = 'c3-mcp-seal-' + Date.now();
    await db.prepare(
      "INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, 'P1', 1, 'open')"
    ).bind(cycle).run();
    const handlers = registry(createCollabToolContext(
      { COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', COLLAB_DAILY_WRITE_LIMIT: '100000' },
      'agent:sol',
      ['collab:'],
      { now: () => new Date('2026-10-08T00:00:00Z') },
    ));
    const append = await handlers.get('collab_append_event')!({
      cycle,
      expected_rev: 1,
      op_id: 'sol:' + cycle + ':proposal:1',
      type: 'proposal.submit',
      participant_id: 'sol',
      role: 'author',
      payload_json: JSON.stringify({ content: 'agree' }),
    });
    expect(append.isError).toBeFalsy();

    const hidden = await handlers.get('collab_get_delta')!({ cycle, since_seq: 0, limit: 10 });
    const hiddenText = JSON.stringify(hidden.structuredContent);
    expect(hiddenText).not.toContain('agree');
    const event = (hidden.structuredContent.events as Array<{ payload_json: string }>)[0];
    const metadata = JSON.parse(event.payload_json) as { sealed_id: string; content_hash: string };
    expect(metadata.sealed_id).toBeTruthy();
    expect(metadata.content_hash).toHaveLength(64);

    await db.prepare('UPDATE sealed_items SET revealed_at = 1 WHERE id = ?1').bind(metadata.sealed_id).run();
    const revealed = await handlers.get('collab_get_delta')!({ cycle, since_seq: 0, limit: 10 });
    const revealedText = JSON.stringify(revealed.structuredContent);
    expect(revealedText).toContain('agree');
    expect(revealedText).toContain('nonce');
  });
});

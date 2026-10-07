import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-3 C5 — R1 : aucun outil MCP ni chemin GitHub ne peut produire owner.decision.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const OWNER_WRITE = /INSERT INTO (owner_decisions|participants|participant_clients)\b|'owner\.decision',\s*\?|VALUES \([^)]*'owner\.decision'/;

async function sources(): Promise<Array<[string, string]>> {
  const modules = import.meta.glob('../../../src/**/*.ts', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
  return Promise.all(Object.entries(modules).map(async ([path, load]) => [path, await load()] as [string, string]));
}

describe('CC-3 C5 — aucun chemin agent vers owner.decision', () => {
  it('seul src/collab-store/owner/ écrit les décisions et le registre', async () => {
    const writers = (await sources()).filter(([, content]) => OWNER_WRITE.test(content)).map(([path]) => path);
    expect(writers.length).toBeGreaterThan(0);
    for (const path of writers) expect(path).toMatch(/src\/collab-store\/owner\//);
  });

  it('aucun outil des catalogues /mcp et /collab/mcp ne vise le canal owner', async () => {
    const names: string[] = [];
    for (const [path, scope] of [['/mcp', 'mcp:read offline_access'], ['/collab/mcp', 'mcp:read collab: offline_access']]) {
      const fixture = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true',
        OWNER_AUTH_MODE: 'secret', OWNER_SECRET: 'owner-secret-0123456789abcdefghijklmn' });
      const session = await fixture.mcpSession(scope, 'http://localhost:4321/callback', fixture.ORIGIN + path);
      const response = await fixture.send(path, { method: 'POST', headers: session.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      names.push(...(fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> }).tools.map(tool => tool.name));
    }
    expect(names.length).toBeGreaterThan(3);
    expect(names.filter(name => /owner|decision|registry|participant/i.test(name))).toEqual([]);
  });

  it('un jeton collab: ne peut pas forger owner.decision, ni en se déclarant owner ni sous sa propre identité', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const append = async (args: Record<string, unknown>) => fixture.rpcResult(await (await fixture.send('/collab/mcp', {
      method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'collab_append_event', arguments: args } }),
    })).text()) as { isError?: boolean; structuredContent: { error: { code: string; message: string } } };
    const base = { cycle: 'c5-forge', expected_rev: 0, type: 'owner.decision', payload_json: '{"request_id":"x","decision":"approve"}' };
    const asOwner = await append({ ...base, op_id: 'c:c5-forge:x:1', participant_id: 'owner' });
    expect(asOwner.structuredContent.error.code).toBe('PARTICIPANT_MISMATCH');
    const self = asOwner.structuredContent.error.message.match(/unregistered:[0-9a-f]{16}/)![0];
    const asSelf = await append({ ...base, op_id: 'c:c5-forge:x:2', participant_id: self });
    expect(asSelf.structuredContent.error.code).toBe('UNREGISTERED_CLIENT');
    // Client enregistré : OWNER_DECISION_FORBIDDEN (tool-binding.spec et decisions.spec).
    await ensureSchema(db);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = 'c5-forge'").first<{ n: number }>())?.n).toBe(0);
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';

// CC-3 C2 : isolement des catalogues. Le store est monté sur COLLAB_DB_C2
// (schéma canonique) ; COLLAB_DB garde le schéma proto C0 et n'est pas utilisé.
const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

describe('CC-3 C2 — isolement des catalogues /collab/mcp', () => {
  it('le catalogue GitHub est strictement inchangé (aucun outil collab_*)', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession();
    const response = await fixture.send('/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    const names = result.tools.map(tool => tool.name);
    expect(names.filter(name => name.startsWith('collab_'))).toEqual([]);
    expect(names).toContain('github_collab_context');
  });

  it('le scope collab: expose exactement les 3 outils du store', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> };
    expect(result.tools.map(tool => tool.name).sort())
      .toEqual(['collab_append_event', 'collab_get_context', 'collab_get_delta']);
  });

  it('sans le scope collab:, /collab/mcp refuse l\'accès', async () => {
    const fixture = createOAuthFixture({ COLLAB_DB: bindings.COLLAB_DB_C2, COLLAB_STORE_ENABLED: 'true' });
    const session = await fixture.mcpSession('mcp:read offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('sans le flag COLLAB_STORE_ENABLED, /collab/mcp n\'est pas monté (fail-closed)', async () => {
    const fixture = createOAuthFixture({});
    const session = await fixture.mcpSession();
    const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect([404, 503]).toContain(response.status);
  });
});

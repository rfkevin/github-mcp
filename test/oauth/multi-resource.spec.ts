import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';

// C7/K6: one issuer must complete the same OAuth flow for both MCP resources.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const fixture = createOAuthFixture({
  COLLAB_STORE_ENABLED: 'true',
  COLLAB_DB: db,
  GITHUB_WRITES_ENABLED: 'true',
  GITHUB_CHECKS_CONFIG: JSON.stringify([{ repository: 'test/repo', ref: 'master', controllerSha: 'a'.repeat(40) }]),
});
const { ORIGIN, send, consent, mcpSession, rpcResult } = fixture;
const githubResource = `${ORIGIN}/mcp`;
const collabResource = `${ORIGIN}/collab/mcp`;

describe('CC-3: OAuth multi-resource sur un même Worker', () => {
  it('annonce deux ressources distinctes et le scope minimal collab:', async () => {
    const auth = await send('/.well-known/oauth-authorization-server');
    expect(auth.status).toBe(200);
    expect(await auth.json()).toMatchObject({ issuer: ORIGIN });

    const github = await send('/.well-known/oauth-protected-resource/mcp');
    expect(github.status).toBe(200);
    expect(await github.json()).toMatchObject({ resource: githubResource });

    const collab = await send('/.well-known/oauth-protected-resource/collab/mcp');
    expect(collab.status).toBe(200);
    expect(await collab.json()).toMatchObject({
      resource: collabResource,
      scopes_supported: ['collab:'],
    });
  });

  it('accepte la demande Grok pour collab même lorsque le client énumère les scopes de GitHub', async () => {
    // The user supplied the exact resource and scope string from a production failure.
    const authorization = await consent(
      'mcp:read offline_access mcp:checks mcp:write mcp:integration collab:',
      'https://grok.com/connectors-oauth-exchange-code/',
      collabResource,
    );
    expect(authorization.page.status).toBe(200);
    expect(authorization.html).toContain('collab:');
  });

  it('termine la connexion Grok avec la liste complète de scopes demandés', async () => {
    const { headers } = await mcpSession(
      'mcp:read offline_access mcp:checks mcp:write mcp:integration collab:',
      'https://grok.com/connectors-oauth-exchange-code/', collabResource,
    );
    const listed = await send('/collab/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).toContain('collab_get_context');
    expect(text).not.toContain('github_commit_changes');
    expect((await send('/mcp', { method: 'POST', headers, body: '{}' })).status).toBe(401);
  });

  it('termine GET authorize, POST authorize, GitHub callback et token exchange sur collab', async () => {
    const { headers } = await mcpSession(
      'collab: offline_access', 'https://grok.com/connectors-oauth-exchange-code/', collabResource,
    );
    const catalogue = await send('/collab/mcp', {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(catalogue.status, await catalogue.clone().text()).toBe(200);
    const tools = rpcResult(await catalogue.text()).tools as Array<{ name: string }>;
    expect(tools.some(tool => tool.name === 'collab_get_context')).toBe(true);
    expect(tools.some(tool => tool.name.startsWith('github_'))).toBe(false);

    // Resource-bound tokens must never grant access to another protected resource.
    const wrongResource = await send('/mcp', { method: 'POST', headers, body: '{}' });
    expect(wrongResource.status).toBe(401);
  });

  it('préserve le parcours GitHub existant et bloque son jeton sur le store', async () => {
    const { headers } = await mcpSession('mcp:read offline_access', 'http://localhost:4321/callback', githubResource);
    const collab = await send('/collab/mcp', { method: 'POST', headers, body: '{}' });
    expect(collab.status).toBe(401);
    const github = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(github.status).toBe(200);
  });

  it('rejette une ressource inconnue et ne journalise pas les paramètres OAuth', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registration = await send('/oauth/register', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        client_name: 'isolated-client', redirect_uris: ['https://grok.com/callback'],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }) });
    expect(registration.status).toBe(201);
    const { client_id } = await registration.json() as { client_id: string };
    const query = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: 'https://grok.com/callback',
      code_challenge_method: 'S256',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      state: 'private-state-canary', resource: `${ORIGIN}/another-resource`, scope: 'collab:',
    });
    const refused = await send(`/authorize?${query}`);
    expect(refused.status).toBe(400);
    const logs = spy.mock.calls.flat().join(' ');
    expect(logs).toContain('resource_invalid');
    expect(logs).not.toContain('private-state-canary');
    expect(logs).not.toContain(client_id);
  });
});

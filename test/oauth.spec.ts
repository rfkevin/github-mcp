import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { AppEnv } from '../src/config';
import { codeChallenge } from '../src/auth/github';

const ORIGIN = 'https://github-mcp.example';
const settings: AppEnv = { ...env, PUBLIC_ORIGIN: ORIGIN, ALLOWED_GITHUB_USER_IDS: '123',
  GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: 'test-only-not-a-key',
  GITHUB_OAUTH_CLIENT_ID: 'test-client', GITHUB_OAUTH_CLIENT_SECRET: 'test-secret' };

async function send(path: string, init: RequestInit = {}, bindings = settings): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  headers.set('Host', new URL(ORIGIN).host);
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function cookie(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

async function consent() {
  const registration = await send('/oauth/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: '<script>untrusted</script>', redirect_uris: ['http://localhost:4321/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }) });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = 'test-verifier-'.repeat(5);
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:4321/callback',
    response_type: 'code', scope: 'mcp:read offline_access', state: 'client-state',
    code_challenge: await codeChallenge(verifier), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
  const page = await send(`/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).not.toContain('<script>');
  expect(html).toContain('localhost');
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return { client, verifier, page, handle: handle! };
}

afterEach(() => vi.restoreAllMocks());
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('Paire de clés attendue.');
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  if (!(der instanceof ArrayBuffer)) throw new Error('Export PKCS#8 attendu.');
  settings.GITHUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
});

describe('Worker OAuth / MCP', () => {
  it('répond au contrôle de santé avec la configuration locale', async () => {
    expect((await SELF.fetch('https://example.com/health')).status).toBe(200);
    expect((await SELF.fetch('https://example.com/mcp')).status).toBe(503);
  });

  it.each([undefined, 'Bearer fake-token'])('refuse un accès sans jeton valide (%s)', async authorization => {
    const response = await send('/mcp', { headers: authorization ? { Authorization: authorization } : {} });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });

  it('publie la découverte OAuth sans données privées', async () => {
    const response = await send('/.well-known/oauth-protected-resource/mcp');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp` });
  });

  it('refuse une approbation sans le cookie du navigateur', async () => {
    const { handle, page } = await consent();
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await send('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    const cookieValue = cookie(page);
    const entries = diagnostic.mock.calls.map(([entry]) => String(entry));
    expect(entries).toContain(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: 'authorize.approve_consent',
      reason: 'browser_binding_missing',
    }));
    expect(entries.join('\n')).not.toContain(handle);
    expect(entries.join('\n')).not.toContain(cookieValue);
  });

  it('distingue un handle de consentement absent', async () => {
    const { page } = await consent();
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await send('/authorize', {
      method: 'POST',
      headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ decision: 'approve' }),
    });

    expect(response.status).toBe(400);
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: 'authorize.approve_consent',
      reason: 'consent_handle_missing',
    }));
  });

  it('traite un handle de type fichier comme absent', async () => {
    const { page } = await consent();
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const form = new FormData();
    form.append('handle', new File(['not-a-handle'], 'handle.txt'));
    form.append('decision', 'approve');
    const response = await send('/authorize', {
      method: 'POST',
      headers: { Cookie: cookie(page) },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: 'authorize.approve_consent',
      reason: 'consent_handle_missing',
    }));
  });

  it('distingue une transaction de consentement déjà consommée', async () => {
    const { handle, page } = await consent();
    const headers = { Cookie: cookie(page) };
    const form = new URLSearchParams({ handle, decision: 'approve' });
    const first = await send('/authorize', { method: 'POST', headers, body: form });
    expect(first.status).toBe(302);

    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replay = await send('/authorize', { method: 'POST', headers, body: form });

    expect(replay.status).toBe(400);
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: 'authorize.approve_consent',
      reason: 'consent_transaction_expired_or_used',
    }));
  });

  it('permet de refuser le consentement', async () => {
    const { handle, page } = await consent();
    const response = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'deny' }) });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('refuse un callback forgé sans contacter GitHub', async () => {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const response = await send('/callback?code=forged&state=forged');
    expect(response.status).toBe(400);
    expect(network).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls.map(([entry]) => String(entry)).join('\n')).not.toContain('forged');
  });

  it.each([123, 999])('valide le parcours OAuth pour l’utilisateur %s', async userId => {
    const { handle, page, client, verifier } = await consent();
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const github = new URL(approved.headers.get('Location')!);
    expect(github.origin).toBe('https://github.com');
    expect(github.searchParams.get('code_challenge_method')).toBe('S256');
    const upstreamState = github.searchParams.get('state')!;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'private-upstream-token' });
      if (url === 'https://api.github.com/user') return Response.json({ id: userId });
      throw new Error('Unexpected network request');
    });
    const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`, {
      headers: { Cookie: cookie(approved) },
    });
    expect(callback.status).toBe(302);
    expect(network).toHaveBeenCalledTimes(2);
    network.mockRestore();
    const location = new URL(callback.headers.get('Location')!);
    expect(location.searchParams.get('state')).toBe('client-state');
    if (userId === 999) {
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.has('code')).toBe(false);
      return;
    }
    const response = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id, code: location.searchParams.get('code')!,
      redirect_uri: 'http://localhost:4321/callback', code_verifier: verifier, resource: `${ORIGIN}/mcp`,
    }) });
    expect(response.status).toBe(200);
    const token = await response.json() as { access_token: string };
    const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
    const initialized = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
      } }) });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('github-mcp');
    const listed = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await listed.text()).toContain('github_list_repositories');
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/installation/repositories')) return Response.json({ repositories: [{ full_name: 'owner/private' }] });
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});
    const called = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'github_list_repositories', arguments: {} } }) });
    expect(called.status).toBe(200);
    expect(await called.text()).toContain('owner/private');
    expect(api).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github', action: 'list_repositories', outcome: 'success' }));
    api.mockRestore();
    const removed = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) },
      { ...settings, ALLOWED_GITHUB_USER_IDS: '888' });
    expect(removed.status).toBe(403);
  });
});

import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { AppEnv } from '../src/config';
import { codeChallenge } from '../src/auth/github';
import { consentPolicy } from '../src/auth/consent';
import { textFileResponse } from './git-fixtures';
import { MANAGED_WORKFLOW, WORKFLOW_PATH, EXECUTE_STEP } from '../src/automation/workflow';
import { PLAN_PATH } from '../src/automation/plan';
import { automationKey } from '../src/automation/coordinator';

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

describe('sonde de disponibilité réelle', () => {
  it('identifie le paquet configuré sans confondre health et ready', async () => {
    const sha = 'a'.repeat(40);
    const response = await send('/ready', {}, { ...settings, BUILD_SHA: sha });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', sha });
    expect((await send('/ready', {}, { ...settings, GITHUB_PRIVATE_KEY: '' })).status).toBe(503);
    expect((await send('/health', {}, { ...settings, GITHUB_PRIVATE_KEY: '' })).status).toBe(200);
    expect((await send('/ready', {}, { ...settings, BUILD_SHA: 'invalid' })).status).toBe(503);
  });
});

function cookie(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

async function consent(scope = 'mcp:read offline_access') {
  const registration = await send('/oauth/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      client_name: '<script>untrusted</script>', redirect_uris: ['http://localhost:4321/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }) });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = 'test-verifier-'.repeat(5);
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:4321/callback',
    response_type: 'code', scope, state: 'client-state',
    code_challenge: await codeChallenge(verifier), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
  const page = await send(`/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).not.toContain('<script>');
  expect(html).toContain('localhost');
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return { client, verifier, page, html, handle: handle! };
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
  it('autorise les destinations du formulaire sans élargir les autres protections CSP', async () => {
    const { page } = await consent();
    expect(page.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; form-action 'self' https://github.com http://localhost:4321; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.headers.get('Cache-Control')).toBe('no-store');
    expect(cookie(page)).toContain('__Host-oauth-consent-');
  });

  it('limite le retour Claude à son origine, sans chemin ni paramètres', () => {
    expect(consentPolicy('https://claude.ai/api/mcp/auth_callback?state=private')).toBe(
      "default-src 'none'; form-action 'self' https://github.com https://claude.ai; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it.each(['https://*.example.com/callback', 'https://example.com;unsafe/callback', 'custom-app://callback'])
  ('ne copie pas une expression CSP ou un protocole arbitraire : %s', uri => {
    expect(consentPolicy(uri)).toBe(
      "default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
    );
  });

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

  it.each([
    {
      failure: 'token',
      phase: 'callback.github_token_exchange',
      reason: 'github_token_bad_verification_code',
    },
    {
      failure: 'identity',
      phase: 'callback.github_user_lookup',
      reason: 'github_user_http_error',
      httpStatus: 401,
    },
    {
      failure: 'timeout',
      phase: 'callback.github_token_exchange',
      reason: 'github_token_network_error',
      fetchFailure: { kind: 'timeout' },
    },
    {
      failure: 'network_code',
      phase: 'callback.github_token_exchange',
      reason: 'github_token_network_error',
      fetchFailure: { kind: 'other', code: 'ECONNRESET' },
    },
    {
      failure: 'redirect',
      phase: 'callback.github_token_exchange',
      reason: 'github_token_redirect_rejected',
      httpStatus: 302,
      fetchFailure: { kind: 'redirect_rejected', redirectTarget: 'github_token_endpoint' },
    },
    {
      failure: 'user_redirect_external',
      phase: 'callback.github_user_lookup',
      reason: 'github_user_redirect_rejected',
      httpStatus: 302,
      fetchFailure: { kind: 'redirect_rejected', redirectTarget: 'external_origin' },
    },
    {
      failure: 'user_redirect_path',
      phase: 'callback.github_user_lookup',
      reason: 'github_user_redirect_rejected',
      httpStatus: 302,
      fetchFailure: { kind: 'redirect_rejected', redirectTarget: 'github_api_other_path' },
    },
  ] as const)('diagnostique sans fuite un échec GitHub pendant $failure', async failureCase => {
    const { handle, page } = await consent();
    const approved = await send('/authorize', {
      method: 'POST',
      headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }),
    });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const oneTimeCode = 'test-one-time-code-must-not-be-logged';
    const privateErrorDescription = 'private-upstream-description-must-not-be-logged';
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        if (failureCase.failure === 'timeout') {
          throw new DOMException(privateErrorDescription, 'TimeoutError');
        }
        if (failureCase.failure === 'network_code') {
          const cause = Object.assign(new Error(privateErrorDescription), { code: 'ECONNRESET' });
          throw Object.assign(new TypeError(privateErrorDescription), { cause });
        }
        if (failureCase.failure === 'redirect') {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `https://github.com/login/oauth/access_token?error_description=${encodeURIComponent(privateErrorDescription)}`,
            },
          });
        }
        if (failureCase.failure === 'token') {
          return Response.json({ error: 'bad_verification_code', error_description: privateErrorDescription });
        }
        return Response.json({ access_token: 'private-upstream-token' });
      }
      if (url === 'https://api.github.com/user') {
        if (failureCase.failure === 'user_redirect_external') {
          return new Response(null, { status: 302, headers: {
            Location: `https://example.invalid/authorize?next=${encodeURIComponent(privateErrorDescription)}`,
          } });
        }
        if (failureCase.failure === 'user_redirect_path') {
          return new Response(null, { status: 302, headers: {
            Location: `https://api.github.com/user/emails?access_token=${encodeURIComponent(privateErrorDescription)}`,
          } });
        }
        return Response.json({ message: privateErrorDescription }, { status: 401 });
      }
      throw new Error('Unexpected network request');
    });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const callback = await send(
      `/callback?code=${encodeURIComponent(oneTimeCode)}&state=${encodeURIComponent(upstreamState)}`,
      { headers: { Cookie: cookie(approved) } },
    );
    const diagnosticText = diagnostic.mock.calls.map(([entry]) => String(entry)).join('\n');

    expect(callback.status).toBe(503);
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: failureCase.phase,
      reason: failureCase.reason,
      ...('httpStatus' in failureCase ? { httpStatus: failureCase.httpStatus } : {}),
      ...('fetchFailure' in failureCase ? { fetchFailure: failureCase.fetchFailure } : {}),
    }));
    expect(network).toHaveBeenCalledTimes(failureCase.phase === 'callback.github_user_lookup' ? 2 : 1);
    expect(diagnosticText).not.toContain(oneTimeCode);
    expect(diagnosticText).not.toContain('private-upstream-token');
    expect(diagnosticText).not.toContain(privateErrorDescription);
  });

  it('suit une redirection unique vers le point d’entrée /user', async () => {
    const { handle, page } = await consent();
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    let userCalls = 0;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'private-upstream-token' });
      }
      if (url.startsWith('https://api.github.com/user')) {
        userCalls += 1;
        if (userCalls === 1) {
          return new Response(null, { status: 302, headers: { Location: 'https://api.github.com/user/' } });
        }
        return Response.json({ id: 123 });
      }
      throw new Error('Unexpected network request');
    });

    const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`, {
      headers: { Cookie: cookie(approved) },
    });

    expect(callback.status).toBe(302);
    expect(network.mock.calls.map(([input]) => String(input))).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user',
      'https://api.github.com/user/',
    ]);
    const location = new URL(callback.headers.get('Location')!);
    expect(location.searchParams.has('code')).toBe(true);
    expect(location.searchParams.has('error')).toBe(false);
  });

  it('refuse une seconde redirection du point d’entrée /user', async () => {
    const { handle, page } = await consent();
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'private-upstream-token' });
      }
      if (url.startsWith('https://api.github.com/user')) {
        return new Response(null, { status: 302, headers: { Location: 'https://api.github.com/user' } });
      }
      throw new Error('Unexpected network request');
    });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`, {
      headers: { Cookie: cookie(approved) },
    });

    expect(callback.status).toBe(503);
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
      event: 'oauth_flow_failure',
      phase: 'callback.github_user_lookup',
      reason: 'github_user_redirect_rejected',
      httpStatus: 302,
      fetchFailure: { kind: 'redirect_rejected', redirectTarget: 'github_api_user_endpoint' },
    }));
    expect(network).toHaveBeenCalledTimes(3);
    expect(diagnostic.mock.calls.map(([entry]) => String(entry)).join('\n'))
      .not.toContain('private-upstream-token');
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

  it('explique un refus de redirection GitHub sans exposer la destination', async () => {
    const { handle, page } = await consent();
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const canary = 'destination-must-not-be-revealed';
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(null, { status: 302, headers: {
          Location: `https://example.invalid/authorize?next=${encodeURIComponent(canary)}`,
        } });
      }
      throw new Error('Unexpected network request');
    });
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const callback = await send(
      `/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`,
      { headers: { Cookie: cookie(approved) } },
    );
    const body = await callback.text();
    const log = diagnostic.mock.calls.map(([entry]) => String(entry)).join('\n');

    expect(callback.status).toBe(503);
    expect(callback.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toContain('redirection GitHub inattendue a été refusée par sécurité');
    expect(body).not.toContain(canary);
    expect(body).not.toContain('example.invalid');
    expect(log).toContain('"reason":"github_token_redirect_rejected"');
    expect(log).toContain('"redirectTarget":"external_origin"');
    expect(log).not.toContain(canary);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('journalise un échec d’outil avec un motif classé et sans message brut', async () => {
    const { handle, page, client, verifier } = await consent();
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const identity = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'private-upstream-token' });
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
      throw new Error('Unexpected network request');
    });
    const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`,
      { headers: { Cookie: cookie(approved) } });
    expect(callback.status).toBe(302);
    identity.mockRestore();

    const tokenResponse = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id,
      code: new URL(callback.headers.get('Location')!).searchParams.get('code')!,
      redirect_uri: 'http://localhost:4321/callback', code_verifier: verifier, resource: `${ORIGIN}/mcp`,
    }) });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string };
    const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/installation/repositories')) {
        return Response.json({ message: 'rate limited' },
          { status: 429, headers: { 'x-ratelimit-remaining': '0' } });
      }
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});
    const initialized = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1' },
      } }) });
    expect(initialized.status).toBe(200);

    const called = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'github_list_repositories', arguments: {} } }) });
    const body = await called.text();

    expect(called.status).toBe(200);
    expect(body).toMatch(/Limite de requ(?:\\u00ea|ê)tes GitHub atteinte/);
    expect(body).not.toContain('rate limited');
    expect(api).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({
      actor: '123', service: 'github', action: 'list_repositories', outcome: 'error', reason: 'rate_limited',
    }));
  });

  async function mcpSession(scope = 'mcp:read offline_access'): Promise<{ headers: Record<string, string> }> {
    const { handle, page, client, verifier } = await consent(scope);
    const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    expect(approved.status).toBe(302);
    const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const identity = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'private-upstream-token' });
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
      throw new Error('Unexpected network request');
    });
    const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`,
      { headers: { Cookie: cookie(approved) } });
    identity.mockRestore();
    expect(callback.status).toBe(302);

    const tokenResponse = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id,
      code: new URL(callback.headers.get('Location')!).searchParams.get('code')!,
      redirect_uri: 'http://localhost:4321/callback', code_verifier: verifier, resource: `${ORIGIN}/mcp`,
    }) });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as { access_token: string };

    return { headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' } };
  }

  async function callTool(
    headers: Record<string, string>,
    name: string,
    args: unknown,
    id: number,
  ): Promise<{ status: number; body: string }> {
    const response = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: await response.text() };
  }

  function contentsFile(path: string, content: string): Response {
    return Response.json({ type: 'file', encoding: 'base64', path, sha: 'c'.repeat(40),
      size: content.length, content: btoa(String.fromCodePoint(...new TextEncoder().encode(content))) });
  }

  it('n’accorde pas run_checks aux jetons de lecture existants même après activation serveur', async () => {
    const { headers } = await mcpSession();
    settings.GITHUB_CHECKS_CONFIG = JSON.stringify([{ repository: 'owner/project', ref: 'master', controllerSha: 'a'.repeat(40) }]);
    try {
      const listed = await send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      expect(await listed.text()).not.toContain('github_run_checks');
      const api = vi.spyOn(globalThis, 'fetch');
      const result = await callTool(headers, 'github_run_checks', { repository: 'owner/project', sha: 'b'.repeat(40) }, 2);
      expect(result.body).not.toContain('runId');
      expect(api).not.toHaveBeenCalled();
    } finally { delete settings.GITHUB_CHECKS_CONFIG; }
  });

  it('expose run_checks seulement après consentement explicite et le retire à la désactivation', async () => {
    settings.GITHUB_CHECKS_CONFIG = JSON.stringify([{ repository: 'owner/project', ref: 'master', controllerSha: 'a'.repeat(40) }]);
    try {
      const approval = await consent('mcp:read mcp:checks offline_access');
      expect(approval.html).toContain('minutes GitHub Actions');
      const { headers } = await mcpSession('mcp:read mcp:checks offline_access');
      const list = () => send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      expect(await (await list()).text()).toContain('github_run_checks');
      delete settings.GITHUB_CHECKS_CONFIG;
      expect(await (await list()).text()).not.toContain('github_run_checks');
    } finally { delete settings.GITHUB_CHECKS_CONFIG; }
  });

  it('le mode multi-dépôts ne donne aucun pouvoir nouveau aux anciens jetons', async () => {
    const { headers } = await mcpSession();
    settings.GITHUB_AUTOMATION_ENABLED = 'true';
    try {
      const listed = await send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      expect(await listed.text()).not.toContain('github_prepare_checks');
      const api = vi.spyOn(globalThis, 'fetch');
      await callTool(headers, 'github_prepare_checks', {}, 2);
      expect(api).not.toHaveBeenCalled();
    } finally { delete settings.GITHUB_AUTOMATION_ENABLED; }
  });

  it('le nouveau consentement expose les vérifications et la désactivation les retire', async () => {
    settings.GITHUB_AUTOMATION_ENABLED = 'true';
    try {
      const approval = await consent('mcp:read mcp:automation offline_access');
      expect(approval.html).toContain('y compris ceux ajoutés ultérieurement');
      const { headers } = await mcpSession('mcp:read mcp:automation offline_access');
      const list = () => send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const text = await (await list()).text();
      expect(text).toContain('github_prepare_checks');
      expect(text).toContain('github_run_checks');
      expect(text).not.toContain('github_commit_changes');
      const result = await callTool(headers, 'github_prepare_checks', {
        repository: 'other/workbench', branch: 'mcp/123/test', expectedHeadSha: 'a'.repeat(40),
        plan: { version: 1, checks: { quick: ['npm test'] } }, apply: true,
      }, 2);
      expect(result.body).toContain('WRITES_NOT_ENABLED');
      settings.GITHUB_AUTOMATION_ENABLED = 'false';
      expect(await (await list()).text()).not.toContain('github_run_checks');
    } finally { delete settings.GITHUB_AUTOMATION_ENABLED; }
    expect((await send('/ready', {}, { ...settings, GITHUB_AUTOMATION_ENABLED: 'yes' })).status).toBe(503);
  });

  it('parcours multi-dépôts MCP : préparation atomique, premier run push et dispatch corrélé', async () => {
    settings.GITHUB_AUTOMATION_ENABLED = 'true';
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const { headers } = await mcpSession('mcp:read mcp:automation mcp:write offline_access');
      const repository = 'other/workbench', branch = 'mcp/123/test';
      const base = 'a'.repeat(40), next = 'b'.repeat(40), workflowBlob = 'c'.repeat(40), planBlob = 'd'.repeat(40);
      const tree = 'e'.repeat(40), githubTree = '1'.repeat(40), mcpTree = '2'.repeat(40), workflowsTree = '3'.repeat(40);
      const plan = { version: 1, workingDirectory: '.', install: [], checks: { quick: ['python3 -m unittest'], lint: ['python3 -m compileall src'] } };
      const planContent = JSON.stringify(plan, null, 2) + '\n';
      let head = base, principalHasWorkflow = false;
      const bodies: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
      const permissions: unknown[] = [];
      const push = { id: 7, path: WORKFLOW_PATH, head_sha: next, head_branch: branch, event: 'push',
        display_title: `mcp-checks/${next}/quick/push`, status: 'completed', conclusion: 'success', html_url: 'https://github.com/other/workbench/actions/runs/7' };
      let manualTitle = '';
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input)), method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.pathname.endsWith('/access_tokens')) { permissions.push(body.permissions); return Response.json({ token: 'installation-token' }); }
        if (method !== 'GET') bodies.push({ method, path: url.pathname, body });
        if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ full_name: repository }] });
        if (url.pathname === `/repos/${repository}`) return Response.json({ full_name: repository, default_branch: 'main' });
        if (url.pathname.includes('/git/ref/heads/')) return Response.json({ object: { sha: head } });
        if (url.pathname.endsWith(`/git/commits/${base}`)) return Response.json({ tree: { sha: tree } });
        if (url.pathname.endsWith('/git/trees') && method === 'POST') return Response.json({ sha: tree });
        if (url.pathname.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: next });
        if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH') { head = next; return Response.json({}); }
        if (url.pathname.endsWith(`/git/trees/${base}`) || url.pathname.endsWith(`/git/trees/${tree}`)) return Response.json({ tree: [], truncated: false });
        if (url.pathname.endsWith(`/git/trees/${next}`)) return Response.json({ tree: [
          { path: '.github', type: 'tree', mode: '040000', sha: githubTree },
          { path: '.mcp', type: 'tree', mode: '040000', sha: mcpTree },
        ] });
        if (url.pathname.endsWith(`/git/trees/${githubTree}`)) return Response.json({ tree: [{ path: 'workflows', type: 'tree', mode: '040000', sha: workflowsTree }] });
        if (url.pathname.endsWith(`/git/trees/${workflowsTree}`)) return Response.json({ tree: [{ path: 'mcp-checks.yml', type: 'blob', mode: '100644', sha: workflowBlob, size: new TextEncoder().encode(MANAGED_WORKFLOW).length }] });
        if (url.pathname.endsWith(`/git/trees/${mcpTree}`)) return Response.json({ tree: [{ path: 'checks.json', type: 'blob', mode: '100644', sha: planBlob, size: planContent.length }] });
        if (url.pathname.endsWith(`/git/blobs/${workflowBlob}`)) return contentsFile(WORKFLOW_PATH, MANAGED_WORKFLOW);
        if (url.pathname.endsWith(`/git/blobs/${planBlob}`)) return contentsFile(PLAN_PATH, planContent);
        if (url.pathname.includes('/commits/')) return Response.json({ sha: url.pathname.endsWith('/main') ? (principalHasWorkflow ? next : base) : next });
        if (url.pathname.endsWith('/actions/runs')) return Response.json({ workflow_runs: [push] });
        if (url.pathname.endsWith('/jobs')) return Response.json({ jobs: [{ id: 1, name: 'checks', status: 'completed', conclusion: 'success',
          steps: [{ name: EXECUTE_STEP, status: 'completed', conclusion: 'success' }] }] });
        if (url.pathname.endsWith('/actions/runs/7')) return Response.json(push);
        if (url.pathname.endsWith('/actions/runs/8')) return Response.json({ ...push, id: 8, event: 'workflow_dispatch', display_title: manualTitle, head_branch: 'main' });
        if (url.pathname.endsWith('/dispatches')) {
          manualTitle = `mcp-checks/${next}/lint/${(body.inputs as Record<string, string>).request_id}`;
          return Response.json({ workflow_run_id: 8, html_url: 'https://github.com/other/workbench/actions/runs/8' });
        }
        throw new Error('Unexpected GitHub request');
      });
      const preview = await callTool(headers, 'github_prepare_checks', { repository, branch, expectedHeadSha: base, plan }, 1);
      expect(toolJson(preview.body)).toMatchObject({ applied: false, changedPaths: [WORKFLOW_PATH, PLAN_PATH] });
      expect(bodies).toEqual([]);
      const applied = await callTool(headers, 'github_prepare_checks', { repository, branch, expectedHeadSha: base, plan, apply: true }, 2);
      expect(toolJson(applied.body)).toMatchObject({ applied: true, commitSha: next });
      expect(bodies.map(item => item.method)).toEqual(['POST', 'POST', 'PATCH']);
      expect(bodies[0].body).toMatchObject({ tree: [{ path: WORKFLOW_PATH, content: MANAGED_WORKFLOW }, { path: PLAN_PATH, content: planContent }] });
      const reused = await callTool(headers, 'github_run_checks', { repository, ref: branch }, 3);
      expect(toolJson(reused.body)).toMatchObject({ reused: true, runId: 7, sha: next });
      const success = await callTool(headers, 'github_get_agent_check_result', { repository, sha: next, runId: 7 }, 4);
      expect(toolJson(success.body)).toMatchObject({ verifiedSuccess: true, targetSha: next });
      principalHasWorkflow = true;
      const dispatched = await callTool(headers, 'github_run_checks', { repository, ref: branch, scope: 'lint' }, 5);
      expect(toolJson(dispatched.body)).toMatchObject({ reused: false, runId: 8 });
      const verified = await callTool(headers, 'github_get_agent_check_result', { repository, sha: next, scope: 'lint', runId: 8 }, 6);
      expect(toolJson(verified.body)).toMatchObject({ verifiedSuccess: true });
      expect(bodies.at(-1)?.body).toEqual({ ref: 'main', inputs: {
        target_sha: next, scope: 'lint', target: '', request_id: await automationKey({ repository, sha: next, scope: 'lint', target: '' }),
      } });
      expect(permissions).toContainEqual({ metadata: 'read', contents: 'write', workflows: 'write' });
      expect(permissions).toContainEqual({ metadata: 'read', actions: 'write' });
      expect(JSON.stringify(permissions)).not.toContain('administration');
    } finally { delete settings.GITHUB_AUTOMATION_ENABLED; delete settings.GITHUB_WRITES_ENABLED; }
  });

  /** Décode la chaîne SSE → JSON-RPC → JSON du texte d'outil. */
  function toolJson<T>(body: string): T {
    const data = (body.split('\n').find(line => line.startsWith('data: ')) ?? `data: ${body}`)
      .slice('data: '.length);
    const envelope = JSON.parse(data) as { result?: { content?: Array<{ text?: string }> } };
    return JSON.parse(envelope.result?.content?.[0]?.text ?? '{}') as T;
  }

  it('les anciens consentements de lecture ne gagnent aucun outil d’écriture', async () => {
    const { headers } = await mcpSession();
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const listed = await send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const text = await listed.text();
      expect(listed.status).toBe(200);
      expect(text).toContain('github_read_file');
      const api = vi.spyOn(globalThis, 'fetch');
      for (const name of ['github_create_branch', 'github_commit_changes', 'github_open_pull_request']) {
        expect(text).not.toContain(name);
        const result = await callTool(headers, name, {}, 2);
        expect(result.body).toContain('error');
      }
      expect(api).not.toHaveBeenCalled();
    } finally { delete settings.GITHUB_WRITES_ENABLED; }
  });

  it('sépare lecture, écriture et intégration pour des clients simultanés, et transmet la démarche centrale', async () => {
    settings.GITHUB_WRITES_ENABLED = 'true';
    settings.GITHUB_AUTOMATION_ENABLED = 'true';
    try {
      const read = await mcpSession('mcp:read offline_access');
      const write = await mcpSession('mcp:read mcp:write offline_access');
      const full = await mcpSession('mcp:read mcp:write mcp:automation mcp:integration offline_access');
      const list = async (headers: Record<string, string>) => {
        const response = await send('/mcp', { method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
        expect(response.status).toBe(200);
        const text = await response.text();
        const envelope = JSON.parse((text.split('\n').find(line => line.startsWith('data: ')) ?? `data: ${text}`).slice(6));
        return (envelope.result.tools as Array<{ name: string }>).map(tool => tool.name);
      };
      expect(await list(read.headers)).toHaveLength(15);
      expect(await list(write.headers)).toHaveLength(20);
      expect(await list(full.headers)).toHaveLength(24);
      expect(await list(write.headers)).not.toContain('github_merge_integration');
      const initialized = await send('/mcp', { method: 'POST', headers: read.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'read-only-client', version: '1' } } }) });
      const text = await initialized.text();
      expect(text).toContain('TOOL_IMPROVEMENTS.md');
      expect(text).toContain('rfkevin/github-mcp');
      const api = vi.spyOn(globalThis, 'fetch');
      for (const name of ['github_commit_changes', 'github_comment_commit', 'github_comment_pull_request', 'github_merge_integration', 'github_run_checks']) {
        expect((await callTool(read.headers, name, {}, 2)).body).toContain('error');
      }
      expect(api).not.toHaveBeenCalled();
      const page = await consent('mcp:read mcp:write mcp:integration offline_access');
      expect(page.html).toContain('uniquement vers integration');
      expect(page.html).toContain('Des noms différents ne prouvent pas');
      settings.GITHUB_WRITES_ENABLED = 'false';
      expect(await list(full.headers)).not.toContain('github_merge_integration');
    } finally { delete settings.GITHUB_WRITES_ENABLED; delete settings.GITHUB_AUTOMATION_ENABLED; }
  });

  it('exige le consentement d’écriture, avertit des automatismes et retire les outils à la désactivation', async () => {
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const approval = await consent('mcp:read mcp:write offline_access');
      expect(approval.html).toContain('suppressions de fichiers');
      expect(approval.html).toContain('déploiements automatiques');
      const { headers } = await mcpSession('mcp:read mcp:write offline_access');
      const list = () => send('/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const text = await (await list()).text();
      for (const name of ['github_create_branch', 'github_commit_changes', 'github_open_pull_request']) expect(text).toContain(name);
      for (const name of ['github_run_checks', 'github_merge_pull_request', 'github_delete_branch', 'github_deploy']) expect(text).not.toContain(name);
      settings.GITHUB_WRITES_ENABLED = 'false';
      expect(await (await list()).text()).not.toContain('github_commit_changes');
      const api = vi.spyOn(globalThis, 'fetch');
      await callTool(headers, 'github_create_branch', { repository: 'owner/project', task: 'fix', expectedBaseSha: 'a'.repeat(40) }, 2);
      expect(api).not.toHaveBeenCalled();
    } finally { delete settings.GITHUB_WRITES_ENABLED; }
  });

  it('une configuration d’écriture mal formée est refusée', async () => {
    const result = await send('/.well-known/oauth-authorization-server', {}, { ...settings, GITHUB_WRITES_ENABLED: 'yes' });
    expect(result.status).toBe(503);
  });

  it('parcours MCP simulé : branche, commit atomique puis PR brouillon avec jetons minimaux', async () => {
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const { headers } = await mcpSession('mcp:read mcp:write offline_access');
      const base = 'a'.repeat(40), blob = 'b'.repeat(40), next = 'c'.repeat(40), tree = 'd'.repeat(40);
      let head = base;
      const branch = 'mcp/123/fix';
      const tokenPermissions: unknown[] = [];
      const mutations: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.pathname.endsWith('/access_tokens')) {
          tokenPermissions.push(body.permissions);
          return Response.json({ token: 'installation-token' });
        }
        if (method !== 'GET') mutations.push({ path: url.pathname, method, body });
        if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ full_name: 'owner/project' }] });
        if (url.pathname === '/repos/owner/project') return Response.json({ full_name: 'owner/project', default_branch: 'master' });
        if (url.pathname.includes('/git/ref/heads/')) return Response.json({ object: { sha: head } });
        if (url.pathname.endsWith('/git/refs') && method === 'POST') return Response.json({ ref: `refs/heads/${branch}` });
        if (url.pathname.endsWith(`/git/commits/${base}`)) return Response.json({ tree: { sha: tree } });
        if (url.pathname.endsWith(`/git/trees/${tree}`)) return Response.json({ truncated: false, tree: [
          { path: 'src', type: 'tree', mode: '040000', sha: tree },
          { path: 'src/app.ts', type: 'blob', mode: '100644', sha: blob },
          { path: 'old.ts', type: 'blob', mode: '100644', sha: blob },
        ] });
        if (url.pathname.endsWith('/git/trees') && method === 'POST') return Response.json({ sha: tree });
        if (url.pathname.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: next });
        if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH') { head = next; return Response.json({}); }
        if (url.pathname.endsWith('/pulls') && method === 'POST') return Response.json({ number: 42,
          html_url: 'https://github.com/owner/project/pull/42', draft: true, head: { ref: branch, sha: head }, base: { ref: 'master' } });
        throw new Error('Unexpected GitHub request');
      });
      const created = await callTool(headers, 'github_create_branch',
        { repository: 'owner/project', task: 'fix', expectedBaseSha: base }, 1);
      expect(toolJson(created.body)).toMatchObject({ branch, sha: base });
      const committed = await callTool(headers, 'github_commit_changes', { repository: 'owner/project', branch,
        expectedHeadSha: base, message: 'Fix', changes: [{ path: 'src/app.ts', content: 'new', expectedSha: blob }],
        deletions: [{ path: 'old.ts', expectedSha: blob }] }, 2);
      expect(toolJson(committed.body)).toMatchObject({ branch, commitSha: next, deletedPaths: ['old.ts'] });
      const opened = await callTool(headers, 'github_open_pull_request',
        { repository: 'owner/project', branch, expectedHeadSha: next, title: 'Fix' }, 3);
      expect(toolJson(opened.body)).toMatchObject({ number: 42, draft: true, headMatchesExpected: true });
      expect(mutations.map(item => item.method)).toEqual(['POST', 'POST', 'POST', 'PATCH', 'POST']);
      expect(mutations[0].body).toEqual({ ref: `refs/heads/${branch}`, sha: base });
      expect(mutations[1].body).toMatchObject({ base_tree: tree,
        tree: [{ path: 'src/app.ts', content: 'new' }, { path: 'old.ts', sha: null }] });
      expect(mutations[2].body).toMatchObject({ parents: [base] });
      expect(mutations[3].body).toEqual({ sha: next, force: false });
      expect(mutations[4].body).toMatchObject({ draft: true, head: branch, base: 'master' });
      expect(tokenPermissions).toContainEqual({ metadata: 'read', contents: 'write' });
      expect(tokenPermissions).toContainEqual({ metadata: 'read', pull_requests: 'write' });
      expect(JSON.stringify(tokenPermissions)).not.toContain('actions');
    } finally { delete settings.GITHUB_WRITES_ENABLED; }
  });

  it('expose les outils de lecture avec des jetons aux permissions distinctes', async () => {
    const { headers } = await mcpSession();
    const tokenBodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) {
        tokenBodies.push(String(init?.body ?? ''));
        return Response.json({ token: 'installation-token' });
      }
      if (url.includes('/installation/repositories')) {
        return Response.json({ repositories: [{ full_name: 'owner/private' }] });
      }
      const file = textFileResponse(url, 'src/app.ts', 'Bonjour le monde');
      if (file) return file;
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const initialized = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } } }) });
    expect(initialized.status).toBe(200);
    const listed = await send('/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const catalogue = await listed.text();

    for (const name of ['github_list_repositories', 'github_get_project_guide', 'github_read_file',
      'github_list_directory', 'github_search_code', 'github_compare_refs', 'github_ci_status']) {
      expect(catalogue).toContain(name);
    }

    expect((await callTool(headers, 'github_list_repositories', {}, 2)).status).toBe(200);
    const read = await callTool(headers, 'github_read_file',
      { repository: 'owner/project', path: 'src/app.ts', ref: 'main' }, 3);

    expect(read.status).toBe(200);
    expect(read.body).toContain('Bonjour le monde');
    expect(tokenBodies.some(body => body.includes('"contents":"read"'))).toBe(true);
    expect(tokenBodies.some(body => body.includes('"metadata":"read"') && !body.includes('contents')))
      .toBe(true);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'read_file', outcome: 'success' }));
  });

  it('masque les entrées sensibles et refuse de lire un fichier sensible', async () => {
    const { headers } = await mcpSession();
    const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/contents')) {
        return Response.json([
          { name: '.env', path: '.env', type: 'file', size: 10, sha: 'd'.repeat(40) },
          { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'e'.repeat(40) },
        ]);
      }
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const listing = await callTool(headers, 'github_list_directory',
      { repository: 'owner/project', path: '', ref: 'main' }, 1);
    expect(listing.status).toBe(200);
    const listed = toolJson<{ entries: Array<{ name: string }> }>(listing.body);
    expect(listed.entries.map(entry => entry.name)).toEqual(['src']);
    expect(listing.body).not.toContain('.env');

    const refused = await callTool(headers, 'github_read_file',
      { repository: 'owner/project', path: '.env', ref: 'main' }, 2);
    expect(refused.body).toContain('sensible');
    expect(api).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'read_file', outcome: 'error', reason: 'invalid_request' }));
  });

  it('compare_refs résume le diff et omet les patchs trop volumineux', async () => {
    const { headers } = await mcpSession();
    let round = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/compare/')) {
        round += 1;
        return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
          commits: [{ sha: 'f'.repeat(40), html_url: 'https://example.invalid/commit',
            commit: { message: 'Fix login\n\nDetails internes', author: { date: '2026-09-29T00:00:00Z' } } }],
          files: [{ filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 1,
            patch: round === 1 ? 'CANARY-PATCH petit' : `CANARY-PATCH ${'x'.repeat(200_000)}` }] });
      }
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const small = await callTool(headers, 'github_compare_refs',
      { repository: 'owner/project', base: 'main', head: 'mcp/test/fix' }, 1);
    expect(small.body).toContain('CANARY-PATCH petit');
    expect(small.body).not.toContain('Details internes');
    const diff = toolJson<{ commits: Array<{ message: string }>; files: Array<{ patch?: string }> }>(small.body);
    expect(diff.commits[0].message).toBe('Fix login');
    expect(diff.files[0].patch).toBe('CANARY-PATCH petit');

    const big = await callTool(headers, 'github_compare_refs',
      { repository: 'owner/project', base: 'main', head: 'mcp/test/fix' }, 2);
    const huge = toolJson<{ patchesOmitted?: boolean; files: Array<Record<string, unknown>> }>(big.body);
    expect(huge.patchesOmitted).toBe(true);
    expect(huge.files[0]).not.toHaveProperty('patch');
    expect(big.body).not.toContain('CANARY-PATCH');
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'compare_refs', outcome: 'success' }));
  });

  it('ci_status agrège contrôles, statut combiné et exécutions', async () => {
    const { headers } = await mcpSession();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/check-runs')) {
        return Response.json({ check_runs: [{ id: 1, name: 'GitGuardian Security Checks',
          status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/check/1' }] });
      }
      if (url.includes('/status')) return Response.json({ state: 'success', total_count: 1,
        statuses: [{ context: 'external', state: 'success', description: null }] });
      if (url.includes('/actions/runs')) {
        return Response.json({ workflow_runs: [{ id: 7, name: 'Workers Builds', status: 'completed',
          conclusion: 'success', head_branch: 'mcp/test/fix', head_sha: 'a'.repeat(40), event: 'push',
          html_url: 'https://example.invalid/run/7', created_at: '2026-09-29T00:00:00Z' }] });
      }
      if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const status = await callTool(headers, 'github_ci_status',
      { repository: 'owner/project', ref: 'mcp/test/fix' }, 1);

    expect(status.status).toBe(200);
    const report = toolJson<{
      combinedState: string;
      checks: Array<{ name: string }>;
      runs: Array<{ name: string }>;
    }>(status.body);
    expect(report.combinedState).toBe('success');
    expect(report.checks.map(check => check.name)).toContain('GitGuardian Security Checks');
    expect(report.runs.map(run => run.name)).toContain('Workers Builds');
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'ci_status', outcome: 'success' }));
  });

  it('get_project_guide livre les documents présents et signale les absents', async () => {
    const { headers } = await mcpSession();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      const file = textFileResponse(url, 'AGENTS.md', '# Règles du dépôt');
      if (file) return file;
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const guide = await callTool(headers, 'github_get_project_guide',
      { repository: 'owner/project', ref: 'main' }, 1);
    const payload = toolJson<{ documents: Array<{ path: string; content?: string; missing?: boolean }> }>(
      guide.body,
    );

    expect(payload.documents.find(document => document.path === 'AGENTS.md')?.content)
      .toContain('Règles');
    expect(payload.documents.filter(document => document.missing)).toHaveLength(4);
    expect(payload.documents.some(document => document.path === 'AGENT_MEMORY.md' && document.missing)).toBe(true);
    expect(payload.documents.some(document => document.path === 'README.md' && document.missing))
      .toBe(true);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'get_project_guide', outcome: 'success' }));
  });

  it('search_code exclut les chemins sensibles des résultats', async () => {
    const { headers } = await mcpSession();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/search/code')) {
        return Response.json({ incomplete_results: false, total_count: 2, items: [
          { name: 'app.ts', path: 'src/app.ts', sha: 'a'.repeat(40), html_url: 'https://example.invalid/app', repository: { full_name: 'owner/project' } },
          { name: '.env', path: '.env', sha: 'b'.repeat(40), html_url: 'https://example.invalid/env', repository: { full_name: 'owner/project' } },
        ] });
      }
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const search = await callTool(headers, 'github_search_code',
      { repository: 'owner/project', query: 'token' }, 1);
    const payload = toolJson<{ matches: Array<{ path: string }> }>(search.body);

    expect(payload.matches.map(match => match.path)).toEqual(['src/app.ts']);
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'search_code', outcome: 'success' }));
  });

  it.each([true, false])('search_code expose au client une recherche vide, incomplete=%s', async incomplete => {
    const { headers } = await mcpSession();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/search/code')) return Response.json({ items: [], total_count: 0,
        incomplete_results: incomplete });
      throw new Error('Unexpected GitHub request');
    });
    const response = await callTool(headers, 'github_search_code',
      { repository: 'owner/project', query: 'jose' }, 1);
    const result = toolJson<{ matches: unknown[]; incompleteResults: boolean; note: string }>(response.body);
    expect(result).toMatchObject({ matches: [], incompleteResults: incomplete });
    expect(result.note).toContain(incomplete ? 'Recherche GitHub incomplète' : 'ne prouve pas l’absence');
    if (incomplete) expect(result.note).toContain('github_read_files');
  });

  it('tronque les fichiers longs et garde un motif fermé sur les erreurs GitHub', async () => {
    const { headers } = await mcpSession();
    let round = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url.includes('/git/blobs/')) {
        round += 1;
        if (round === 1) return contentsFile('big.txt', 'x'.repeat(90_000));
        return Response.json({ message: 'Server Error on https://api.github.com/private' }, { status: 500 });
      }
      const file = textFileResponse(url, 'big.txt', 'x'.repeat(90_000));
      if (file) return file;
      throw new Error('Unexpected GitHub request');
    });
    const audit = vi.spyOn(console, 'log').mockImplementation(() => {});

    const long = await callTool(headers, 'github_read_file',
      { repository: 'owner/project', path: 'big.txt', ref: 'main' }, 1);
    const truncated = toolJson<{ content: string; truncated: boolean }>(long.body);

    expect(truncated.truncated).toBe(true);
    expect(truncated.content).toHaveLength(80_000);

    const failed = await callTool(headers, 'github_read_file',
      { repository: 'owner/project', path: 'big.txt', ref: 'main' }, 2);

    expect(failed.body).not.toContain('api.github.com');
    expect(failed.body).toContain('Impossible de lire ce fichier.');
    expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
      action: 'read_file', outcome: 'error', reason: 'github_api_500' }));
  });
});

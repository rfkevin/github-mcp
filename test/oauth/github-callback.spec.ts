import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';
const { ORIGIN, settings, send, cookie, consent } = createOAuthFixture();
describe('Callback GitHub et validation d’identité', () => {
    it('refuse un callback forgé sans contacter GitHub', async () => {
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
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
    ] as const)('diagnostique sans fuite un échec GitHub pendant $failure', async (failureCase) => {
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
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
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
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const callback = await send(`/callback?code=${encodeURIComponent(oneTimeCode)}&state=${encodeURIComponent(upstreamState)}`, { headers: { Cookie: cookie(approved) } });
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
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
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
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token') {
                return Response.json({ access_token: 'private-upstream-token' });
            }
            if (url.startsWith('https://api.github.com/user')) {
                return new Response(null, { status: 302, headers: { Location: 'https://api.github.com/user' } });
            }
            throw new Error('Unexpected network request');
        });
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
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
    it.each([123, 999])('valide le parcours OAuth pour l’utilisateur %s', async (userId) => {
        const { handle, page, client, verifier } = await consent();
        const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ handle, decision: 'approve' }) });
        expect(approved.status).toBe(302);
        const github = new URL(approved.headers.get('Location')!);
        expect(github.origin).toBe('https://github.com');
        expect(github.searchParams.get('code_challenge_method')).toBe('S256');
        const upstreamState = github.searchParams.get('state')!;
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token')
                return Response.json({ access_token: 'private-upstream-token' });
            if (url === 'https://api.github.com/user')
                return Response.json({ id: userId });
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
        const token = await response.json() as {
            access_token: string;
        };
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
        const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/installation/repositories'))
                return Response.json({ repositories: [{ full_name: 'owner/private' }] });
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const called = await send('/mcp', { method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'github_list_repositories', arguments: {} } }) });
        expect(called.status).toBe(200);
        expect(await called.text()).toContain('owner/private');
        expect(api).toHaveBeenCalledTimes(2);
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github', action: 'list_repositories', outcome: 'success' }));
        api.mockRestore();
        const removed = await send('/mcp', { method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, { ...settings, ALLOWED_GITHUB_USER_IDS: '888' });
        expect(removed.status).toBe(403);
    });
    it('explique un refus de redirection GitHub sans exposer la destination', async () => {
        const { handle, page } = await consent();
        const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ handle, decision: 'approve' }) });
        expect(approved.status).toBe(302);
        const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
        const canary = 'destination-must-not-be-revealed';
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token') {
                return new Response(null, { status: 302, headers: {
                        Location: `https://example.invalid/authorize?next=${encodeURIComponent(canary)}`,
                    } });
            }
            throw new Error('Unexpected network request');
        });
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`, { headers: { Cookie: cookie(approved) } });
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
});

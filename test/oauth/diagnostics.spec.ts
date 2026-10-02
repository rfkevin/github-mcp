import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';
const { ORIGIN, send, cookie, consent } = createOAuthFixture();
describe('Erreurs d’outil et diagnostics fermés', () => {
    it('journalise un échec d’outil avec un motif classé et sans message brut', async () => {
        const { handle, page, client, verifier } = await consent();
        const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ handle, decision: 'approve' }) });
        expect(approved.status).toBe(302);
        const upstreamState = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
        const identity = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url === 'https://github.com/login/oauth/access_token') {
                return Response.json({ access_token: 'private-upstream-token' });
            }
            if (url === 'https://api.github.com/user')
                return Response.json({ id: 123 });
            throw new Error('Unexpected network request');
        });
        const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(upstreamState)}`, { headers: { Cookie: cookie(approved) } });
        expect(callback.status).toBe(302);
        identity.mockRestore();
        const tokenResponse = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
                grant_type: 'authorization_code', client_id: client.client_id,
                code: new URL(callback.headers.get('Location')!).searchParams.get('code')!,
                redirect_uri: 'http://localhost:4321/callback', code_verifier: verifier, resource: `${ORIGIN}/mcp`,
            }) });
        expect(tokenResponse.status).toBe(200);
        const token = await tokenResponse.json() as {
            access_token: string;
        };
        const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' };
        const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/installation/repositories')) {
                return Response.json({ message: 'rate limited' }, { status: 429, headers: { 'x-ratelimit-remaining': '0' } });
            }
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
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
});

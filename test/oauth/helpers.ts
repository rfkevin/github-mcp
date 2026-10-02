import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, expect, vi } from 'vitest';
import worker from '../../src/index';
import type { AppEnv } from '../../src/config';
import { codeChallenge } from '../../src/auth/github';
// Assert the permission boundary by names, without repeating global tool counts.
export const READ_TOOLS = ['github_list_repositories', 'github_get_project_guide', 'github_read_file',
    'github_list_directory', 'github_search_code', 'github_get_commit', 'github_compare_refs', 'github_ci_status',
    'github_get_check_result', 'github_get_failure_report', 'github_get_quality_report', 'github_read_files',
    'github_get_project_context', 'github_list_pull_requests', 'github_get_pull_request', 'github_list_issues', 'github_get_issue', 'github_get_merge_context'];
export const WRITE_TOOLS = ['github_comment_commit', 'github_comment_pull_request', 'github_comment_issue', 'github_create_branch',
    'github_commit_changes', 'github_open_pull_request', 'github_replace_text', 'github_restore_file', 'github_append_file', 'github_create_issue', 'github_resolve_conflicts'];
// A separate fixture is created by each spec; mocks and bindings stay local.
export function createOAuthFixture() {
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
    async function consent(scope = 'mcp:read offline_access', redirectUri = 'http://localhost:4321/callback') {
        const registration = await send('/oauth/register', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
                client_name: '<script>untrusted</script>', redirect_uris: [redirectUri],
                token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
            }) });
        expect(registration.status).toBe(201);
        const client = await registration.json() as {
            client_id: string;
        };
        const verifier = 'test-verifier-'.repeat(5);
        const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri,
            response_type: 'code', scope, state: 'client-state',
            code_challenge: await codeChallenge(verifier), code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
        const page = await send(`/authorize?${query}`);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).not.toContain('<script>');
        expect(html).toContain(new URL(redirectUri).hostname);
        const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
        expect(handle).toBeTruthy();
        return { client, verifier, page, html, handle: handle! };
    }
    afterEach(() => vi.restoreAllMocks());
    beforeAll(async () => {
        const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
        if (!('privateKey' in pair))
            throw new Error('Paire de clés attendue.');
        const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
        if (!(der instanceof ArrayBuffer))
            throw new Error('Export PKCS#8 attendu.');
        settings.GITHUB_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    });
    async function mcpSession(scope = 'mcp:read offline_access', redirectUri = 'http://localhost:4321/callback'): Promise<{
        headers: Record<string, string>;
    }> {
        const { handle, page, client, verifier } = await consent(scope, redirectUri);
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
        identity.mockRestore();
        expect(callback.status).toBe(302);
        const tokenResponse = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
                grant_type: 'authorization_code', client_id: client.client_id,
                code: new URL(callback.headers.get('Location')!).searchParams.get('code')!,
                redirect_uri: redirectUri, code_verifier: verifier, resource: `${ORIGIN}/mcp`,
            }) });
        expect(tokenResponse.status).toBe(200);
        const token = await tokenResponse.json() as {
            access_token: string;
        };
        return { headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' } };
    }
    function rpcResult(body: string): Record<string, unknown> {
        const json = body.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? body;
        const envelope = JSON.parse(json) as {
            result?: Record<string, unknown>;
            error?: unknown;
        };
        expect(envelope.error).toBeUndefined();
        expect(envelope.result).toBeDefined();
        return envelope.result!;
    }
    async function callTool(headers: Record<string, string>, name: string, args: unknown, id: number): Promise<{
        status: number;
        body: string;
    }> {
        const response = await send('/mcp', { method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
        return { status: response.status, body: await response.text() };
    }
    function contentsFile(path: string, content: string): Response {
        return Response.json({ type: 'file', encoding: 'base64', path, sha: 'c'.repeat(40),
            size: content.length, content: btoa(String.fromCodePoint(...new TextEncoder().encode(content))) });
    }
    /** Décode la chaîne SSE → JSON-RPC → JSON du texte d'outil. */
    function toolJson<T>(body: string): T {
        const data = (body.split('\n').find(line => line.startsWith('data: ')) ?? `data: ${body}`)
            .slice('data: '.length);
        const envelope = JSON.parse(data) as {
            result?: {
                content?: Array<{
                    text?: string;
                }>;
            };
        };
        return JSON.parse(envelope.result?.content?.[0]?.text ?? '{}') as T;
    }
    return { ORIGIN, settings, send, cookie, consent, mcpSession, rpcResult, callTool, contentsFile, toolJson };
}

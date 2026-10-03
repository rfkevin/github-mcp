import { navigationTarget } from './navigation-helpers';
import { describe, expect, it, vi } from 'vitest';
import { codeChallenge } from '../../src/auth/github';
import { outputSchemas } from '../../src/mcp/tools/github/output-schemas';
import { createOAuthFixture, READ_TOOLS } from './helpers';
const { ORIGIN, settings, send, cookie, mcpSession, rpcResult, callTool } = createOAuthFixture();
describe('Catalogue et transport MCP', () => {
    it.each(['2025-03-26', '2025-06-18', '2025-11-25'])('supports initialize, discovery and call on protocol %s with a registered Origin', async (version) => {
        const { headers } = await mcpSession('mcp:read offline_access', 'https://generic-client.example/callback');
        const clientHeaders = { ...headers, Origin: 'https://generic-client.example', 'MCP-Protocol-Version': version };
        const initialize = await send('/mcp', { method: 'POST', headers: clientHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
                    protocolVersion: version, capabilities: {}, clientInfo: { name: 'generic-client', version: '1' },
                } }) });
        expect(initialize.status).toBe(200);
        expect(rpcResult(await initialize.text())).toHaveProperty('serverInfo.name', 'github-mcp');
        const notification = await send('/mcp', { method: 'POST', headers: clientHeaders,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
        expect(notification.status).toBe(202);
        for (const origin of [undefined, ORIGIN, 'https://generic-client.example']) {
            const listed = await send('/mcp', { method: 'POST', headers: { ...headers,
                    'MCP-Protocol-Version': version, ...(origin ? { Origin: origin } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
            expect(listed.status).toBe(200);
            const tools = rpcResult(await listed.text()).tools as Array<{
                name: string;
                outputSchema: {
                    type: string;
                };
            }>;
            expect(tools.map(tool => tool.name).sort()).toEqual([...READ_TOOLS].sort());
            expect(tools.every(tool => tool.outputSchema.type === 'object')).toBe(true);
            expect(tools.some(tool => tool.name === 'github_commit_changes')).toBe(false);
        }
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/installation/repositories'))
                return Response.json({ repositories: [{ full_name: 'owner/project' }] });
            throw new Error('Unexpected request');
        });
        const result = await callTool(clientHeaders, 'github_list_repositories', {}, 2);
        expect(result.status).toBe(200);
        expect(rpcResult(result.body)).toMatchObject({ structuredContent: { repositories: ['owner/project'] } });
    });
    it('supports a CIMD client with its own Origin, without registering a brand', async () => {
        const clientId = 'https://metadata-client.example/oauth/client.json';
        const redirectUri = 'https://metadata-client.example/callback';
        const verifier = 'cimd-verifier-'.repeat(5);
        const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url === clientId)
                return Response.json({ client_id: clientId, client_name: 'Generic metadata client',
                    redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
                    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
            if (url === 'https://github.com/login/oauth/access_token')
                return Response.json({ access_token: 'upstream-test-token' });
            if (url === 'https://api.github.com/user')
                return Response.json({ id: 123 });
            throw new Error('Unexpected network request');
        });
        const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
            scope: 'mcp:read', state: 'client-state', code_challenge: await codeChallenge(verifier),
            code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
        const page = await send(`/authorize?${query}`);
        expect(page.status).toBe(200);
        const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
        expect(handle).toBeTruthy();
        const approved = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ handle: handle!, decision: 'approve' }) });
        expect(approved.status).toBe(200);
        const state = new URL(await navigationTarget(approved)).searchParams.get('state')!;
        const callback = await send(`/callback?code=upstream-code&state=${encodeURIComponent(state)}`, { headers: { Cookie: cookie(approved) } });
        expect(callback.status).toBe(302);
        const tokenResponse = await send('/oauth/token', { method: 'POST', body: new URLSearchParams({
                grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier,
                code: new URL(callback.headers.get('Location')!).searchParams.get('code')!, resource: `${ORIGIN}/mcp`,
            }) });
        expect(tokenResponse.status).toBe(200);
        const token = await tokenResponse.json() as {
            access_token: string;
        };
        const listed = await send('/mcp', { method: 'POST', headers: {
                Authorization: `Bearer ${token.access_token}`, Origin: 'https://metadata-client.example',
                'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': '2025-11-25',
            }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
        expect(listed.status).toBe(200);
        expect((rpcResult(await listed.text()).tools as Array<{
            name: string;
        }>).map(tool => tool.name).sort()).toEqual([...READ_TOOLS].sort());
        expect(network).toHaveBeenCalled();
    });
    it('publishes standard object output contracts for all enabled tools', async () => {
        settings.GITHUB_WRITES_ENABLED = 'true';
        settings.GITHUB_AUTOMATION_ENABLED = 'true';
        try {
            const { headers } = await mcpSession('mcp:read mcp:write mcp:automation mcp:integration');
            const listed = await send('/mcp', { method: 'POST', headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
            expect(listed.status).toBe(200);
            const tools = rpcResult(await listed.text()).tools as Array<{
                name: string;
                inputSchema: {
                    type: string;
                    properties: Record<string, unknown>;
                };
                outputSchema: {
                    type: string;
                    properties: object;
                };
            }>;
            expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(outputSchemas).sort());
            for (const tool of tools) {
                expect(tool.inputSchema.type).toBe('object');
                expect(tool.outputSchema.type).toBe('object');
                expect(Object.keys(tool.outputSchema.properties).length).toBeGreaterThan(0);
            }
            const signedTools = tools.filter(tool => 'agentLabel' in tool.inputSchema.properties);
            expect(signedTools.map(tool => tool.name).sort()).toEqual([
                'github_append_file', 'github_apply_changes', 'github_comment_commit', 'github_comment_issue', 'github_comment_pull_request', 'github_commit_changes', 'github_create_issue', 'github_merge_integration', 'github_replace_text', 'github_resolve_conflicts', 'github_restore_file',
            ].sort());
            for (const tool of signedTools) {
                expect(tool.inputSchema.properties.agentLabel).toMatchObject({ type: 'string', minLength: 1, maxLength: 80 });
                expect(tool.inputSchema.properties.agentLabel).not.toHaveProperty('pattern');
            }
        }
        finally {
            delete settings.GITHUB_WRITES_ENABLED;
            delete settings.GITHUB_AUTOMATION_ENABLED;
        }
    });
});

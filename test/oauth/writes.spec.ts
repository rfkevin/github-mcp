import { describe, expect, it, vi } from 'vitest';
import { outputSchemas } from '../../src/mcp/tools/github/output-schemas';
import { createOAuthFixture, READ_TOOLS, WRITE_TOOLS } from './helpers';
const { settings, send, consent, mcpSession, callTool, toolJson } = createOAuthFixture();
describe('Écritures MCP et séparation des droits', () => {
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
            for (const name of WRITE_TOOLS) {
                expect(text).not.toContain(name);
                const result = await callTool(headers, name, {}, 2);
                expect(result.body).toContain('error');
            }
            expect(api).not.toHaveBeenCalled();
        }
        finally {
            delete settings.GITHUB_WRITES_ENABLED;
        }
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
                const tools = envelope.result.tools as Array<{
                    name: string;
                    title: string;
                    inputSchema: {
                        type: string;
                    };
                    outputSchema: {
                        type: string;
                    };
                    _meta: {
                        securitySchemes: Array<{
                            type: string;
                            scopes: string[];
                        }>;
                    };
                }>;
                for (const tool of tools) {
                    expect(tool.title.trim().length).toBeGreaterThan(0);
                    expect(tool.inputSchema.type).toBe('object');
                    expect(tool.outputSchema.type).toBe('object');
                    const capabilities = tool.name === 'github_merge_integration' ? ['mcp:write', 'mcp:integration']
                        : ['github_run_checks', 'github_get_agent_check_result', 'github_prepare_checks'].includes(tool.name) ? ['mcp:automation']
                            : WRITE_TOOLS.includes(tool.name) ? ['mcp:write'] : [];
                    expect(tool._meta.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['mcp:read', ...capabilities] }]);
                }
                return tools.map(tool => tool.name);
            };
            expect((await list(read.headers)).sort()).toEqual([...READ_TOOLS].sort());
            expect((await list(write.headers)).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
            expect((await list(full.headers)).sort()).toEqual(Object.keys(outputSchemas).sort());
            expect(await list(write.headers)).not.toContain('github_merge_integration');
            const initialized = await send('/mcp', { method: 'POST', headers: read.headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
                        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'read-only-client', version: '1' }
                    } }) });
            const text = await initialized.text();
            expect(text).toContain('TOOL_IMPROVEMENTS.md');
            expect(text).toContain('rfkevin/github-mcp');
            const api = vi.spyOn(globalThis, 'fetch');
            for (const name of [...WRITE_TOOLS, 'github_merge_integration', 'github_run_checks']) {
                expect((await callTool(read.headers, name, {}, 2)).body).toContain('error');
            }
            expect(api).not.toHaveBeenCalled();
            const page = await consent('mcp:read mcp:write mcp:integration offline_access');
            expect(page.html).toContain('uniquement vers integration');
            expect(page.html).toContain('Des noms différents ne prouvent pas');
            settings.GITHUB_WRITES_ENABLED = 'false';
            expect(await list(full.headers)).not.toContain('github_merge_integration');
        }
        finally {
            delete settings.GITHUB_WRITES_ENABLED;
            delete settings.GITHUB_AUTOMATION_ENABLED;
        }
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
            for (const name of ['github_create_branch', 'github_commit_changes', 'github_open_pull_request'])
                expect(text).toContain(name);
            for (const name of ['github_run_checks', 'github_merge_pull_request', 'github_delete_branch', 'github_deploy'])
                expect(text).not.toContain(name);
            settings.GITHUB_WRITES_ENABLED = 'false';
            expect(await (await list()).text()).not.toContain('github_commit_changes');
            const api = vi.spyOn(globalThis, 'fetch');
            await callTool(headers, 'github_create_branch', { repository: 'owner/project', task: 'fix', expectedBaseSha: 'a'.repeat(40) }, 2);
            expect(api).not.toHaveBeenCalled();
        }
        finally {
            delete settings.GITHUB_WRITES_ENABLED;
        }
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
            const mutations: Array<{
                path: string;
                method: string;
                body: Record<string, unknown>;
            }> = [];
            vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
                const url = new URL(String(input));
                const method = init?.method ?? 'GET';
                const body = init?.body ? JSON.parse(String(init.body)) : {};
                if (url.pathname.endsWith('/access_tokens')) {
                    tokenPermissions.push(body.permissions);
                    return Response.json({ token: 'installation-token' });
                }
                if (method !== 'GET')
                    mutations.push({ path: url.pathname, method, body });
                if (url.pathname === '/installation/repositories')
                    return Response.json({ repositories: [{ full_name: 'owner/project' }] });
                if (url.pathname === '/repos/owner/project')
                    return Response.json({ full_name: 'owner/project', default_branch: 'master' });
                if (url.pathname.includes('/git/ref/heads/'))
                    return Response.json({ object: { sha: head } });
                if (url.pathname.endsWith('/git/refs') && method === 'POST')
                    return Response.json({ ref: `refs/heads/${branch}` });
                if (url.pathname.endsWith(`/git/commits/${base}`))
                    return Response.json({ tree: { sha: tree } });
                if (url.pathname.endsWith(`/git/trees/${tree}`))
                    return Response.json({ truncated: false, tree: [
                            { path: 'src', type: 'tree', mode: '040000', sha: tree },
                            { path: 'src/app.ts', type: 'blob', mode: '100644', sha: blob },
                            { path: 'old.ts', type: 'blob', mode: '100644', sha: blob },
                        ] });
                if (url.pathname.endsWith('/git/trees') && method === 'POST')
                    return Response.json({ sha: tree });
                if (url.pathname.endsWith('/git/commits') && method === 'POST')
                    return Response.json({ sha: next });
                if (url.pathname.includes('/git/refs/heads/') && method === 'PATCH') {
                    head = next;
                    return Response.json({});
                }
                if (url.pathname.endsWith('/pulls') && method === 'POST')
                    return Response.json({ number: 42,
                        html_url: 'https://github.com/owner/project/pull/42', draft: true, head: { ref: branch, sha: head }, base: { ref: 'master' } });
                throw new Error('Unexpected GitHub request');
            });
            const created = await callTool(headers, 'github_create_branch', { repository: 'owner/project', task: 'fix', expectedBaseSha: base }, 1);
            expect(toolJson(created.body)).toMatchObject({ branch, sha: base });
            const committed = await callTool(headers, 'github_commit_changes', { repository: 'owner/project', branch,
                expectedHeadSha: base, message: 'Fix', changes: [{ path: 'src/app.ts', content: 'new', expectedSha: blob }],
                deletions: [{ path: 'old.ts', expectedSha: blob }] }, 2);
            expect(toolJson(committed.body)).toMatchObject({ branch, commitSha: next, deletedPaths: ['old.ts'] });
            const opened = await callTool(headers, 'github_open_pull_request', { repository: 'owner/project', branch, expectedHeadSha: next, title: 'Fix' }, 3);
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
        }
        finally {
            delete settings.GITHUB_WRITES_ENABLED;
        }
    });
});

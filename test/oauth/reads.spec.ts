import { describe, expect, it, vi } from 'vitest';
import { textFileResponse } from '../git-fixtures';
import { createOAuthFixture } from './helpers';
const { send, mcpSession, callTool, contentsFile, toolJson } = createOAuthFixture();
describe('Lectures MCP et permissions minimales', () => {
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
            if (file)
                return file;
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const initialized = await send('/mcp', { method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
                    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1' }
                } }) });
        expect(initialized.status).toBe(200);
        const listed = await send('/mcp', { method: 'POST', headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
        const catalogue = await listed.text();
        for (const name of ['github_list_repositories', 'github_get_project_guide', 'github_read_file',
            'github_list_directory', 'github_search_code', 'github_compare_refs', 'github_ci_status']) {
            expect(catalogue).toContain(name);
        }
        expect((await callTool(headers, 'github_list_repositories', {}, 2)).status).toBe(200);
        const read = await callTool(headers, 'github_read_file', { repository: 'owner/project', path: 'src/app.ts', ref: 'main' }, 3);
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
        const api = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/contents')) {
                return Response.json([
                    { name: '.env', path: '.env', type: 'file', size: 10, sha: 'd'.repeat(40) },
                    { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'e'.repeat(40) },
                ]);
            }
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const listing = await callTool(headers, 'github_list_directory', { repository: 'owner/project', path: '', ref: 'main' }, 1);
        expect(listing.status).toBe(200);
        const listed = toolJson<{
            entries: Array<{
                name: string;
            }>;
        }>(listing.body);
        expect(listed.entries.map(entry => entry.name)).toEqual(['src']);
        expect(listing.body).not.toContain('.env');
        const refused = await callTool(headers, 'github_read_file', { repository: 'owner/project', path: '.env', ref: 'main' }, 2);
        expect(refused.body).toContain('sensible');
        expect(api).toHaveBeenCalledTimes(2);
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
            action: 'read_file', outcome: 'error', reason: 'invalid_request' }));
    });
    it('compare_refs résume le diff et omet les patchs trop volumineux', async () => {
        const { headers } = await mcpSession();
        let round = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/compare/')) {
                round += 1;
                return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
                    commits: [{ sha: 'f'.repeat(40), html_url: 'https://example.invalid/commit',
                            commit: { message: 'Fix login\n\nDetails internes', author: { date: '2026-09-29T00:00:00Z' } } }],
                    files: [{ filename: 'src/app.ts', status: 'modified', additions: 2, deletions: 1,
                            patch: round === 1 ? 'CANARY-PATCH petit' : `CANARY-PATCH ${'x'.repeat(200000)}` }] });
            }
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const small = await callTool(headers, 'github_compare_refs', { repository: 'owner/project', base: 'main', head: 'mcp/test/fix' }, 1);
        expect(small.body).toContain('CANARY-PATCH petit');
        expect(small.body).not.toContain('Details internes');
        const diff = toolJson<{
            commits: Array<{
                message: string;
            }>;
            files: Array<{
                patch?: string;
            }>;
        }>(small.body);
        expect(diff.commits[0].message).toBe('Fix login');
        expect(diff.files[0].patch).toBe('CANARY-PATCH petit');
        const big = await callTool(headers, 'github_compare_refs', { repository: 'owner/project', base: 'main', head: 'mcp/test/fix' }, 2);
        const huge = toolJson<{
            patchesOmitted?: boolean;
            files: Array<Record<string, unknown>>;
        }>(big.body);
        expect(huge.patchesOmitted).toBe(true);
        expect(huge.files[0]).not.toHaveProperty('patch');
        expect(big.body).not.toContain('CANARY-PATCH');
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
            action: 'compare_refs', outcome: 'success' }));
    });
    it('ci_status agrège contrôles, statut combiné et exécutions', async () => {
        const { headers } = await mcpSession();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/check-runs')) {
                return Response.json({ check_runs: [{ id: 1, name: 'GitGuardian Security Checks',
                            status: 'completed', conclusion: 'success', html_url: 'https://example.invalid/check/1' }] });
            }
            if (url.includes('/status'))
                return Response.json({ state: 'success', total_count: 1,
                    statuses: [{ context: 'external', state: 'success', description: null }] });
            if (url.includes('/actions/runs')) {
                return Response.json({ workflow_runs: [{ id: 7, name: 'Workers Builds', status: 'completed',
                            conclusion: 'success', head_branch: 'mcp/test/fix', head_sha: 'a'.repeat(40), event: 'push',
                            html_url: 'https://example.invalid/run/7', created_at: '2026-09-29T00:00:00Z' }] });
            }
            if (url.includes('/commits/'))
                return Response.json({ sha: 'a'.repeat(40) });
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const status = await callTool(headers, 'github_ci_status', { repository: 'owner/project', ref: 'mcp/test/fix' }, 1);
        expect(status.status).toBe(200);
        const report = toolJson<{
            combinedState: string;
            checks: Array<{
                name: string;
            }>;
            runs: Array<{
                name: string;
            }>;
        }>(status.body);
        expect(report.combinedState).toBe('success');
        expect(report.checks.map(check => check.name)).toContain('GitGuardian Security Checks');
        expect(report.runs.map(run => run.name)).toContain('Workers Builds');
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
            action: 'ci_status', outcome: 'success' }));
    });
    it('get_project_guide livre les documents présents et signale les absents', async () => {
        const { headers } = await mcpSession();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            const file = textFileResponse(url, 'AGENTS.md', '# Règles du dépôt');
            if (file)
                return file;
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const guide = await callTool(headers, 'github_get_project_guide', { repository: 'owner/project', ref: 'main' }, 1);
        const payload = toolJson<{
            documents: Array<{
                path: string;
                content?: string;
                missing?: boolean;
            }>;
        }>(guide.body);
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
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/search/code')) {
                return Response.json({ incomplete_results: false, total_count: 2, items: [
                        { name: 'app.ts', path: 'src/app.ts', sha: 'a'.repeat(40), html_url: 'https://example.invalid/app', repository: { full_name: 'owner/project' } },
                        { name: '.env', path: '.env', sha: 'b'.repeat(40), html_url: 'https://example.invalid/env', repository: { full_name: 'owner/project' } },
                    ] });
            }
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const search = await callTool(headers, 'github_search_code', { repository: 'owner/project', query: 'token' }, 1);
        const payload = toolJson<{
            matches: Array<{
                path: string;
            }>;
        }>(search.body);
        expect(payload.matches.map(match => match.path)).toEqual(['src/app.ts']);
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
            action: 'search_code', outcome: 'success' }));
    });
    it.each([true, false])('search_code expose au client une recherche vide, incomplete=%s', async (incomplete) => {
        const { headers } = await mcpSession();
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/search/code'))
                return Response.json({ items: [], total_count: 0,
                    incomplete_results: incomplete });
            throw new Error('Unexpected GitHub request');
        });
        const response = await callTool(headers, 'github_search_code', { repository: 'owner/project', query: 'jose' }, 1);
        const result = toolJson<{
            matches: unknown[];
            incompleteResults: boolean;
            note: string;
        }>(response.body);
        expect(result).toMatchObject({ matches: [], incompleteResults: incomplete });
        expect(result.note).toContain(incomplete ? 'Recherche GitHub incomplète' : 'ne prouve pas l’absence');
        if (incomplete)
            expect(result.note).toContain('github_read_files');
    });
    it('tronque les fichiers longs et garde un motif fermé sur les erreurs GitHub', async () => {
        const { headers } = await mcpSession();
        let round = 0;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/access_tokens'))
                return Response.json({ token: 'installation-token' });
            if (url.includes('/git/blobs/')) {
                round += 1;
                if (round === 1)
                    return contentsFile('big.txt', 'x'.repeat(90000));
                return Response.json({ message: 'Server Error on https://api.github.com/private' }, { status: 500 });
            }
            const file = textFileResponse(url, 'big.txt', 'x'.repeat(90000));
            if (file)
                return file;
            throw new Error('Unexpected GitHub request');
        });
        const audit = vi.spyOn(console, 'log').mockImplementation(() => { });
        const long = await callTool(headers, 'github_read_file', { repository: 'owner/project', path: 'big.txt', ref: 'main' }, 1);
        const truncated = toolJson<{
            content: string;
            truncated: boolean;
        }>(long.body);
        expect(truncated.truncated).toBe(true);
        expect(truncated.content).toHaveLength(80000);
        const failed = await callTool(headers, 'github_read_file', { repository: 'owner/project', path: 'big.txt', ref: 'main' }, 2);
        expect(failed.body).not.toContain('api.github.com');
        expect(failed.body).toContain('Impossible de lire ce fichier.');
        expect(audit).toHaveBeenCalledWith(JSON.stringify({ actor: '123', service: 'github',
            action: 'read_file', outcome: 'error', reason: 'github_api_500' }));
    });
});

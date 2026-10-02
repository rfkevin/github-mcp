import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../src/github/client';
import { GitHubFiles } from '../../src/github/files';
import { GitHubHttp } from '../../src/github/http';
import type { GitHubServiceContext } from '../../src/github/service-context';
import type { ToolContext } from '../../src/mcp/context';
import { createToolContext } from '../../src/mcp/context';
import type { AppEnv } from '../../src/config';
import { registerCommitTools } from '../../src/mcp/tools/github/commits';
import { SHA, OTHER, registry, context } from './helpers';
describe('foundation: lecture et transport', () => {
    let privateKey: string;
    beforeAll(async () => {
        const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
            modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['sign', 'verify']) as CryptoKeyPair;
        const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer;
        privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(der)))}\n-----END PRIVATE KEY-----`;
    });
    function clientWithTree(entry: Record<string, unknown>, treeExtra = {}) {
        const calls: string[] = [];
        const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
            fetcher: async (input) => {
                const url = String(input);
                calls.push(url);
                if (url.endsWith('/access_tokens'))
                    return Response.json({ token: 'fake' });
                if (url.includes('/git/trees/'))
                    return Response.json({ tree: [entry], truncated: false, ...treeExtra });
                if (url.includes('/git/blobs/'))
                    return Response.json({ content: btoa('ok'), encoding: 'base64', size: 2 });
                return new Response(null, { status: 404 });
            } });
        return { client, calls };
    }
    it.each(['120000', '160000'])('refuse un lien/sous-module avant le blob : %s', async (mode) => {
        const { client, calls } = clientWithTree({ path: 'safe.txt', type: mode === '160000' ? 'commit' : 'blob', mode, sha: SHA, size: 2 });
        await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('liens symboliques');
        expect(calls.some(url => url.includes('/git/blobs/'))).toBe(false);
    });
    it('refuse un fichier surdimensionné avant téléchargement du blob', async () => {
        const { client, calls } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 1000001 });
        await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('volumineux');
        expect(calls.some(url => url.includes('/git/blobs/'))).toBe(false);
    });
    it('refuse un arbre tronqué', async () => {
        const { client } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 2 }, { truncated: true });
        await expect(client.files.getTextFile('o/r', 'safe.txt', SHA)).rejects.toThrow('incomplet');
    });
    it('partage les requêtes d’arbre parallèles du même appel', async () => {
        const { client, calls } = clientWithTree({ path: 'safe.txt', type: 'blob', mode: '100644', sha: SHA, size: 2 });
        await Promise.all([client.files.getTextFile('o/r', 'safe.txt', SHA), client.files.getTextFile('o/r', 'safe.txt', SHA)]);
        expect(calls.filter(url => url.includes('/git/trees/'))).toHaveLength(1);
        expect(calls.filter(url => url.endsWith('/access_tokens'))).toHaveLength(1);
    });
    it('refuse une recherche qui tente de changer le dépôt', async () => {
        const request = vi.fn();
        const files = new GitHubFiles({ request } as unknown as GitHubServiceContext);
        await expect(files.searchCode('o/r', 'secret repo:someone/else')).rejects.toThrow('limitée au dépôt');
        expect(request).not.toHaveBeenCalled();
    });
    it('filtre les réponses de recherche qui appartiennent à un autre dépôt', async () => {
        const files = new GitHubFiles({
            request: async () => ({ items: [{ path: 'safe.txt', repository: { full_name: 'other/repo' } }] }),
            repoPath: () => '', splitRepository: () => ({ owner: 'o', name: 'r' }), withQuery: (p: string) => p,
        } as unknown as GitHubServiceContext);
        await expect(files.searchCode('o/r', 'hello')).resolves.toEqual([]);
    });
    it.each([true, false, undefined])('conserve l’indicateur de recherche incomplète : %s', async (incomplete) => {
        const request = vi.fn(async () => ({ incomplete_results: incomplete, total_count: 0, items: [] }));
        const files = new GitHubFiles({ request, repoPath: () => '',
            splitRepository: () => ({ owner: 'o', name: 'r' }), withQuery: (p: string) => p,
        } as unknown as GitHubServiceContext);
        await expect(files.searchCodeWithMetadata('o/r', 'jose')).resolves.toEqual({
            matches: [], incompleteResults: incomplete !== false, potentiallyTruncated: false
        });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('signale une page tronquée tout en filtrant chemins sensibles et dépôts étrangers', async () => {
        const files = new GitHubFiles({
            request: async () => ({ incomplete_results: false, total_count: 40, items: [
                    { path: 'src/app.ts', repository: { full_name: 'o/r' } },
                    { path: '.env', repository: { full_name: 'o/r' } },
                    { path: 'other.ts', repository: { full_name: 'other/repo' } },
                ] }), repoPath: () => '', splitRepository: () => ({ owner: 'o', name: 'r' }), withQuery: (p: string) => p,
        } as unknown as GitHubServiceContext);
        const result = await files.searchCodeWithMetadata('o/r', 'token');
        expect(result).toMatchObject({ incompleteResults: false, potentiallyTruncated: true });
        expect(result.matches.map(item => item.path)).toEqual(['src/app.ts']);
    });
    it.each(['master~1', 'HEAD^', 'master^2'])('explique la référence relative %s sans requête GitHub', async (ref) => {
        const fetcher = vi.fn();
        const client = new GitHubClient({ appId: '1', installationId: '2', privateKey, fetcher });
        const ctx = context();
        ctx.reads.commits.compareRefs = client.commits.compareRefs.bind(client.commits) as never;
        const result = await registry(registerCommitTools, ctx as unknown as ToolContext)('github_compare_refs', { repository: 'o/r', base: ref, head: 'master' });
        expect(result).toMatchObject({ isError: true, structuredContent: { error: {
                    code: 'UNSUPPORTED_REF_EXPRESSION', retryable: false, message: expect.stringContaining('SHA du parent'),
                } } });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(['master', 'v1.0.0', SHA])('accepte branche, tag ou SHA pour comparer : %s', async (base) => {
        const fetcher = vi.fn(async (input) => String(input).endsWith('/access_tokens')
            ? Response.json({ token: 'fake' }) : Response.json({ status: 'ahead' }));
        const client = new GitHubClient({ appId: '1', installationId: '2', privateKey, fetcher });
        await expect(client.commits.compareRefs('o/r', base, OTHER)).resolves.toMatchObject({ status: 'ahead' });
        expect(String(fetcher.mock.calls[1][0])).toContain(`/compare/${base}...${OTHER}`);
    });
    it('ne suit aucune redirection avec le jeton de dépôt', async () => {
        const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://external.invalid/secret' } }));
        const http = new GitHubHttp({ fetcher, userAgent: 'test', timeoutMs: 1000, getInstallationToken: async () => 'CANARY' });
        await expect(http.request('/repos/o/r')).rejects.toThrow('Redirection GitHub refusée');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/o/r', expect.objectContaining({ redirect: 'manual' }));
    });
    it('une permission Actions manquante ne bloque pas contents', async () => {
        const permissions: unknown[] = [];
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            if (String(input).endsWith('/access_tokens')) {
                const permission = JSON.parse(String(init?.body)).permissions;
                permissions.push(permission);
                return permission.actions ? new Response(null, { status: 422 }) : Response.json({ token: 'fake' });
            }
            return Response.json({ sha: SHA });
        });
        try {
            const ctx = createToolContext({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: privateKey } as AppEnv, '123');
            await expect(ctx.workflows.listWorkflowRuns('o/r')).rejects.toMatchObject({ status: 422 });
            await expect(ctx.reads.commits.getCommit('o/r', 'master')).resolves.toMatchObject({ sha: SHA });
            expect(permissions).toEqual([{ metadata: 'read', actions: 'read' }, { metadata: 'read', contents: 'read' }]);
        }
        finally {
            spy.mockRestore();
        }
    });
    it('un refus Issues ne bloque ni les fichiers ni les PR et utilise un jeton dédié', async () => {
        const permissions: unknown[] = [];
        const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            if (String(input).endsWith('/access_tokens')) {
                const permission = JSON.parse(String(init?.body)).permissions;
                permissions.push(permission);
                return permission.issues ? new Response(null, { status: 422 }) : Response.json({ token: 'fake' });
            }
            return Response.json({ sha: SHA, number: 1 });
        });
        try {
            const ctx = createToolContext({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: privateKey } as AppEnv, '123');
            await expect(ctx.issues.getIssue('o/r', 11)).rejects.toMatchObject({ status: 422 });
            await expect(ctx.reads.commits.getCommit('o/r', 'master')).resolves.toMatchObject({ sha: SHA });
            await expect(ctx.pulls.pullRequests.getPullRequest('o/r', 1)).resolves.toMatchObject({ number: 1 });
            expect(permissions).toEqual([{ metadata: 'read', issues: 'read' },
                { metadata: 'read', contents: 'read' }, { metadata: 'read', pull_requests: 'read' }]);
        } finally { spy.mockRestore(); }
    });
    it('dispatch est refusé par défaut et ne peut pas viser un autre workflow/ref', async () => {
        let calls = 0;
        const make = (allowedWorkflows: string[] = [], allowedWorkflowRefs: string[] = []) => new GitHubClient({
            appId: '1', installationId: '2', privateKey, allowedWorkflows, allowedWorkflowRefs,
            fetcher: async () => { calls++; return Response.json({}); },
        });
        await expect(make().actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'master')).rejects.toThrow('non autorisé');
        await expect(make(['agent-checks.yml'], ['master']).actions.dispatchWorkflow('o/r', 'deploy.yml', 'master')).rejects.toThrow('non autorisé');
        await expect(make(['agent-checks.yml'], ['master']).actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'mcp/a/b')).rejects.toThrow('non autorisé');
        expect(calls).toBe(0);
    });
    it('renvoie le runId de GitHub après un dispatch autorisé', async () => {
        const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
            apiVersion: '2026-03-10', allowedWorkflows: ['agent-checks.yml'], allowedWorkflowRefs: ['master'],
            fetcher: async (input) => String(input).endsWith('/access_tokens') ? Response.json({ token: 'fake' }) :
                Response.json({ workflow_run_id: 42, html_url: 'https://github.com/o/r/actions/runs/42' }) });
        await expect(client.actions.dispatchWorkflow('o/r', 'agent-checks.yml', 'master')).resolves.toEqual({
            runId: 42, url: 'https://github.com/o/r/actions/runs/42'
        });
    });
    it.each(['directory', 'symlink', 'head_changed'])('refuse une modification non vérifiable avant toute écriture : %s', async (scenario) => {
        let writes = 0;
        const client = new GitHubClient({ appId: '1', installationId: '2', privateKey,
            fetcher: async (input, init) => {
                const url = String(input);
                if (url.endsWith('/access_tokens'))
                    return Response.json({ token: 'fake' });
                if (init?.method === 'POST' || init?.method === 'PATCH')
                    writes++;
                if (url.includes('/git/ref/'))
                    return Response.json({ object: { sha: SHA } });
                if (url.includes('/git/commits/'))
                    return Response.json({ tree: { sha: OTHER } });
                return Response.json({ tree: [{ path: 'src', sha: OTHER, type: scenario === 'directory' ? 'tree' : 'blob',
                            mode: scenario === 'directory' ? '040000' : '120000' }] });
            } });
        await expect(client.changes.applyChangeSet('o/r', 'mcp/test/fix', [{ path: 'src', content: 'bad' }], 'test', { expectedHeadSha: scenario === 'head_changed' ? OTHER : SHA })).rejects.toThrow();
        expect(writes).toBe(0);
    });
});

import { beforeAll, describe, expect, it } from 'vitest';
import type { RecordedRequest } from './helpers';
import { GitHubClient } from '../../src/github/client';
import { GitHubHttp } from '../../src/github/http';
import { REPOSITORY, INSTALLATION_TOKEN, FILE_PATH, FILE_SHA, jsonResponse, createPrivateKeyPem, requestUrl, rejection } from './helpers';
describe('GitHubClient : capabilities', () => {
    let privateKey: string;
    beforeAll(async () => {
        privateKey = await createPrivateKeyPem();
    });
    it('désactive la fusion et l’approbation par défaut', async () => {
        let requestCount = 0;
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher: async () => {
                requestCount += 1;
                return new Response();
            },
        });
        await expect(client.pullRequests.mergePullRequest(REPOSITORY, 7)).rejects.toThrow('La fusion de Pull Requests est désactivée (allowMerge).');
        expect(() => client.pullRequests.createReview(REPOSITORY, 7, 'APPROVE', '')).toThrow('L’approbation de Pull Requests est désactivée (allowApproval).');
        expect(requestCount).toBe(0);
    });
    it('crée une Pull Request sur la branche de travail autorisée', async () => {
        let pullRequestBody: Record<string, unknown> | undefined;
        const fetcher: typeof fetch = async (input, init) => {
            const url = requestUrl(input);
            if (url.endsWith('/access_tokens')) {
                return jsonResponse({ token: INSTALLATION_TOKEN });
            }
            if (url.endsWith('/repos/owner/project/pulls') && init?.method === 'POST') {
                pullRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
                return jsonResponse({ number: 7, ...pullRequestBody });
            }
            return new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await client.pullRequests.createPullRequest(REPOSITORY, 'mcp/claude/fix-login', 'main', 'Fix login', 'Handle expired sessions');
        expect(pullRequestBody).toEqual({
            title: 'Fix login',
            body: 'Handle expired sessions',
            head: 'mcp/claude/fix-login',
            base: 'main',
            draft: false,
        });
    });
    it('bloque les écritures de tous les services en lecture seule avant le réseau', async () => {
        let calls = 0;
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456', policy: { readOnly: true },
            allowedWorkflows: ['ci.yml'], allowedWorkflowRefs: ['main'],
            fetcher: async () => { calls++; return jsonResponse({}); },
        });
        const operations: Array<() => Promise<unknown>> = [
            () => client.issues.createIssue(REPOSITORY, 'Issue'),
            () => client.issues.createComment(REPOSITORY, 1, 'Comment'),
            () => client.pullRequests.updatePullRequest(REPOSITORY, 1, { title: 'Title' }),
            () => client.pullRequests.createReview(REPOSITORY, 1, 'COMMENT', 'Review'),
            () => client.actions.rerunWorkflow(REPOSITORY, 1),
            () => client.actions.dispatchWorkflow(REPOSITORY, 'ci.yml', 'main'),
            () => client.releases.createRelease(REPOSITORY, 'v1'),
        ];
        for (const operation of operations) {
            await expect(Promise.resolve().then(operation)).rejects.toThrow('lecture seule');
        }
        expect(calls).toBe(0);
    });
    it.each(['missing-sha', 'deletion-missing-sha', 'truncated'])('refuse un changement non vérifiable : %s', async (scenario) => {
        let writes = 0;
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456',
            fetcher: async (input, init) => {
                const url = requestUrl(input);
                if (url.endsWith('/access_tokens'))
                    return jsonResponse({ token: INSTALLATION_TOKEN });
                if (init?.method && init.method !== 'GET')
                    writes++;
                if (url.includes('/git/ref/'))
                    return jsonResponse({ object: { sha: 'parent' } });
                if (url.includes('/git/commits/'))
                    return jsonResponse({ tree: { sha: 'tree' } });
                return jsonResponse({ truncated: scenario === 'truncated', tree: [
                        { path: FILE_PATH, sha: FILE_SHA, type: 'blob', mode: '100755' },
                    ] });
            },
        });
        await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/test/fix', scenario === 'deletion-missing-sha' ? [] : [{ path: FILE_PATH, content: 'new' }], 'Update', scenario === 'deletion-missing-sha' ? { deletions: [{ path: FILE_PATH }] } : {})).rejects.toThrow(scenario === 'truncated' ? 'tronqué' : 'SHA attendu');
        expect(writes).toBe(0);
    });
    it('compte aussi les suppressions dans la limite de fichiers avant le réseau', async () => {
        let calls = 0;
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456', policy: { maxFilesPerChange: 1 },
            fetcher: async () => { calls++; return jsonResponse({}); },
        });
        await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/test/fix', [{ path: 'new.ts', content: 'new' }], 'Update', { deletions: [{ path: 'old.ts', expectedSha: FILE_SHA }] })).rejects.toThrow('nombre de fichiers');
        expect(calls).toBe(0);
    });
    it.each(['main', 'master', 'client', 'client/app'])('refuse de mettre à jour une PR sur %s', async (branch) => {
        const requests: RecordedRequest[] = [];
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456',
            fetcher: async (input, init) => {
                const url = requestUrl(input);
                requests.push({ url, init });
                return jsonResponse(url.endsWith('/access_tokens') ? { token: INSTALLATION_TOKEN } : {
                    head: { ref: branch, sha: FILE_SHA, repo: { full_name: REPOSITORY } },
                });
            },
        });
        await expect(client.branches.updatePullRequestBranch(REPOSITORY, 1)).rejects.toThrow('protégée');
        expect(requests.some(r => r.init?.method === 'PUT')).toBe(false);
    });
    it('transmet le SHA attendu pour la mise à jour d’une branche de PR autorisée', async () => {
        let updateBody: unknown;
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456',
            fetcher: async (input, init) => {
                if (requestUrl(input).endsWith('/access_tokens'))
                    return jsonResponse({ token: INSTALLATION_TOKEN });
                if (init?.method === 'PUT') {
                    updateBody = JSON.parse(String(init.body));
                    return jsonResponse({});
                }
                return jsonResponse({ head: { ref: 'mcp/test/fix', sha: FILE_SHA, repo: { full_name: REPOSITORY } } });
            },
        });
        await client.branches.updatePullRequestBranch(REPOSITORY, 1);
        expect(updateBody).toEqual({ expected_head_sha: FILE_SHA });
    });
    it.each(['main', 'master', 'client/app'])('refuse une fusion vers %s même si allowMerge est activé', async (base) => {
        let writes = 0;
        const client = new GitHubClient({
            appId: '123', privateKey, installationId: '456', allowMerge: true,
            fetcher: async (input, init) => {
                if (requestUrl(input).endsWith('/access_tokens'))
                    return jsonResponse({ token: INSTALLATION_TOKEN });
                if (init?.method === 'PUT')
                    writes++;
                return jsonResponse({ base: { ref: base }, head: { sha: FILE_SHA } });
            },
        });
        await expect(client.pullRequests.mergePullRequest(REPOSITORY, 1, { expectedHeadSha: FILE_SHA })).rejects.toThrow('protégée');
        expect(writes).toBe(0);
    });
    it('nomme un délai dépassé sans recopier le message d’origine', async () => {
        const origin = 'https://api.github.com/repos/private/name?token=secret';
        const http = new GitHubHttp({
            fetcher: async () => {
                throw new DOMException(origin, 'TimeoutError');
            },
            userAgent: 'github-mcp-test',
            timeoutMs: 10,
            getInstallationToken: async () => INSTALLATION_TOKEN,
        });
        const failure = await rejection(http.request('/repos/owner/project/issues', { method: 'POST', body: '{}' }));
        expect(failure.message).toBe('Délai dépassé lors de l’appel à GitHub.');
        expect(failure.message).not.toContain(origin);
        expect((failure as {
            status?: number;
        }).status).toBe(0);
    });
    it('nomme une panne réseau sans recopier le message d’origine', async () => {
        const origin = 'https://api.github.com/repos/private/name?token=secret';
        const http = new GitHubHttp({
            fetcher: async () => {
                throw new TypeError(origin);
            },
            userAgent: 'github-mcp-test',
            timeoutMs: 10,
            getInstallationToken: async () => INSTALLATION_TOKEN,
        });
        const failure = await rejection(http.request('/repos/owner/project/issues', { method: 'POST', body: '{}' }));
        expect(failure.message).toBe('Échec réseau lors de l’appel à GitHub.');
        expect(failure.message).not.toContain(origin);
    });
    it('refuse une redirection pendant la création du jeton d’installation', async () => {
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher: async () => new Response(null, {
                status: 302,
                headers: { Location: 'https://example.invalid/authorize?next=secret' },
            }),
        });
        const failure = await rejection(client.repositories.getRepository(REPOSITORY));
        expect(failure.message).toBe('Redirection GitHub inattendue : aucune redirection n’est suivie pour créer le jeton.');
        expect(failure.message).not.toContain('example.invalid');
        expect((failure as {
            status?: number;
        }).status).toBe(302);
    });
    it('cite le statut quand GitHub refuse de créer le jeton', async () => {
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher: async () => new Response(null, { status: 401 }),
        });
        await expect(client.repositories.getRepository(REPOSITORY)).rejects.toThrow('Impossible de créer le jeton GitHub App (statut 401).');
    });
    it('signale une réponse d’authentification illisible', async () => {
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher: async () => new Response('pas du JSON', { status: 200 }),
        });
        await expect(client.repositories.getRepository(REPOSITORY)).rejects.toThrow('Réponse d’authentification GitHub illisible.');
    });
});

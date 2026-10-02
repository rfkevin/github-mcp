import { beforeAll, describe, expect, it } from 'vitest';
import type { RecordedRequest } from './helpers';
import { GitHubClient } from '../../src/github/client';
import { REPOSITORY, INSTALLATION_TOKEN, FILE_PATH, FILE_SHA, jsonResponse, createPrivateKeyPem, requestUrl } from './helpers';
describe('GitHubClient : changes', () => {
    let privateKey: string;
    beforeAll(async () => {
        privateKey = await createPrivateKeyPem();
    });
    it('crée un commit atomique et met à jour la référence sans forcer', async () => {
        const requests: RecordedRequest[] = [];
        const oldSha = 'c'.repeat(40);
        const fetcher: typeof fetch = async (input, init) => {
            const url = requestUrl(input);
            requests.push({ url, init });
            if (url.endsWith('/access_tokens')) {
                return jsonResponse({ token: INSTALLATION_TOKEN });
            }
            if (url.endsWith('/git/ref/heads/mcp/claude/change') && init?.method !== 'PATCH') {
                return jsonResponse({ object: { sha: 'parent-commit' } });
            }
            if (url.endsWith('/git/commits/parent-commit')) {
                return jsonResponse({ sha: 'parent-commit', tree: { sha: 'parent-tree' } });
            }
            if (url.includes('/git/trees/parent-tree')) {
                return jsonResponse({
                    truncated: false,
                    tree: [
                        { path: 'src/old.ts', type: 'blob', sha: oldSha, mode: '100755' },
                    ],
                });
            }
            if (url.endsWith('/git/trees') && init?.method === 'POST') {
                return jsonResponse({ sha: 'new-tree' });
            }
            if (url.endsWith('/git/commits') && init?.method === 'POST') {
                return jsonResponse({ sha: 'new-commit' });
            }
            if (url.endsWith('/git/refs/heads/mcp/claude/change') && init?.method === 'PATCH') {
                return jsonResponse({});
            }
            return new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/claude/change', [{ path: 'src/new.ts', content: 'new file' }], 'Add a file', { deletions: [{ path: 'src/old.ts', expectedSha: oldSha }] })).resolves.toEqual({
            branch: 'mcp/claude/change',
            commitSha: 'new-commit',
            changedPaths: ['src/new.ts'],
            deletedPaths: ['src/old.ts'],
        });
        const treeRequest = requests.find(request => request.url.endsWith('/git/trees') && request.init?.method === 'POST');
        const treeBody = JSON.parse(String(treeRequest?.init?.body)) as {
            tree: Array<{
                path: string;
                mode: string;
                sha?: string | null;
            }>;
        };
        expect(treeBody.tree).toEqual([
            { path: 'src/new.ts', mode: '100644', type: 'blob', content: 'new file' },
            { path: 'src/old.ts', mode: '100755', type: 'blob', sha: null },
        ]);
        const refUpdate = requests.find(request => request.url.endsWith('/git/refs/heads/mcp/claude/change') && request.init?.method === 'PATCH');
        expect(JSON.parse(String(refUpdate?.init?.body))).toEqual({ sha: 'new-commit', force: false });
    });
    it('interrompt un commit si le SHA du fichier a changé', async () => {
        const requests: RecordedRequest[] = [];
        const fetcher: typeof fetch = async (input, init) => {
            const url = requestUrl(input);
            requests.push({ url, init });
            if (url.endsWith('/access_tokens')) {
                return jsonResponse({ token: INSTALLATION_TOKEN });
            }
            if (url.endsWith('/git/ref/heads/mcp/claude/change')) {
                return jsonResponse({ object: { sha: 'parent-commit' } });
            }
            if (url.endsWith('/git/commits/parent-commit')) {
                return jsonResponse({ sha: 'parent-commit', tree: { sha: 'parent-tree' } });
            }
            if (url.includes('/git/trees/parent-tree')) {
                return jsonResponse({
                    truncated: false,
                    tree: [{ path: FILE_PATH, type: 'blob', sha: 'c'.repeat(40), mode: '100644' }],
                });
            }
            return new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/claude/change', [{ path: FILE_PATH, content: 'updated', expectedSha: FILE_SHA }], 'Update file')).rejects.toThrow('Le fichier src/app.ts a changé depuis sa lecture.');
        expect(requests.some(request => request.url.endsWith('/git/trees') && request.init?.method === 'POST')).toBe(false);
    });
});

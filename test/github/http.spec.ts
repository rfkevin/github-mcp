import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/github/client';
import { gitFileResponse } from '../git-fixtures';
import { REPOSITORY, INSTALLATION_TOKEN, FILE_PATH, FILE_SHA, FILE_CONTENT, jsonResponse, toBase64, createPrivateKeyPem, requestUrl } from './helpers';
describe('GitHubClient : http', () => {
    let privateKey: string;
    beforeAll(async () => {
        privateKey = await createPrivateKeyPem();
    });
    it('rafraîchit une fois le jeton après une réponse 401', async () => {
        let tokenRequests = 0;
        let fileRequests = 0;
        const fetcher: typeof fetch = async (input) => {
            const url = requestUrl(input);
            if (url.endsWith('/access_tokens')) {
                tokenRequests += 1;
                return jsonResponse({ token: `installation-token-${tokenRequests}` });
            }
            if (url.includes('/git/blobs/')) {
                fileRequests += 1;
                if (fileRequests === 1) {
                    return new Response(null, { status: 401 });
                }
                return jsonResponse({
                    type: 'file',
                    encoding: 'base64',
                    content: toBase64(FILE_CONTENT),
                    sha: FILE_SHA,
                    path: FILE_PATH,
                    size: FILE_CONTENT.length,
                });
            }
            return gitFileResponse(url, { path: FILE_PATH, sha: FILE_SHA, size: FILE_CONTENT.length,
                content: toBase64(FILE_CONTENT) }) ?? new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher,
        });
        await expect(client.files.getTextFile(REPOSITORY, FILE_PATH, 'main')).resolves.toMatchObject({
            content: FILE_CONTENT,
        });
        expect(tokenRequests).toBe(2);
        expect(fileRequests).toBe(2);
    });
    it('filtre les dépôts de l’installation avec la liste autorisée', async () => {
        const fetcher: typeof fetch = async (input) => {
            const url = requestUrl(input);
            if (url.endsWith('/access_tokens')) {
                return jsonResponse({ token: INSTALLATION_TOKEN });
            }
            if (url.includes('/installation/repositories')) {
                return jsonResponse({
                    repositories: [
                        { full_name: 'owner/project' },
                        { full_name: 'owner/other' },
                    ],
                });
            }
            return new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            allowedRepositories: ['OWNER/PROJECT'],
            fetcher,
        });
        await expect(client.repositories.listInstallationRepositories()).resolves.toEqual(['owner/project']);
    });
});

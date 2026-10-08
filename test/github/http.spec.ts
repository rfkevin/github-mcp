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
    it('télécharge un log redirigé sans transmettre Authorization à la destination', async () => {
        let externalAuthorization: string | null | undefined;
        const fetcher: typeof fetch = async (input, init) => {
            const url = requestUrl(input);
            if (url.endsWith('/access_tokens'))
                return jsonResponse({ token: INSTALLATION_TOKEN });
            if (url.endsWith('/repos/owner/project/actions/jobs/42/logs')) {
                expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
                expect(init?.redirect).toBe('manual');
                return new Response(null, { status: 302, headers: { Location: 'https://logs.example.invalid/job.txt?sig=CANARY' } });
            }
            if (url.startsWith('https://logs.example.invalid/')) {
                externalAuthorization = new Headers(init?.headers).get('Authorization');
                return new Response('job log');
            }
            return new Response('Not Found', { status: 404 });
        };
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await expect(client.actions.getJobLogs(REPOSITORY, 42)).resolves.toBe('job log');
        expect(externalAuthorization).toBeNull();
    });
    it('refuse une destination de log non HTTPS sans la contacter', async () => {
        let externalCalls = 0;
        const fetcher: typeof fetch = async (input) => {
            const url = requestUrl(input);
            if (url.endsWith('/access_tokens'))
                return jsonResponse({ token: INSTALLATION_TOKEN });
            if (url.endsWith('/repos/owner/project/actions/jobs/42/logs'))
                return new Response(null, { status: 302, headers: { Location: 'http://logs.example.invalid/job.txt' } });
            externalCalls += 1;
            return new Response('unexpected');
        };
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await expect(client.actions.getJobLogs(REPOSITORY, 42)).rejects.toThrow();
        expect(externalCalls).toBe(0);
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

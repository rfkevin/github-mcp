import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient } from '../../src/github/client';
import { REPOSITORY, INSTALLATION_TOKEN, FILE_PATH, FILE_SHA, FILE_CONTENT, toBase64, createPrivateKeyPem, createFetchStub } from './helpers';
describe('GitHubClient : files', () => {
    let privateKey: string;
    beforeAll(async () => {
        privateKey = await createPrivateKeyPem();
    });
    it('décode le contenu base64 UTF-8 renvoyé par GitHub', async () => {
        const { fetcher, requests } = createFetchStub({
            type: 'file',
            encoding: 'base64',
            // GitHub renvoie le base64 avec des retours à la ligne.
            content: `${toBase64(FILE_CONTENT)}\n`,
            sha: FILE_SHA,
            path: FILE_PATH,
            size: FILE_CONTENT.length,
        });
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            userAgent: 'github-mcp-test',
            fetcher,
        });
        const file = await client.files.getTextFile(REPOSITORY, FILE_PATH, 'main');
        expect(file).toEqual({
            path: FILE_PATH,
            sha: FILE_SHA,
            content: FILE_CONTENT,
            size: FILE_CONTENT.length,
        });
        const contentsRequest = requests.at(-1);
        expect(contentsRequest?.url).toBe(`https://api.github.com/repos/owner/project/git/blobs/${FILE_SHA}`);
        expect(new Headers(contentsRequest?.init?.headers).get('Authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    });
    it.each(['\uFEFFdébut\r\nfin', '\uFEFF'])('préserve les octets UTF-8 et le BOM : %s', async content => {
        const { fetcher } = createFetchStub({ type: 'file', encoding: 'base64', content: toBase64(content),
            sha: FILE_SHA, path: FILE_PATH, size: new TextEncoder().encode(content).length });
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        expect((await client.files.getTextFile(REPOSITORY, FILE_PATH, 'main')).content).toBe(content);
    });
    it('refuse le décodage UTF-8 avec perte avant de pouvoir réécrire le fichier', async () => {
        const { fetcher } = createFetchStub({ type: 'file', encoding: 'base64', content: btoa(String.fromCharCode(255)),
            sha: FILE_SHA, path: FILE_PATH, size: 1 });
        const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });
        await expect(client.files.getTextFile(REPOSITORY, FILE_PATH, 'main')).rejects.toMatchObject({ code: 'NON_UTF8_FILE' });
    });
    it('refuse une ressource qui n’est pas un fichier texte', async () => {
        const { fetcher } = createFetchStub({
            type: 'dir',
            encoding: 'none',
            content: '',
            sha: FILE_SHA,
            path: FILE_PATH,
            size: 0,
        });
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            fetcher,
        });
        await expect(client.files.getTextFile(REPOSITORY, FILE_PATH, 'main')).rejects.toThrow('La ressource demandée n’est pas un fichier texte.');
    });
    it('refuse un dépôt hors liste blanche avant tout appel réseau', async () => {
        let requestCount = 0;
        const client = new GitHubClient({
            appId: '123',
            privateKey,
            installationId: '456',
            allowedRepositories: ['owner/allowed'],
            fetcher: async () => {
                requestCount += 1;
                return new Response();
            },
        });
        expect(() => client.repositories.getRepository(REPOSITORY)).toThrow('Ce dépôt n’est pas autorisé.');
        expect(requestCount).toBe(0);
    });
    it('bloque les chemins sensibles avant tout appel réseau', async () => {
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
        await expect(client.files.getTextFile(REPOSITORY, '.env.production', 'main')).rejects.toThrow('La lecture de ce fichier sensible est interdite.');
        expect(requestCount).toBe(0);
    });
});

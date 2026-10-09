import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import type { GitHubIssue, GitHubComment } from '../../src/github/types';
import { GitHubApiError } from '../../src/github/types';
import { GitHubIssues } from '../../src/github/issues';
import type { GitHubServiceContext } from '../../src/github/service-context';
import { registerIssueTools } from '../../src/mcp/tools/github/issues';
import { toolRegistry } from './tool-registry';
import { maskedRevision } from '../../src/mcp/tools/github/discussion-content';
const issue: GitHubIssue = { number: 11, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/11',
    body: 'Details', user: { login: 'owner' }, labels: ['bug', { name: 'mcp' }], assignees: [{ login: 'owner' }] };
function fixture() {
    const issues = { getIssue: vi.fn(async (): Promise<GitHubIssue> => issue),
        getComment: vi.fn(async (): Promise<GitHubComment> => ({ id: 7, html_url: `${issue.html_url}#issuecomment-7`, created_at: '2026-10-03T00:00:00Z', body: 'A😀B', user: { login: 'reviewer' } })),
        listComments: vi.fn(async (): Promise<GitHubComment[]> => []),
        listIssuesPage: vi.fn(async () => ({ issues: [issue], potentiallyTruncated: false })) };
    const call = toolRegistry(registerIssueTools, { actor: '123', issues } as unknown as ToolContext);
    return { issues, get: (args: object = {}) => call.get('github_get_issue')!({ repository: 'o/r', number: 11, ...args }),
        getComment: (args: object = {}) => call.get('github_get_issue_comment')!({ repository: 'o/r', commentId: 7, offset: 0, limit: 3, ...args }),
        list: (args: object = {}) => call.get('github_list_issues')!({ repository: 'o/r', ...args }) };
}
describe('MCP Issues : réponses bornées et séparées des PR', () => {
    it('publie une issue conforme au contrat et une page de commentaires', async () => {
        const { get, issues } = fixture();
        expect((await get()).structuredContent).toMatchObject({ number: 11, labels: ['bug', 'mcp'],
            assignees: ['owner'], body: 'Details', bodyTruncated: false, comments: [], nextCommentsPage: null });
        expect(issues.listComments).toHaveBeenCalledWith('o/r', 11, 20, 1);
    });
    it('ne lit aucun commentaire sans consentement de lecture des commentaires', async () => {
        const { get, issues } = fixture();
        expect((await get({ includeComments: false })).structuredContent.comments).toEqual([]);
        expect(issues.listComments).not.toHaveBeenCalled();
    });
    it('refuse un numéro de PR avant de lire ses commentaires', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockResolvedValue({ ...issue, pull_request: {} });
        expect(await get()).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_AN_ISSUE' } } });
        expect(issues.listComments).not.toHaveBeenCalled();
    });
    it('masque les formats connus avant de tronquer le corps et les commentaires', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockResolvedValue({ ...issue, title: 'ghp_PRIVATE', body: 'ghp_PRIVATE ' + 'é'.repeat(8000) });
        issues.listComments.mockResolvedValue([{ id: 1, html_url: issue.html_url, created_at: '', body: 'Bearer PRIVATE ' + 'é'.repeat(2000) }]);
        const result = (await get()).structuredContent;
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
        expect(result.bodyTruncated).toBe(true);
        expect(result.comments).toEqual([expect.objectContaining({ bodyTruncated: true })]);
        expect(new TextEncoder().encode(String(result.body)).length).toBeLessThanOrEqual(12000);
    });
    it('suit les commentaires par pages et signale la borne finale', async () => {
        const { get, issues } = fixture();
        issues.listComments.mockResolvedValue(Array.from({ length: 20 }, (_, id) => ({ id, html_url: issue.html_url, created_at: '' })));
        expect((await get({ commentsPage: 2 })).structuredContent).toMatchObject({ commentsPotentiallyTruncated: true, nextCommentsPage: 3 });
        expect((await get({ commentsPage: 100 })).structuredContent).toMatchObject({ commentsPotentiallyTruncated: true, nextCommentsPage: null });
    });
    it('lit un commentaire ciblé avec continuation UTF-8 et révision obligatoire', async () => {
        const { getComment } = fixture();
        const first = (await getComment()).structuredContent as Record<string, unknown>;
        expect(first).toMatchObject({ commentId: 7, content: 'A😀', offset: 0, nextOffset: 5, truncated: true });
        const second = (await getComment({ offset: first.nextOffset, revision: first.revision })).structuredContent;
        expect(second).toMatchObject({ content: 'B', offset: 5, nextOffset: null, truncated: false });
        expect(await getComment({ offset: 5 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMENT_REVISION_REQUIRED' } } });
    });
    it('A11 : garde l’extrait historique par défaut et publie révision et taille du corps masqué', async () => {
        const { get } = fixture();
        const result = (await get()).structuredContent;
        expect(result).toMatchObject({ body: 'Details', bodyTruncated: false, bodyOffset: null, bodyNextOffset: null,
            bodyTotalBytes: 7, maskingVersion: 'known-secrets-v1' });
        expect(result.bodyRevision).toMatch(/^[a-f0-9]{64}$/);
    });
    it('A11 : lit le corps par pages UTF-8 sans perte avec révision obligatoire', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockResolvedValue({ ...issue, body: 'A😀B' });
        const first = (await get({ includeComments: false, bodyOffset: 0, bodyLimit: 3 })).structuredContent as Record<string, unknown>;
        expect(first).toMatchObject({ body: 'A😀', bodyTruncated: true, bodyOffset: 0, bodyNextOffset: 5, bodyTotalBytes: 6 });
        const second = (await get({ includeComments: false, bodyOffset: first.bodyNextOffset, bodyRevision: first.bodyRevision })).structuredContent;
        expect(second).toMatchObject({ body: 'B', bodyTruncated: false, bodyOffset: 5, bodyNextOffset: null, bodyRevision: first.bodyRevision });
        issues.getIssue.mockClear();
        expect(await get({ bodyOffset: 5 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'COMMENT_REVISION_REQUIRED' } } });
        expect(issues.getIssue).not.toHaveBeenCalled();
        expect(await get({ bodyOffset: 2, bodyRevision: first.bodyRevision })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_COMMENT_OFFSET' } } });
        expect(await get({ bodyOffset: 7, bodyRevision: first.bodyRevision })).toMatchObject({ isError: true, structuredContent: { error: { code: 'INVALID_COMMENT_OFFSET' } } });
    });
    it('A11 : refuse de mélanger deux versions du corps entre deux pages', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockResolvedValue({ ...issue, body: 'ancienne version du plan' });
        const first = (await get({ includeComments: false, bodyOffset: 0, bodyLimit: 8 })).structuredContent as Record<string, unknown>;
        issues.getIssue.mockResolvedValue({ ...issue, body: 'nouvelle version du plan' });
        expect(await get({ includeComments: false, bodyOffset: first.bodyNextOffset, bodyRevision: first.bodyRevision }))
            .toMatchObject({ isError: true, structuredContent: { error: { code: 'DISCUSSION_ITEM_CHANGED' } } });
    });
    it('A11 : reconstruit exactement un long corps masqué (emoji, accents, combinants, CRLF, secret)', async () => {
        const { get, issues } = fixture();
        const unit = 'Plan é😀 é 漢字\r\nligne ghp_SECRETTOKEN fin\n';
        const source = unit.repeat(900);
        issues.getIssue.mockResolvedValue({ ...issue, body: source });
        const parts: string[] = [];
        let offset: number | null = 0;
        let revision: string | undefined;
        let pages = 0;
        while (offset !== null) {
            const page = (await get({ includeComments: false, bodyOffset: offset, ...(revision ? { bodyRevision: revision } : {}) })).structuredContent as Record<string, unknown>;
            expect(page.bodyOffset).toBe(offset);
            const next = page.bodyNextOffset as number | null;
            if (next !== null) expect(next).toBeGreaterThan(offset);
            expect(new TextEncoder().encode(String(page.body)).length).toBeLessThanOrEqual(12_003);
            expect(String(page.body)).not.toContain('�');
            parts.push(String(page.body));
            revision = page.bodyRevision as string;
            offset = next;
            pages += 1;
        }
        const rebuilt = parts.join('');
        expect(pages).toBeGreaterThan(3);
        expect(rebuilt).toBe(source.replaceAll('ghp_SECRETTOKEN', '[jeton masqué]'));
        expect(rebuilt).not.toContain('SECRETTOKEN');
        expect(new TextEncoder().encode(rebuilt).length).toBe((await get({ includeComments: false })).structuredContent.bodyTotalBytes);
        expect(await maskedRevision(rebuilt)).toBe(revision);
    });
    it('A11 : refuse aussi une PR en mode page', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockResolvedValue({ ...issue, pull_request: {} });
        expect(await get({ bodyOffset: 0 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_AN_ISSUE' } } });
    });
    it('ne publie pas les messages d’erreur distants', async () => {
        const { get, issues } = fixture();
        issues.getIssue.mockRejectedValue(new GitHubApiError(422, '/app/installations/2/access_tokens', 'SECRET'));
        const result = await get();
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'APP_PERMISSIONS_REJECTED' } } });
        expect(JSON.stringify(result)).not.toContain('SECRET');
    });
    it('omet les corps de la liste pour rester borné même avec 50 issues longues', async () => {
        const { list, issues } = fixture();
        issues.listIssuesPage.mockResolvedValue({ issues: Array.from({ length: 50 }, () => ({ ...issue, body: 'x'.repeat(70000) })), potentiallyTruncated: true });
        const result = (await list({ limit: 50 })).structuredContent;
        expect(result).toMatchObject({ nextPage: 2, potentiallyTruncated: true });
        expect((result.issues as object[])[0]).not.toHaveProperty('body');
        expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(160000);
    });
    it('conserve une page suivante quand une page GitHub ne contient que des PR', async () => {
        const request = vi.fn(async () => [{ ...issue, pull_request: {} }]);
        const service = new GitHubIssues({ request, repoPath: () => '/repos/o/r/issues',
            withQuery: (p: string, q: Record<string, string | number>) => p + '?' + new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])),
            assertPositiveInteger: () => { } } as unknown as GitHubServiceContext);
        expect(await service.listIssuesPage('o/r', { state: 'all', limit: 1, page: 2 }))
            .toEqual({ issues: [], potentiallyTruncated: true });
        expect(request).toHaveBeenCalledWith('/repos/o/r/issues?state=all&per_page=1&page=2');
    });
});

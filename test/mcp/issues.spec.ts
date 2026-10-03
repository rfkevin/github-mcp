import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import type { GitHubIssue, GitHubComment } from '../../src/github/types';
import { GitHubApiError } from '../../src/github/types';
import { GitHubIssues } from '../../src/github/issues';
import type { GitHubServiceContext } from '../../src/github/service-context';
import { registerIssueTools } from '../../src/mcp/tools/github/issues';
import { toolRegistry } from './tool-registry';
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

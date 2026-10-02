import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { IssueWriteCoordinator } from '../../src/writes/issues';
import { GitHubApiError, type GitHubComment, type GitHubIssue } from '../../src/github/types';
import { registerIssueWriteTools } from '../../src/mcp/tools/github/issue-writes';
import { toolRegistry } from './tool-registry';

function fixture() {
  const repositories = { listInstallationRepositories: vi.fn(async () => ['o/r']),
    getRepository: vi.fn(async () => ({ full_name: 'o/r', private: true, default_branch: 'master', archived: false })) };
  const baseIssue: GitHubIssue = { number: 18, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/18', labels: [] };
  const issues = {
    createIssue: vi.fn(async (_repository: string, _title: string, _body?: string, _options?: { labels?: readonly string[]; assignees?: readonly string[] }): Promise<GitHubIssue> => baseIssue),
    getIssue: vi.fn(async (_repository: string, _number: number): Promise<GitHubIssue> => baseIssue),
    createComment: vi.fn(async (_repository: string, _number: number, _body: string): Promise<GitHubComment> => ({ id: 7, html_url: 'https://github.com/o/r/issues/18#issuecomment-7', body: 'x', created_at: '2026-10-02T00:00:00Z' })),
  };
  const issueWriteCoordinator = new IssueWriteCoordinator('123', repositories, issues);
  const tools = toolRegistry(registerIssueWriteTools, { actor: '123', issueWriteCoordinator } as ToolContext);
  return {
    repositories, issues,
    create: (input: object = {}) => tools.get('github_create_issue')!({ repository: 'o/r', title: 'Bug', body: 'Details', agentLabel: 'Codex', ...input }),
    comment: (input: object = {}) => tools.get('github_comment_issue')!({ repository: 'o/r', number: 18, body: 'Avis', agentLabel: 'Codex', ...input }),
  };
}
describe('Écritures d’issue : création et commentaire attribués', () => {
  it('crée une issue et publie uniquement son résumé avec attribution dans le corps', async () => {
    const { create, issues } = fixture();
    expect((await create()).structuredContent).toMatchObject({ repository: 'o/r', number: 18, state: 'open', url: 'https://github.com/o/r/issues/18' });
    expect(issues.createIssue).toHaveBeenCalledExactlyOnceWith('o/r', 'Bug', 'Création MCP — compte GitHub 123 — agent déclaré : Codex\n\nDetails');
  });
  it('commente une issue après vérification et attribue le message', async () => {
    const { comment, issues } = fixture();
    expect((await comment()).structuredContent).toMatchObject({ repository: 'o/r', number: 18, id: 7 });
    expect(issues.getIssue).toHaveBeenCalledExactlyOnceWith('o/r', 18);
    expect(issues.createComment).toHaveBeenCalledExactlyOnceWith('o/r', 18, 'Commentaire MCP — compte GitHub 123 — agent déclaré : Codex\n\nAvis');
  });
  it('refuse un numéro de PR avant de commenter', async () => {
    const { comment, issues } = fixture();
    issues.getIssue.mockResolvedValue({ ...baseIssueForTest(), pull_request: {} });
    const result = await comment();
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_AN_ISSUE' } } });
    expect(issues.createComment).not.toHaveBeenCalled();
  });
  it('refuse un dépôt hors installation ou archivé avant la mutation', async () => {
    const { create, comment, repositories, issues } = fixture();
    expect(await create({ repository: 'other/repo' })).toMatchObject({ isError: true });
    repositories.getRepository.mockResolvedValue({ full_name: 'o/r', private: true, default_branch: 'master', archived: true });
    expect(await create()).toMatchObject({ structuredContent: { error: { code: 'REPOSITORY_ARCHIVED' } } });
    expect(await comment()).toMatchObject({ structuredContent: { error: { code: 'REPOSITORY_ARCHIVED' } } });
    expect(issues.createIssue).not.toHaveBeenCalled();
    expect(issues.createComment).not.toHaveBeenCalled();
  });
  it.each([0, 502])('signale un résultat incertain sans rejouer après une erreur %s', async status => {
    const { create, comment, issues } = fixture();
    issues.createIssue.mockRejectedValue(new GitHubApiError(status, '/issues', 'SECRET'));
    const createResult = await create();
    expect(createResult).toMatchObject({ structuredContent: { error: { code: 'WRITE_RESULT_UNKNOWN', retryable: false } } });
    issues.createComment.mockRejectedValue(new GitHubApiError(status, '/issues/18/comments', 'SECRET'));
    const commentResult = await comment();
    expect(commentResult).toMatchObject({ structuredContent: { error: { code: 'WRITE_RESULT_UNKNOWN', retryable: false } } });
    expect(JSON.stringify({ createResult, commentResult })).not.toContain('SECRET');
    expect(issues.createIssue).toHaveBeenCalledOnce();
    expect(issues.createComment).toHaveBeenCalledOnce();
  });
  it('publie une erreur actionnable en cas de permission refusée', async () => {
    const { create, comment, issues } = fixture();
    issues.createIssue.mockRejectedValue(new GitHubApiError(422, '/app/installations/2/access_tokens', 'PRIVATE'));
    expect(await create()).toMatchObject({ isError: true, structuredContent: { error: { message: expect.stringContaining('permissions') } } });
    issues.createComment.mockRejectedValue(new GitHubApiError(422, '/app/installations/2/access_tokens', 'PRIVATE'));
    expect(await comment()).toMatchObject({ isError: true, structuredContent: { error: { message: expect.stringContaining('permissions') } } });
  });
  it('refuse les entrées invalides avant tout appel', async () => {
    const { create, comment, repositories, issues } = fixture();
    await expect(create({ title: ' ' })).rejects.toThrow();
    await expect(comment({ body: ' ' })).rejects.toThrow();
    await expect(comment({ agentLabel: 'agent\nforged' })).rejects.toThrow();
    expect(repositories.listInstallationRepositories).not.toHaveBeenCalled();
    expect(issues.createIssue).not.toHaveBeenCalled();
    expect(issues.createComment).not.toHaveBeenCalled();
  });
  it('reste caché sans coordinateur dédié', () => {
    expect(toolRegistry(registerIssueWriteTools, { actor: '123' } as ToolContext).size).toBe(0);
  });
});

function baseIssueForTest(): GitHubIssue {
  return { number: 18, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/18', labels: [] };
}

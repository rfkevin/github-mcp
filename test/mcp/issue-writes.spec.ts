import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { IssueWriteCoordinator } from '../../src/writes/issues';
import { GitHubApiError } from '../../src/github/types';
import { registerIssueWriteTools } from '../../src/mcp/tools/github/issue-writes';
import { toolRegistry } from './tool-registry';

function fixture() {
  const repositories = { listInstallationRepositories: vi.fn(async () => ['o/r']),
    getRepository: vi.fn(async () => ({ full_name: 'o/r', private: true, default_branch: 'master', archived: false })) };
  const issues = { createIssue: vi.fn(async () => ({ number: 18, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/18', labels: [] })) };
  const issueWriteCoordinator = new IssueWriteCoordinator('123', repositories, issues);
  const tools = toolRegistry(registerIssueWriteTools, { actor: '123', issueWriteCoordinator } as ToolContext);
  return { repositories, issues, create: (input: object = {}) => tools.get('github_create_issue')!({ repository: 'o/r', title: 'Bug', body: 'Details', agentLabel: 'Codex', ...input }) };
}
describe('Création d’issue : dépôt autorisé, attribution et résultat incertain', () => {
  it('crée une issue et publie uniquement son résumé avec attribution dans le corps', async () => {
    const { create, issues } = fixture();
    expect((await create()).structuredContent).toMatchObject({ repository: 'o/r', number: 18, state: 'open', url: 'https://github.com/o/r/issues/18' });
    expect(issues.createIssue).toHaveBeenCalledExactlyOnceWith('o/r', 'Bug', 'Création MCP — compte GitHub 123 — agent déclaré : Codex\n\nDetails');
  });
  it('refuse un dépôt hors installation ou archivé avant la mutation', async () => {
    const { create, repositories, issues } = fixture();
    expect(await create({ repository: 'other/repo' })).toMatchObject({ isError: true });
    repositories.getRepository.mockResolvedValue({ full_name: 'o/r', private: true, default_branch: 'master', archived: true });
    expect(await create()).toMatchObject({ structuredContent: { error: { code: 'REPOSITORY_ARCHIVED' } } });
    expect(issues.createIssue).not.toHaveBeenCalled();
  });
  it.each([0, 502])('signale un résultat incertain sans rejouer après une erreur %s', async status => {
    const { create, issues } = fixture();
    issues.createIssue.mockRejectedValue(new GitHubApiError(status, '/issues', 'SECRET'));
    const result = await create();
    expect(result).toMatchObject({ structuredContent: { error: { code: 'WRITE_RESULT_UNKNOWN', retryable: false } } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(issues.createIssue).toHaveBeenCalledOnce();
  });
  it('publie une erreur actionnable en cas de permission refusée', async () => {
    const { create, issues } = fixture();
    issues.createIssue.mockRejectedValue(new GitHubApiError(422, '/app/installations/2/access_tokens', 'PRIVATE'));
    expect(await create()).toMatchObject({ isError: true, structuredContent: { error: { message: expect.stringContaining('permissions') } } });
  });
  it('refuse le titre vide et le nom déclaré invalide avant tout appel', async () => {
    const { create, repositories, issues } = fixture();
    await expect(create({ title: ' ' })).rejects.toThrow();
    await expect(create({ agentLabel: 'agent\nforged' })).rejects.toThrow();
    expect(repositories.listInstallationRepositories).not.toHaveBeenCalled();
    expect(issues.createIssue).not.toHaveBeenCalled();
  });
  it('reste caché sans coordinateur dédié', () => {
    expect(toolRegistry(registerIssueWriteTools, { actor: '123' } as ToolContext).size).toBe(0);
  });
});

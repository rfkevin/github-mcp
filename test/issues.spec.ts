import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { GitHubApiError } from '../src/github/client';
import type { ToolContext } from '../src/mcp/context';
import { registerIssueTools } from '../src/mcp/tools/github/issues';

type ToolResult = { isError?: boolean; structuredContent: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const issue = { number: 11, title: 'Titre', state: 'open', html_url: 'https://github.com/o/r/issues/11',
  body: 'Corps', user: { login: 'alice' }, labels: [{ name: 'bug' }, 'urgent'], assignees: [{ login: 'bob' }] };
const comment = (id: number) => ({ id, html_url: `https://github.com/o/r/issues/11#c${id}`, body: 'Salut',
  user: { login: 'carol' }, created_at: '2026-10-01T00:00:00Z' });

function context() {
  return { actor: '123', issueReads: { issues: {
    getIssue: vi.fn(async () => issue as unknown),
    listComments: vi.fn(async () => [comment(1)] as unknown[]),
  } } };
}

function call(ctx: ReturnType<typeof context>) {
  let handler: Handler | undefined;
  let outputSchema: z.ZodRawShape | undefined;
  const fake = { registerTool: (_name: string, spec: { outputSchema: z.ZodRawShape }, run: Handler) => {
    outputSchema = spec.outputSchema;
    handler = run;
  } };
  registerIssueTools(fake as unknown as McpServer, ctx as unknown as ToolContext);
  return async (args: Record<string, unknown>) => {
    const result = await handler!(args);
    if (!result.isError) z.object(outputSchema!).parse(result.structuredContent);
    return result;
  };
}

describe('github_get_issue', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('lit une issue avec étiquettes, assignés et commentaires, conformes au schéma', async () => {
    const ctx = context();
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: true, commentsPage: 1 });
    expect(result.structuredContent).toMatchObject({ number: 11, title: 'Titre', state: 'open', author: 'alice',
      labels: ['bug', 'urgent'], assignees: ['bob'], body: 'Corps', bodyTruncated: false,
      comments: [{ id: 1, author: 'carol', body: 'Salut', bodyTruncated: false }],
      commentsPotentiallyTruncated: false, commentsPage: 1, nextCommentsPage: null });
    expect(ctx.issueReads.issues.getIssue).toHaveBeenCalledWith('o/r', 11);
    expect(ctx.issueReads.issues.listComments).toHaveBeenCalledWith('o/r', 11, 20, 1);
  });

  it('ne lit pas les commentaires quand includeComments est faux', async () => {
    const ctx = context();
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: false, commentsPage: 1 });
    expect(result.structuredContent).not.toHaveProperty('comments');
    expect(ctx.issueReads.issues.listComments).not.toHaveBeenCalled();
  });

  it('propose la page suivante quand 20 commentaires sont renvoyés', async () => {
    const ctx = context();
    ctx.issueReads.issues.listComments.mockResolvedValue(Array.from({ length: 20 }, (_, index) => comment(index + 1)));
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: true, commentsPage: 1 });
    expect(result.structuredContent).toMatchObject({ commentsPotentiallyTruncated: true, nextCommentsPage: 2 });
  });

  it('masque les secrets connus et borne le corps', async () => {
    const ctx = context();
    ctx.issueReads.issues.getIssue.mockResolvedValue({ ...issue,
      body: `Jeton ghp_CANARY123 puis ${'x'.repeat(30_000)}` });
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: false, commentsPage: 1 });
    expect(JSON.stringify(result)).not.toContain('CANARY123');
    expect(result.structuredContent).toMatchObject({ bodyTruncated: true });
    expect(String(result.structuredContent.body).length).toBeLessThanOrEqual(12_000);
  });

  it('refuse un numéro de Pull Request sans lire les commentaires', async () => {
    const ctx = context();
    ctx.issueReads.issues.getIssue.mockResolvedValue({ ...issue, pull_request: {} });
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: true, commentsPage: 1 });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'NOT_AN_ISSUE' } } });
    expect(ctx.issueReads.issues.listComments).not.toHaveBeenCalled();
  });

  it('signale un droit Issues refusé sans recopier la réponse GitHub', async () => {
    const ctx = context();
    ctx.issueReads.issues.getIssue.mockRejectedValue(
      new GitHubApiError(422, '/app/installations/{id}/access_tokens', 'CANARY'));
    const result = await call(ctx)({ repository: 'o/r', number: 11, includeComments: true, commentsPage: 1 });
    expect(result).toMatchObject({ isError: true,
      structuredContent: { error: { code: 'APP_PERMISSIONS_REJECTED', retryable: false } } });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../src/mcp/context';
import { GitHubHttp } from '../src/github/http';
import { assertWritablePath } from '../src/security/policy';
import { registerPullRequestTools } from '../src/mcp/tools/github/pull-requests';
import { z } from 'zod';

describe('audit : sécurité du client et du contrôleur', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('ne rejoue pas %s après une limitation de débit', async method => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '0' } }));
    const http = new GitHubHttp({ fetcher, userAgent: 'test', timeoutMs: 1_000, getInstallationToken: async () => 'token' });
    await expect(http.request('/repos/o/r/pulls', { method })).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('protège aussi le contrôleur de publication', () => {
    expect(() => assertWritablePath('scripts/deploy/release.mjs')).toThrow();
    expect(() => assertWritablePath('scripts/deploy')).toThrow();
    expect(() => assertWritablePath('scripts/example.ts')).not.toThrow();
  });
  it('une écriture acceptée dont la réponse est illisible reste un résultat incertain', async () => {
    const fetcher = vi.fn(async () => new Response('not-json', { status: 200 }));
    const http = new GitHubHttp({ fetcher, userAgent: 'test', timeoutMs: 1_000, getInstallationToken: async () => 'token' });
    await expect(http.request('/repos/o/r/pulls', { method: 'POST' })).rejects.toMatchObject({ status: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('audit : PR récupérables et réponses bornées', () => {
  const pull = { number: 9, title: 'Fix', state: 'open', draft: true, html_url: 'https://github.com/o/r/pull/9',
    body: 'x'.repeat(30_000), head: { ref: 'mcp/123/fix', sha: 'a'.repeat(40) }, base: { ref: 'master' } };
  function fixture() {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>>();
    const pulls = { pullRequests: { listPullRequests: vi.fn(async () => [pull]), getPullRequest: vi.fn(async () => pull),
      listReviews: vi.fn(async () => []), listReviewComments: vi.fn(async () => []) }, issues: { listComments: vi.fn(async () => []) } };
    registerPullRequestTools({ registerTool: (name: string, spec: { outputSchema: z.ZodRawShape },
      callback: (args: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }>) => {
      handlers.set(name, async args => {
        const result = await callback(args);
        if (!result.isError) z.object(spec.outputSchema).parse(result.structuredContent);
        return result;
      });
    } } as unknown as McpServer,
      { actor: '123', pulls } as unknown as ToolContext);
    return { handlers, pulls };
  }
  it('retrouve une PR par sa branche sans télécharger les discussions', async () => {
    const { handlers, pulls } = fixture();
    const result = await handlers.get('github_list_pull_requests')!({ repository: 'o/r', state: 'open', branch: 'mcp/123/fix', limit: 20 });
    expect(result.structuredContent).toMatchObject({ potentiallyTruncated: false });
    expect(pulls.pullRequests.listPullRequests).toHaveBeenCalledWith('o/r', { state: 'open', head: 'o:mcp/123/fix', limit: 20 });
    expect(pulls.issues.listComments).not.toHaveBeenCalled();
  });
  it('la description d’une PR est bornée, les appels complémentaires sont opt-in', async () => {
    const { handlers, pulls } = fixture();
    const result = await handlers.get('github_get_pull_request')!({ repository: 'o/r', number: 9, includeDiscussion: false });
    expect(result.structuredContent).toMatchObject({ bodyTruncated: true, headSha: 'a'.repeat(40) });
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(15_000);
    expect(pulls.pullRequests.listReviews).not.toHaveBeenCalled();
    await handlers.get('github_get_pull_request')!({ repository: 'o/r', number: 9, includeDiscussion: true });
    expect(pulls.issues.listComments).toHaveBeenCalledWith('o/r', 9, 20, 1);
  });
  it('permet de poursuivre les échanges au-delà de la première page', async () => {
    const { handlers, pulls } = fixture();
    pulls.issues.listComments.mockResolvedValue(Array.from({ length: 20 }, (_, id) => ({ id, body: 'Review', html_url: '', created_at: '' })) as never);
    const result = await handlers.get('github_get_pull_request')!({ repository: 'o/r', number: 9, includeDiscussion: true, discussionPage: 2 });
    expect(result.structuredContent).toMatchObject({ discussionPage: 2, nextDiscussionPage: 3, discussionPotentiallyTruncated: true });
    expect(pulls.issues.listComments).toHaveBeenCalledWith('o/r', 9, 20, 2);
    expect(pulls.pullRequests.listReviewComments).toHaveBeenCalledWith('o/r', 9, 20, 2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { registerDiscussionItemTools } from '../../src/mcp/tools/github/discussion-items';
import { toolRegistry } from './tool-registry';

function fixture() {
  const pullRequests = {
    getReview: vi.fn(async () => ({ id: 3, state: 'COMMENTED', body: 'revue 😀 complète', user: { login: 'reviewer' }, html_url: 'https://github.com/o/r/pull/11#pullrequestreview-3', submitted_at: '2026-10-03T10:00:00Z' })),
    getReviewComment: vi.fn(async () => ({ id: 4, path: 'src/app.ts', line: 8, body: 'inline 😀 complet', user: { login: 'reviewer' }, html_url: 'https://github.com/o/r/pull/11#discussion_r4', created_at: '2026-10-03T10:01:00Z', updated_at: '2026-10-03T10:02:00Z' })),
  };
  const commits = { getComment: vi.fn(async () => ({ id: 5, commit_id: 'a'.repeat(40), path: 'src/app.ts', line: 2, body: 'commit 😀 complet', user: { login: 'reviewer' }, html_url: 'https://github.com/o/r/commit/a#commitcomment-5', created_at: '2026-10-03T10:03:00Z' })) };
  const call = toolRegistry(registerDiscussionItemTools, { actor: '123', pulls: { pullRequests }, reads: { commits } } as unknown as ToolContext);
  return { pullRequests, commits, get: (args: object) => call.get('github_get_discussion_item')!({ repository: 'o/r', offset: 0, limit: 7, ...args }) };
}

describe('lecture ciblée des autres discussions', () => {
  it('lit une revue de PR avec continuation sans perte', async () => {
    const { get } = fixture();
    const first = (await get({ kind: 'pull_request_review', id: 3, pullNumber: 11 })).structuredContent as Record<string, unknown>;
    expect(first).toMatchObject({ kind: 'pull_request_review', id: 3, state: 'COMMENTED', truncated: true });
    const second = await get({ kind: 'pull_request_review', id: 3, pullNumber: 11, offset: first.nextOffset, revision: first.revision, limit: 100 });
    expect(second.structuredContent).toMatchObject({ truncated: false, nextOffset: null });
  });

  it('lit un commentaire inline et conserve son contexte', async () => {
    const { get } = fixture();
    const result = (await get({ kind: 'pull_request_review_comment', id: 4, limit: 100 })).structuredContent;
    expect(result).toMatchObject({ path: 'src/app.ts', line: 8, updatedAt: '2026-10-03T10:02:00Z', content: 'inline 😀 complet' });
  });

  it('lit un commentaire de commit', async () => {
    const { get } = fixture();
    const result = (await get({ kind: 'commit_comment', id: 5, limit: 100 })).structuredContent;
    expect(result).toMatchObject({ id: 5, path: 'src/app.ts', line: 2, content: 'commit 😀 complet' });
  });

  it('exige pullNumber pour une revue et refuse les chemins sensibles', async () => {
    const { get, pullRequests } = fixture();
    expect(await get({ kind: 'pull_request_review', id: 3 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'PULL_NUMBER_REQUIRED' } } });
    pullRequests.getReviewComment.mockResolvedValueOnce({ id: 9, path: '.env', line: 1, body: 'secret', html_url: 'https://example.invalid' });
    expect(await get({ kind: 'pull_request_review_comment', id: 9 })).toMatchObject({ isError: true, structuredContent: { error: { code: 'SENSITIVE_FILE' } } });
  });
});

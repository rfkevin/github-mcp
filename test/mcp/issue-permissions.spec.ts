import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../src/config';
import { createToolContext } from '../../src/mcp/context';
import { createPrivateKeyPem } from '../github/helpers';

describe('Issues Write : jeton indépendant et activation explicite', () => {
  let privateKey: string;
  beforeAll(async () => { privateKey = await createPrivateKeyPem(); });
  const env = () => ({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_PRIVATE_KEY: privateKey, GITHUB_WRITES_ENABLED: 'true' } as AppEnv);
  it('ne crée aucun coordinateur d’issue sans activation et consentement réunis', () => {
    expect(createToolContext(env(), '123', ['mcp:read']).issueWriteCoordinator).toBeUndefined();
    expect(createToolContext({ ...env(), GITHUB_WRITES_ENABLED: 'false' }, '123', ['mcp:read', 'mcp:write']).issueWriteCoordinator).toBeUndefined();
  });
  it.each([true, false])('isole un refus Issues Write des lectures et commentaires PR : refus=%s', async rejected => {
    const permissions: unknown[] = [], posts: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) {
        const permission = JSON.parse(String(init?.body)).permissions;
        permissions.push(permission);
        return permission.issues === 'write' && rejected ? new Response(null, { status: 422 }) : Response.json({ token: 'fake' });
      }
      if (init?.method === 'POST') posts.push(url);
      if (url.endsWith('/installation/repositories?per_page=100&page=1')) return Response.json({ repositories: [{ full_name: 'o/r' }] });
      if (url.endsWith('/repos/o/r')) return Response.json({ full_name: 'o/r', default_branch: 'master' });
      if (url.includes('/pulls/')) return Response.json({ state: 'open', head: { sha: 'a'.repeat(40), repo: { full_name: 'o/r' } } });
      if (url.endsWith('/comments')) return Response.json({ id: 1, html_url: 'https://github.com/o/r/pull/1#comment' });
      if (url.endsWith('/issues')) return Response.json({ number: 2, title: 'Bug', state: 'open', html_url: 'https://github.com/o/r/issues/2' });
      if (url.includes('/issues/')) return Response.json({ number: 1 });
      if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
      throw new Error('Unexpected request');
    });
    try {
      const ctx = createToolContext(env(), '123', ['mcp:read', 'mcp:write']);
      const creation = ctx.issueWriteCoordinator!.createIssue({ repository: 'o/r', title: 'Bug' });
      if (rejected) await expect(creation).rejects.toMatchObject({ status: 422 });
      else await expect(creation).resolves.toMatchObject({ number: 2 });
      await expect(ctx.issues.getIssue('o/r', 1)).resolves.toMatchObject({ number: 1 });
      await expect(ctx.reads.commits.getCommit('o/r', 'master')).resolves.toMatchObject({ sha: 'a'.repeat(40) });
      await expect(ctx.writeCoordinator!.commentPullRequest({ repository: 'o/r', number: 1, expectedHeadSha: 'a'.repeat(40), body: 'Review' })).resolves.toMatchObject({ id: 1 });
      expect(permissions).toEqual([{ metadata: 'read' }, { metadata: 'read', issues: 'write' },
        { metadata: 'read', issues: 'read' }, { metadata: 'read', contents: 'read' }, { metadata: 'read', pull_requests: 'write' }]);
      expect(posts.filter(url => url.endsWith('/issues'))).toHaveLength(rejected ? 0 : 1);
    } finally { spy.mockRestore(); }
  });
});

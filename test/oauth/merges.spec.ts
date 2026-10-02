import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';
import { args, HEAD, BASE, NEXT, mergeFixture } from '../merges/helpers';
const { settings, mcpSession, callTool, toolJson } = createOAuthFixture();

describe('Résolution de conflits via OAuth et transport MCP', () => {
  it('diagnostique puis reprend la base uniquement dans sa branche avec Contents: Write', async () => {
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const { headers } = await mcpSession('mcp:read mcp:write offline_access');
      const fixture = mergeFixture(), permissions: unknown[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/access_tokens')) {
          permissions.push(JSON.parse(String(init?.body)).permissions);
          return Response.json({ token: 'fake' });
        }
        if (url.pathname === '/installation/repositories') return Response.json({ repositories: [{ full_name: 'o/r' }] });
        if (url.pathname === '/repos/o/r') return Response.json({ full_name: 'o/r', default_branch: 'master' });
        return Response.json(await fixture.request(url.pathname, init));
      });
      const diagnosed = await callTool(headers, 'github_get_merge_context', { repository: 'o/r', branch: args.branch }, 1);
      expect(toolJson(diagnosed.body)).toMatchObject({ headSha: HEAD, baseSha: BASE, conflicts: [{ path: 'app.ts' }] });
      expect(fixture.mutations()).toHaveLength(0);
      const resolved = await callTool(headers, 'github_resolve_conflicts', args, 2);
      expect(toolJson(resolved.body)).toMatchObject({ commitSha: NEXT, followUp: { arguments: { ref: NEXT } } });
      expect(permissions).toContainEqual({ metadata: 'read', contents: 'read' });
      expect(permissions).toContainEqual({ metadata: 'read', contents: 'write' });
      expect(permissions.some(p => 'pull_requests' in (p as object) || 'issues' in (p as object))).toBe(false);
      expect(fixture.heads.theirs).toBe(BASE);
      const patch = fixture.mutations().find(([, init]) => init?.method === 'PATCH');
      expect(patch?.[0]).toBe(`/repos/o/r/git/refs/heads/${args.branch}`);
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ sha: NEXT, force: false });
    } finally { delete settings.GITHUB_WRITES_ENABLED; }
  });
});

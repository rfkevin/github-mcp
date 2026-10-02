import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';
const { settings, mcpSession, callTool, toolJson, consent } = createOAuthFixture();

describe('Issues via OAuth et transport MCP', () => {
  it('explique la création d’issues dans le consentement d’écriture', async () => {
    const { html } = await consent('mcp:read mcp:write offline_access');
    expect(html).toContain('des issues');
    expect(html).toContain('permission GitHub Issues en écriture');
  });
  it('crée, liste puis lit la même issue avec des permissions séparées', async () => {
    settings.GITHUB_WRITES_ENABLED = 'true';
    try {
      const { headers } = await mcpSession('mcp:read mcp:write offline_access');
      const permissions: unknown[] = [], mutations: unknown[] = [];
      const issue = { number: 18, title: 'Bug', body: 'Details', state: 'open', labels: [],
        html_url: 'https://github.com/owner/project/issues/18', assignees: [] };
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/access_tokens')) {
          permissions.push(JSON.parse(String(init?.body)).permissions);
          return Response.json({ token: 'installation-token' });
        }
        if (url.includes('/installation/repositories')) return Response.json({ repositories: [{ full_name: 'owner/project' }] });
        if (url.endsWith('/repos/owner/project')) return Response.json({ full_name: 'owner/project', default_branch: 'master' });
        if (init?.method === 'POST' && url.endsWith('/issues')) {
          mutations.push(JSON.parse(String(init.body))); return Response.json(issue, { status: 201 });
        }
        if (url.includes('/issues?')) return Response.json([issue]);
        if (url.endsWith('/issues/18')) return Response.json(issue);
        throw new Error('Unexpected request');
      });
      const created = await callTool(headers, 'github_create_issue', { repository: 'owner/project', title: 'Bug', body: 'Details', agentLabel: 'Codex' }, 1);
      expect(created.status).toBe(200);
      expect(toolJson(created.body)).toMatchObject({ number: 18, url: issue.html_url });
      const listed = await callTool(headers, 'github_list_issues', { repository: 'owner/project' }, 2);
      expect(toolJson(listed.body)).toMatchObject({ issues: [{ number: 18 }] });
      const read = await callTool(headers, 'github_get_issue', { repository: 'owner/project', number: 18, includeComments: false }, 3);
      expect(toolJson(read.body)).toMatchObject({ number: 18, body: 'Details' });
      expect(mutations).toEqual([{ title: 'Bug', body: 'Création MCP — compte GitHub 123 — agent déclaré : Codex\n\nDetails' }]);
      expect(permissions).toContainEqual({ metadata: 'read', issues: 'write' });
      expect(permissions).toContainEqual({ metadata: 'read', issues: 'read' });
      expect(permissions).not.toContainEqual(expect.objectContaining({ contents: 'write' }));
      expect(permissions).not.toContainEqual(expect.objectContaining({ pull_requests: 'write' }));
    } finally { delete settings.GITHUB_WRITES_ENABLED; }
  });
});

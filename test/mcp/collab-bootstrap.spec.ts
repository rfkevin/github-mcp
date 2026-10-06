import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { GitHubApiError } from '../../src/github/types';
import { EMBEDDED_TEMPLATES } from '../../src/collab/bootstrap-manifest';
import { RECORD_PATH, renderRecord } from '../../src/collab/bootstrap';
import { BOOTSTRAP_MANIFEST } from '../../src/collab/bootstrap-manifest';
import { registerCollabBootstrapTools } from '../../src/mcp/tools/github/collab-bootstrap';
import { toolRegistry } from './tool-registry';

const SHA = '1'.repeat(40);

function fixture(files: Record<string, string>, failOn?: string) {
  const getTextFile = vi.fn(async (_repo: string, path: string, ref: string) => {
    if (path === failOn) throw new GitHubApiError(500, path, 'boom');
    const content = files[path];
    if (content === undefined) throw new GitHubApiError(404, path, 'not found');
    expect(ref).toBe(SHA);
    return { sha: 'f'.repeat(40), content };
  });
  const getCommit = vi.fn(async () => ({ sha: SHA }));
  const handlers = toolRegistry(registerCollabBootstrapTools, { actor: '1', reads: { files: { getTextFile }, commits: { getCommit } } } as unknown as ToolContext);
  const call = (ref = 'main') => handlers.get('github_plan_project_bootstrap')!({ repository: 'o/r', ref });
  return { call, getTextFile, getCommit };
}

describe('github_plan_project_bootstrap', () => {
  it('dépôt vide : ready avec trois créations, lues au SHA résolu', async () => {
    const { call, getCommit } = fixture({});
    const result = await call();
    expect(result.isError).toBeFalsy();
    expect(getCommit).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ sha: SHA, status: 'ready' });
    expect((result.structuredContent.operations as unknown[]).length).toBe(3);
  });

  it('dépôt amorcé : unchanged', async () => {
    const { call } = fixture({ ...EMBEDDED_TEMPLATES, [RECORD_PATH]: renderRecord(BOOTSTRAP_MANIFEST) });
    expect((await call(SHA)).structuredContent).toMatchObject({ status: 'unchanged', operations: [] });
  });

  it('fichier incompatible : action_required sans opération', async () => {
    const { call } = fixture({ 'AGENT_MEMORY.md': 'pas de titre' });
    expect((await call()).structuredContent).toMatchObject({ status: 'action_required', operations: [] });
  });

  it('une erreur de lecture autre que 404 échoue sans plan', async () => {
    const { call } = fixture({}, 'AGENTS.md');
    const result = await call();
    expect(result.isError).toBe(true);
  });
});

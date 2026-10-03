import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { registerApplyChangesTool } from '../../src/mcp/tools/github/apply-changes';
import { toolRegistry } from './tool-registry';
const HEAD = 'a'.repeat(40), BLOB = 'b'.repeat(40), NEXT = 'c'.repeat(40);

function fixture() {
  const reads = {
    branches: { getBranchHead: vi.fn(async () => HEAD) },
    files: { getTextFile: vi.fn(async (_repo: string, path: string) => ({ path, sha: BLOB, size: 3, content: 'old' })) },
    commits: { getCommit: vi.fn(async () => ({ sha: 'd'.repeat(40) })) },
  };
  const commitChanges = vi.fn(async () => ({ repository: 'o/r', branch: 'mcp/123/fix', commitSha: NEXT, changedPaths: ['a.txt'], deletedPaths: [],
    followUp: { taskComplete: false, reason: 'verify', nextTool: 'github_ci_status', arguments: { repository: 'o/r', ref: NEXT }, nextPollSeconds: 15, instruction: 'verify' }, note: 'commit' }));
  const writeCoordinator = { branchPrefix: 'mcp/123/', commitChanges };
  const tools = toolRegistry(registerApplyChangesTool, { actor: '123', reads, writeCoordinator } as unknown as ToolContext);
  const apply = (operations: object[]) => tools.get('github_apply_changes')!({ repository: 'o/r', branch: 'mcp/123/fix', expectedHeadSha: HEAD, message: 'Batch', agentLabel: 'ChatGPT', operations });
  return { reads, commitChanges, apply };
}

describe('github_apply_changes', () => {
  it('publie une seule fois un lot valide', async () => {
    const { apply, commitChanges } = fixture();
    const result = await apply([{ type: 'replace', path: 'a.txt', expectedSha: BLOB, oldText: 'old', newText: 'new' }]);
    expect(result.structuredContent).toMatchObject({ status: 'applied', applied: true, atomic: true, commitSha: NEXT });
    expect(commitChanges).toHaveBeenCalledOnce();
    expect(commitChanges.mock.calls[0][0].changes).toEqual([{ path: 'a.txt', content: 'new', expectedSha: BLOB }]);
  });
  it('retourne rejected sans commit et collecte les erreurs', async () => {
    const { apply, commitChanges } = fixture();
    const result = await apply([
      { type: 'replace', path: 'a.txt', expectedSha: 'e'.repeat(40), oldText: 'old', newText: 'new' },
      { type: 'replace', path: 'b.txt', expectedSha: BLOB, oldText: 'missing', newText: 'new' },
    ]);
    expect(result.structuredContent).toMatchObject({ status: 'rejected', applied: false, errors: [{ index: 0 }, { index: 1 }] });
    expect(commitChanges).not.toHaveBeenCalled();
  });
  it('reste absent sans coordinateur d’écriture', () => {
    expect(toolRegistry(registerApplyChangesTool, { actor: '123' } as ToolContext).size).toBe(0);
  });
});

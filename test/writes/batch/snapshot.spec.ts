import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '../../../src/github/types';
import { loadBatchSnapshot } from '../../../src/writes/batch/snapshot';
import type { BatchOperation } from '../../../src/writes/batch/schema';
const HEAD = 'a'.repeat(40), SOURCE = 'b'.repeat(40), BLOB = 'c'.repeat(40);
function file(path: string, content: string) { return { path, content, sha: BLOB, size: content.length }; }

describe('batch snapshot', () => {
  it('lit chaque cible une fois, résout une ref une fois et cache les sources par commit+chemin', async () => {
    const files = { getTextFile: vi.fn(async (_repo: string, path: string, ref: string) => file(path, ref === HEAD ? `current-${path}` : `source-${path}`)) };
    const commits = { getCommit: vi.fn(async () => ({ sha: SOURCE })) };
    const operations: BatchOperation[] = [
      { type: 'restore', path: 'a.txt', expectedSha: BLOB, sourceRef: 'good' },
      { type: 'restore', path: 'b.txt', expectedSha: BLOB, sourceRef: 'good' },
    ];
    const result = await loadBatchSnapshot({ branches: { getBranchHead: vi.fn(async () => HEAD) }, files, commits }, 'o/r', 'mcp/123/fix', HEAD, operations);
    expect(commits.getCommit).toHaveBeenCalledOnce();
    expect(result.sources.get(`o/r\n${SOURCE}\na.txt`)?.content).toBe('source-a.txt');
    expect(result.sources.get(`o/r\n${SOURCE}\nb.txt`)?.content).toBe('source-b.txt');
  });
  it('ne transforme que 404 en absence et refuse un head périmé avant les fichiers', async () => {
    const files = { getTextFile: vi.fn(async () => { throw new GitHubApiError(403, '/x', 'forbidden'); }) };
    const deps = { branches: { getBranchHead: vi.fn(async () => HEAD) }, files, commits: { getCommit: vi.fn(async () => ({ sha: SOURCE })) } };
    await expect(loadBatchSnapshot(deps, 'o/r', 'mcp/123/fix', 'd'.repeat(40), [])).rejects.toMatchObject({ code: 'HEAD_CHANGED' });
    expect(files.getTextFile).not.toHaveBeenCalled();
    await expect(loadBatchSnapshot(deps, 'o/r', 'mcp/123/fix', HEAD, [{ type: 'create', path: 'a.txt', content: 'x' }])).rejects.toBeInstanceOf(GitHubApiError);
  });
});

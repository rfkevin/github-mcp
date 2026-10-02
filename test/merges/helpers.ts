import { vi } from 'vitest';
import type { GitHubServiceContext } from '../../src/github/service-context';
import { GitHubMerges } from '../../src/github/merges';
import { MergeCoordinator } from '../../src/merges/coordinator';
import { assertWritableBranch } from '../../src/security/policy';
import { mergeTree } from '../../src/merges/plan';
import type { GitHubTreeEntry } from '../../src/github/types';

export const HEAD = '1'.repeat(40), BASE = '2'.repeat(40), ANCESTOR = '3'.repeat(40), NEXT = '4'.repeat(40);
export const OLD = 'a'.repeat(40), OURS = 'b'.repeat(40), THEIRS = 'c'.repeat(40), EXTRA = 'd'.repeat(40);
export const args = { repository: 'o/r', branch: 'mcp/123/fix', expectedHeadSha: HEAD,
  expectedBaseSha: BASE, message: 'Resolve', agentLabel: 'Codex', resolutions: [{ path: 'app.ts', choice: 'content' as const, content: 'merged' }] };
export const entry = (path: string, sha: string, extra = {}) => ({ path, sha, mode: '100644', type: 'blob', size: 5, ...extra });
export const asTree = (entries: GitHubTreeEntry[]) => mergeTree({ truncated: false, tree: entries });

export function mergeFixture(files = {
  ancestor: [entry('app.ts', OLD)], ours: [entry('app.ts', OURS)], theirs: [entry('app.ts', THEIRS), entry('new.ts', EXTRA)],
}) {
  const heads = { ours: HEAD, theirs: BASE };
  const blobs: Record<string, string> = { [OLD]: 'old', [OURS]: 'ours', [THEIRS]: 'their', [EXTRA]: 'extra' };
  const request = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => {
    if (init?.method === 'POST' && url.endsWith('/git/trees')) return { sha: NEXT };
    if (init?.method === 'POST' && url.endsWith('/git/commits')) return { sha: NEXT };
    if (init?.method === 'PATCH') { heads.ours = JSON.parse(String(init.body)).sha; return {}; }
    if (url.includes('/compare/')) return { merge_base_commit: { sha: ANCESTOR } };
    if (url.includes('/git/commits/')) {
      const sha = url.split('/').at(-1)!; return { sha, tree: { sha } };
    }
    if (url.includes('/git/trees/')) {
      const commit = url.split('/').at(-1);
      return { truncated: false, tree: commit === HEAD ? files.ours : commit === BASE ? files.theirs : files.ancestor };
    }
    if (url.includes('/git/ref/heads/')) return { object: { sha: url.endsWith('/master') ? heads.theirs : heads.ours } };
    if (url.includes('/git/blobs/')) {
      const content = blobs[url.split('/').at(-1)!];
      const bytes = new TextEncoder().encode(content);
      return { encoding: 'base64', size: bytes.length, content: btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')) };
    }
    throw new Error('Unexpected request');
  });
  const merges = new GitHubMerges({ request, repoPath: (_r: string, suffix: string) => suffix,
    encodeSlashPath: (p: string) => p, withQuery: (p: string) => p, assertWritableBranchName: assertWritableBranch,
  } as unknown as GitHubServiceContext);
  const reads = { repositories: { listInstallationRepositories: vi.fn(async () => ['o/r']),
    getRepository: vi.fn(async () => ({ full_name: 'o/r', private: true, default_branch: 'master', archived: false })) },
    branches: { getBranchHead: vi.fn(async (_r: string, branch: string) => branch === 'master' ? heads.theirs : heads.ours) }, merges };
  const coordinator = new MergeCoordinator('123', reads, merges);
  return { heads, blobs, request, merges, reads, coordinator,
    mutations: () => request.mock.calls.filter(([, init]) => ['POST', 'PATCH'].includes(init?.method ?? '')) };
}

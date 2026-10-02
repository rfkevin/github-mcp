import { vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import type { GitHubServiceContext } from '../../src/github/service-context';
import { WriteCoordinator } from '../../src/writes/coordinator';
import { GitHubChanges } from '../../src/github/changes';
import { registerFileWriteTools } from '../../src/mcp/tools/github/file-writes';
import { toolRegistry } from './tool-registry';

export const HEAD = 'a'.repeat(40), BLOB = 'b'.repeat(40), NEXT = 'c'.repeat(40), SOURCE = 'd'.repeat(40);
export const args = { repository: 'o/r', branch: 'mcp/123/fix', path: 'file.txt', expectedHeadSha: HEAD,
  expectedSha: BLOB, message: 'Fix', agentLabel: 'Codex' };
export function fileWriteFixture(content = 'old\r\n', source = 'restored\n', path = args.path) {
  const request = vi.fn(async (url: string, init?: RequestInit): Promise<unknown> => {
    if (url.includes('/git/ref/')) return { object: { sha: HEAD } };
    if (url.endsWith(`/git/commits/${HEAD}`)) return { tree: { sha: HEAD } };
    if (url.includes('/git/trees/') && !init?.method) return { truncated: false, tree: [{ path, type: 'blob', mode: '100644', sha: BLOB }] };
    if (url.includes('/git/blobs/')) {
      const bytes = new TextEncoder().encode(content);
      return { encoding: 'base64', content: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')), size: bytes.length };
    }
    if (url.endsWith('/git/trees')) return { sha: NEXT };
    if (url.endsWith('/git/commits')) return { sha: NEXT };
    if (url.includes('/git/refs/')) return {};
    throw new Error('Unexpected Git request');
  });
  const changes = new GitHubChanges({ request, repoPath: (_repo: string, suffix: string) => suffix,
    encodeSegment: encodeURIComponent, encodeSlashPath: (p: string) => p, withQuery: (p: string) => p,
    assertWritableBranchName: vi.fn(), policy: {} } as unknown as GitHubServiceContext);
  const reads = { repositories: { listInstallationRepositories: vi.fn(async () => ['o/r']),
    getRepository: vi.fn(async () => ({ full_name: 'o/r', private: true, default_branch: 'master', archived: false })) },
    branches: { getBranchHead: vi.fn(async () => HEAD) },
    files: { getTextFile: vi.fn(async (_repo: string, requestedPath: string, ref: string) => ({
      path: requestedPath, sha: ref === SOURCE ? SOURCE : BLOB, size: content.length, content: ref === SOURCE ? source : content })) },
    commits: { getCommit: vi.fn(async (_repository: string, _ref: string) => ({ sha: SOURCE, html_url: '', commit: { message: '', tree: { sha: SOURCE } } })) } };
  const writes = { branches: { createWorkingBranch: vi.fn() }, changes: { applyChangeSet: vi.fn(changes.applyChangeSet.bind(changes)) },
    pullRequests: { createPullRequest: vi.fn(), getPullRequest: vi.fn() },
    issues: { createComment: vi.fn() }, commits: { createComment: vi.fn() } };
  const coordinator = new WriteCoordinator('123', reads, writes);
  const tools = toolRegistry(registerFileWriteTools, { actor: '123', reads, writeCoordinator: coordinator } as unknown as ToolContext);
  return { reads, writes, request, append: (input: object = {}) => tools.get('github_append_file')!({ ...args, path, text: '\nnew\n', ...input }),
    restore: (input: object = {}) => tools.get('github_restore_file')!({ ...args, path, sourceRef: SOURCE, ...input }) };
}

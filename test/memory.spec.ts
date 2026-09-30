import { describe, expect, it, vi } from 'vitest';
import { AGENT_MEMORY_PATH, assertMemoryAppend } from '../src/agent-memory';
import { GitHubChanges } from '../src/github/changes';
import type { GitHubServiceContext } from '../src/github/service-context';
import { assertWritableBranch, assertWritablePath } from '../src/security/policy';

const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const PREVIOUS = '# Mémoire\r\n\r\n### note-1\r\nAuteur : Claude\r\nConseil vérifié.\r\n';
const APPENDED = `${PREVIOUS}\n### note-2\nAuteur : Codex\nMerci aux collaborateurs.\n`;
const blobFor = (content: string) => {
  const bytes = new TextEncoder().encode(content);
  return { content: btoa(String.fromCharCode(...bytes)), encoding: 'base64', size: bytes.length };
};

function fixture(exists = true) {
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/git/ref/heads/mcp/123/memo') return { object: { sha: HEAD } };
    if (path === `/git/commits/${HEAD}`) return { tree: { sha: TREE } };
    if (path === `/git/trees/${TREE}`) return { truncated: false, tree: exists
      ? [{ path: AGENT_MEMORY_PATH, type: 'blob', sha: BLOB, mode: '100644' }] : [] };
    if (path === `/git/blobs/${BLOB}`) return blobFor(PREVIOUS);
    if (path === '/git/trees' && init?.method === 'POST') return { sha: 'new-tree' };
    if (path === '/git/commits' && init?.method === 'POST') return { sha: 'new-commit' };
    if (path === '/git/refs/heads/mcp/123/memo' && init?.method === 'PATCH') return {};
    throw new Error(`Unexpected request: ${path}`);
  });
  const changes = new GitHubChanges({ request, assertWritableBranchName: assertWritableBranch,
    assertWritablePath, encodeSegment: encodeURIComponent, encodeSlashPath: (value: string) => value,
    repoPath: (_repo: string, suffix: string) => suffix, withQuery: (value: string) => value,
    policy: {},
  } as unknown as GitHubServiceContext);
  const commit = (content: string, expectedSha = exists ? BLOB : undefined, expectedHeadSha = HEAD) =>
    changes.applyChangeSet('owner/project', 'mcp/123/memo', [{ path: AGENT_MEMORY_PATH, content, expectedSha }],
      'Add memory note', { expectedHeadSha });
  const mutations = () => request.mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH');
  return { request, changes, commit, mutations };
}

describe('mémoire : conservation exacte des contributions', () => {
  it('accepte un ajout, un contenu identique et les caractères UTF-8 sans normalisation', () => {
    assertMemoryAppend(blobFor(PREVIOUS), APPENDED);
    assertMemoryAppend(blobFor(PREVIOUS), PREVIOUS);
    assertMemoryAppend(blobFor('\uFEFFé🙂\r\n'), '\uFEFFé🙂\r\nSuite');
  });
  it.each(['', 'Remplacement', PREVIOUS.replace('Claude', 'Codex'), PREVIOUS.replaceAll('\r\n', '\n'),
    `Préface\n${PREVIOUS}`, PREVIOUS.slice(0, -1)])('refuse la réécriture %j', content => {
    expect(() => assertMemoryAppend(blobFor(PREVIOUS), content)).toThrow(expect.objectContaining({ code: 'MEMORY_APPEND_ONLY' }));
  });
  it.each([{ encoding: 'utf8' }, { size: 1_000_001 }, { size: -1 }, { size: 0 }, { size: 1.5 },
    { content: '!not-base64!' }, { content: 'a'.repeat(1_400_001) }])('refuse un blob illisible ou incomplet', change => {
    expect(() => assertMemoryAppend({ ...blobFor(PREVIOUS), ...change }, APPENDED))
      .toThrow(expect.objectContaining({ code: 'MEMORY_UNREADABLE' }));
  });
});

describe('mémoire : protection dans les commits GitHub', () => {
  it('lit le blob du snapshot avant toute écriture et conserve le contrôle de branche', async () => {
    const { request, commit, mutations } = fixture();
    await expect(commit(APPENDED)).resolves.toMatchObject({ commitSha: 'new-commit' });
    const calls = request.mock.calls;
    expect(calls.findIndex(([path]) => path === `/git/blobs/${BLOB}`))
      .toBeLessThan(calls.findIndex(([, init]) => init?.method === 'POST'));
    const tree = JSON.parse(String(mutations()[0][1]?.body));
    expect(tree.tree[0]).toMatchObject({ path: AGENT_MEMORY_PATH, content: APPENDED });
    expect(JSON.parse(String(mutations().at(-1)?.[1]?.body))).toEqual({ sha: 'new-commit', force: false });
  });
  it('crée une mémoire absente sans tenter de lire un ancien blob', async () => {
    const { request, commit } = fixture(false);
    await expect(commit(APPENDED)).resolves.toMatchObject({ changedPaths: [AGENT_MEMORY_PATH] });
    expect(request.mock.calls.some(([path]) => path.includes('/git/blobs/'))).toBe(false);
  });
  it('refuse une modification des anciennes notes avant toute mutation', async () => {
    const { commit, mutations } = fixture();
    await expect(commit(PREVIOUS.replace('Claude', 'Codex'))).rejects.toMatchObject({ code: 'MEMORY_APPEND_ONLY' });
    expect(mutations()).toEqual([]);
  });
  it('refuse suppression et renommage avant tout appel GitHub', async () => {
    const { changes, request } = fixture();
    for (const additions of [[], [{ path: 'archive.md', content: PREVIOUS }]]) {
      await expect(changes.applyChangeSet('owner/project', 'mcp/123/memo', additions, 'Delete memory',
        { expectedHeadSha: HEAD, deletions: [{ path: AGENT_MEMORY_PATH, expectedSha: BLOB }] }))
        .rejects.toMatchObject({ code: 'MEMORY_APPEND_ONLY' });
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('refuse les SHA périmés sans écraser un ajout concurrent', async () => {
    const { commit, mutations } = fixture();
    await expect(commit(APPENDED, HEAD)).rejects.toThrow();
    await expect(commit(APPENDED, BLOB, TREE)).rejects.toThrow();
    expect(mutations()).toEqual([]);
  });
  it('ne continue pas si la lecture du blob échoue', async () => {
    const { request, commit, mutations } = fixture();
    const implementation = request.getMockImplementation()!;
    request.mockImplementation(async (path, init) => {
      if (path.includes('/git/blobs/')) throw new Error('Read failed');
      return implementation(path, init);
    });
    await expect(commit(APPENDED)).rejects.toThrow('Read failed');
    expect(mutations()).toEqual([]);
  });
  it('ne relit pas la mémoire pour un commit sans rapport', async () => {
    const { changes, request } = fixture();
    await changes.applyChangeSet('owner/project', 'mcp/123/memo', [{ path: 'README.md', content: 'New' }],
      'Add README', { expectedHeadSha: HEAD });
    expect(request.mock.calls.some(([path]) => path.includes('/git/blobs/'))).toBe(false);
  });
});

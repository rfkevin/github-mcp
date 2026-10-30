import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../../src/github/client';
import { BatchChangeCoordinator } from '../../../src/writes/batch/coordinator';
import { WriteCoordinator } from '../../../src/writes/coordinator';
import { createPrivateKeyPem, INSTALLATION_TOKEN, jsonResponse, requestUrl, type RecordedRequest } from '../../github/helpers';

// Garantie centrale de github_apply_changes (V1) : le lot est préparé sur un
// instantané au SHA attendu, puis publié par le vrai service de commits.
// Si la branche avance entre l'instantané et la publication, rien n'est écrit.
const REPO = 'owner/project';
const BRANCH = 'mcp/123/batch';
const HEAD = 'a'.repeat(40);
const MOVED = 'f'.repeat(40);
const BLOB = 'b'.repeat(40);

type Scenario = { liveHead: string; refUpdate?: 'ok' | 'non_fast_forward' };

function setup(privateKey: string, scenario: Scenario) {
  const requests: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });
    const method = init?.method ?? 'GET';
    if (url.endsWith('/access_tokens')) return jsonResponse({ token: INSTALLATION_TOKEN });
    if (url.endsWith(`/git/ref/heads/${BRANCH}`) && method === 'GET') return jsonResponse({ object: { sha: scenario.liveHead } });
    if (url.endsWith(`/git/commits/${scenario.liveHead}`)) return jsonResponse({ sha: scenario.liveHead, tree: { sha: 'tree-live' } });
    if (url.includes('/git/trees/tree-live')) {
      return jsonResponse({ truncated: false, tree: [{ path: 'a.txt', type: 'blob', sha: BLOB, mode: '100644' }] });
    }
    if (url.endsWith('/git/trees') && method === 'POST') return jsonResponse({ sha: 'tree-new' });
    if (url.endsWith('/git/commits') && method === 'POST') return jsonResponse({ sha: 'c'.repeat(40) });
    if (url.endsWith(`/git/refs/heads/${BRANCH}`) && method === 'PATCH') {
      return scenario.refUpdate === 'non_fast_forward'
        ? new Response(JSON.stringify({ message: 'Update is not a fast forward' }), { status: 422, headers: { 'content-type': 'application/json' } })
        : jsonResponse({ object: { sha: 'c'.repeat(40) } });
    }
    return new Response('Not Found', { status: 404 });
  };
  const client = new GitHubClient({ appId: '1', privateKey, installationId: '2', fetcher });

  // Instantané du lot : la branche est encore au SHA attendu.
  const reads = {
    repositories: {
      listInstallationRepositories: vi.fn(async () => [REPO]),
      getRepository: vi.fn(async () => ({ full_name: REPO, default_branch: 'master', private: true, archived: false })),
    },
    branches: { getBranchHead: vi.fn(async () => HEAD) },
    commits: { getCommit: vi.fn(async () => ({ sha: HEAD, html_url: '', commit: { message: 'base' } })) },
    files: { getTextFile: vi.fn(async (_repo: string, path: string) => ({ path, sha: BLOB, size: 3, content: 'old' })) },
  };
  const writes = { changes: client.changes } as unknown as ConstructorParameters<typeof WriteCoordinator>[2];
  const writeCoordinator = new WriteCoordinator('123', reads as unknown as ConstructorParameters<typeof WriteCoordinator>[1], writes);
  const batch = new BatchChangeCoordinator(writeCoordinator.branchPrefix, reads, writeCoordinator);
  const apply = () => batch.apply({ repository: REPO, branch: BRANCH, expectedHeadSha: HEAD, message: 'Batch', agentLabel: 'Claude',
    operations: [{ type: 'replace', path: 'a.txt', expectedSha: BLOB, oldText: 'old', newText: 'new' }] });
  const mutations = () => requests.filter(request => request.init?.method && request.init.method !== 'GET' && !request.url.endsWith('/access_tokens'));
  return { apply, mutations, reads };
}

describe('github_apply_changes : concurrence entre instantané et commit', () => {
  let privateKey: string;
  beforeAll(async () => { privateKey = await createPrivateKeyPem(); });

  it('publie quand la branche n’a pas bougé (témoin du montage)', async () => {
    const { apply, mutations } = setup(privateKey, { liveHead: HEAD });
    await expect(apply()).resolves.toMatchObject({ status: 'applied', applied: true, headBeforeSha: HEAD });
    expect(mutations().map(request => request.init?.method)).toEqual(['POST', 'POST', 'PATCH']);
  });

  it('refuse sans aucune écriture si la branche avance après l’instantané', async () => {
    const { apply, mutations, reads } = setup(privateKey, { liveHead: MOVED });
    await expect(apply()).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    expect(reads.branches.getBranchHead).toHaveBeenCalledOnce();
    expect(mutations()).toEqual([]);
  });

  it('ne force jamais la référence si la branche avance pendant la publication', async () => {
    const { apply, mutations } = setup(privateKey, { liveHead: HEAD, refUpdate: 'non_fast_forward' });
    await expect(apply()).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    const patches = mutations().filter(request => request.init?.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0].init?.body))).toMatchObject({ force: false });
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github/client';
import { GitHubHttp } from '../src/github/http';
import { gitFileResponse } from './git-fixtures';

const REPOSITORY = 'owner/project';
const INSTALLATION_TOKEN = 'installation-token';
const FILE_PATH = 'src/app.ts';
const FILE_SHA = 'b'.repeat(40);
const FILE_CONTENT = 'Bonjour 👋\ncafé ☕ — accents : éàü\n';

type RecordedRequest = {
  url: string;
  init?: RequestInit;
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function toBase64(value: string): string {
  return btoa(String.fromCodePoint(...new TextEncoder().encode(value)));
}

function toPkcs8Pem(der: ArrayBuffer): string {
  const base64 = btoa(String.fromCodePoint(...new Uint8Array(der)));
  const lines = base64.match(/.{1,64}/g) ?? [];

  return [
    '-----BEGIN PRIVATE KEY-----',
    ...lines,
    '-----END PRIVATE KEY-----',
  ].join('\n');
}

async function createPrivateKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

  if (!('privateKey' in keyPair)) {
    throw new Error('Paire de clés RSA attendue.');
  }

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  if (!(pkcs8 instanceof ArrayBuffer)) {
    throw new Error('Export PKCS#8 attendu.');
  }

  return toPkcs8Pem(pkcs8);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }

  throw new Error('Rejet attendu.');
}

function createFetchStub(payload: Record<string, unknown>): {
  fetcher: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });

    if (url.endsWith('/access_tokens')) {
      return jsonResponse({ token: INSTALLATION_TOKEN });
    }

    const file = gitFileResponse(url, payload as Parameters<typeof gitFileResponse>[1]);
    if (file) return file;

    return new Response('Not Found', { status: 404 });
  };

  return { fetcher, requests };
}

describe('GitHubClient', () => {
  let privateKey: string;

  beforeAll(async () => {
    privateKey = await createPrivateKeyPem();
  });

  it('décode le contenu base64 UTF-8 renvoyé par GitHub', async () => {
    const { fetcher, requests } = createFetchStub({
      type: 'file',
      encoding: 'base64',
      // GitHub renvoie le base64 avec des retours à la ligne.
      content: `${toBase64(FILE_CONTENT)}\n`,
      sha: FILE_SHA,
      path: FILE_PATH,
      size: FILE_CONTENT.length,
    });

    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      userAgent: 'github-mcp-test',
      fetcher,
    });

    const file = await client.files.getTextFile(REPOSITORY, FILE_PATH, 'main');

    expect(file).toEqual({
      path: FILE_PATH,
      sha: FILE_SHA,
      content: FILE_CONTENT,
      size: FILE_CONTENT.length,
    });

    const contentsRequest = requests.at(-1);

    expect(contentsRequest?.url).toBe(
      `https://api.github.com/repos/owner/project/git/blobs/${FILE_SHA}`,
    );
    expect(
      new Headers(contentsRequest?.init?.headers).get('Authorization'),
    ).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it('refuse une ressource qui n’est pas un fichier texte', async () => {
    const { fetcher } = createFetchStub({
      type: 'dir',
      encoding: 'none',
      content: '',
      sha: FILE_SHA,
      path: FILE_PATH,
      size: 0,
    });

    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher,
    });

    await expect(
      client.files.getTextFile(REPOSITORY, FILE_PATH, 'main'),
    ).rejects.toThrow('La ressource demandée n’est pas un fichier texte.');
  });

  it('refuse un dépôt hors liste blanche avant tout appel réseau', async () => {
    let requestCount = 0;
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      allowedRepositories: ['owner/allowed'],
      fetcher: async () => {
        requestCount += 1;
        return new Response();
      },
    });

    expect(() => client.repositories.getRepository(REPOSITORY)).toThrow(
      'Ce dépôt n’est pas autorisé.',
    );
    expect(requestCount).toBe(0);
  });

  it('bloque les chemins sensibles avant tout appel réseau', async () => {
    let requestCount = 0;
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher: async () => {
        requestCount += 1;
        return new Response();
      },
    });

    await expect(
      client.files.getTextFile(REPOSITORY, '.env.production', 'main'),
    ).rejects.toThrow('La lecture de ce fichier sensible est interdite.');
    expect(requestCount).toBe(0);
  });

  it('rafraîchit une fois le jeton après une réponse 401', async () => {
    let tokenRequests = 0;
    let fileRequests = 0;
    const fetcher: typeof fetch = async input => {
      const url = requestUrl(input);

      if (url.endsWith('/access_tokens')) {
        tokenRequests += 1;
        return jsonResponse({ token: `installation-token-${tokenRequests}` });
      }

      if (url.includes('/git/blobs/')) {
        fileRequests += 1;

        if (fileRequests === 1) {
          return new Response(null, { status: 401 });
        }

        return jsonResponse({
          type: 'file',
          encoding: 'base64',
          content: toBase64(FILE_CONTENT),
          sha: FILE_SHA,
          path: FILE_PATH,
          size: FILE_CONTENT.length,
        });
      }

      return gitFileResponse(url, { path: FILE_PATH, sha: FILE_SHA, size: FILE_CONTENT.length,
        content: toBase64(FILE_CONTENT) }) ?? new Response('Not Found', { status: 404 });
    };
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher,
    });

    await expect(client.files.getTextFile(REPOSITORY, FILE_PATH, 'main')).resolves.toMatchObject({
      content: FILE_CONTENT,
    });
    expect(tokenRequests).toBe(2);
    expect(fileRequests).toBe(2);
  });

  it('filtre les dépôts de l’installation avec la liste autorisée', async () => {
    const fetcher: typeof fetch = async input => {
      const url = requestUrl(input);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse({ token: INSTALLATION_TOKEN });
      }
      if (url.includes('/installation/repositories')) {
        return jsonResponse({
          repositories: [
            { full_name: 'owner/project' },
            { full_name: 'owner/other' },
          ],
        });
      }
      return new Response('Not Found', { status: 404 });
    };
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      allowedRepositories: ['OWNER/PROJECT'],
      fetcher,
    });

    await expect(client.repositories.listInstallationRepositories()).resolves.toEqual(['owner/project']);
  });

  it('crée un commit atomique et met à jour la référence sans forcer', async () => {
    const requests: RecordedRequest[] = [];
    const oldSha = 'c'.repeat(40);
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push({ url, init });

      if (url.endsWith('/access_tokens')) {
        return jsonResponse({ token: INSTALLATION_TOKEN });
      }
      if (url.endsWith('/git/ref/heads/mcp/claude/change') && init?.method !== 'PATCH') {
        return jsonResponse({ object: { sha: 'parent-commit' } });
      }
      if (url.endsWith('/git/commits/parent-commit')) {
        return jsonResponse({ sha: 'parent-commit', tree: { sha: 'parent-tree' } });
      }
      if (url.includes('/git/trees/parent-tree')) {
        return jsonResponse({
          truncated: false,
          tree: [
            { path: 'src/old.ts', type: 'blob', sha: oldSha, mode: '100755' },
          ],
        });
      }
      if (url.endsWith('/git/trees') && init?.method === 'POST') {
        return jsonResponse({ sha: 'new-tree' });
      }
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        return jsonResponse({ sha: 'new-commit' });
      }
      if (url.endsWith('/git/refs/heads/mcp/claude/change') && init?.method === 'PATCH') {
        return jsonResponse({});
      }
      return new Response('Not Found', { status: 404 });
    };
    const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });

    await expect(
      client.changes.applyChangeSet(
        REPOSITORY,
        'mcp/claude/change',
        [{ path: 'src/new.ts', content: 'new file' }],
        'Add a file',
        { deletions: [{ path: 'src/old.ts', expectedSha: oldSha }] },
      ),
    ).resolves.toEqual({
      branch: 'mcp/claude/change',
      commitSha: 'new-commit',
      changedPaths: ['src/new.ts'],
      deletedPaths: ['src/old.ts'],
    });

    const treeRequest = requests.find(
      request => request.url.endsWith('/git/trees') && request.init?.method === 'POST',
    );
    const treeBody = JSON.parse(String(treeRequest?.init?.body)) as {
      tree: Array<{ path: string; mode: string; sha?: string | null }>;
    };
    expect(treeBody.tree).toEqual([
      { path: 'src/new.ts', mode: '100644', type: 'blob', content: 'new file' },
      { path: 'src/old.ts', mode: '100755', type: 'blob', sha: null },
    ]);

    const refUpdate = requests.find(
      request => request.url.endsWith('/git/refs/heads/mcp/claude/change') && request.init?.method === 'PATCH',
    );
    expect(JSON.parse(String(refUpdate?.init?.body))).toEqual({ sha: 'new-commit', force: false });
  });

  it('interrompt un commit si le SHA du fichier a changé', async () => {
    const requests: RecordedRequest[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push({ url, init });

      if (url.endsWith('/access_tokens')) {
        return jsonResponse({ token: INSTALLATION_TOKEN });
      }
      if (url.endsWith('/git/ref/heads/mcp/claude/change')) {
        return jsonResponse({ object: { sha: 'parent-commit' } });
      }
      if (url.endsWith('/git/commits/parent-commit')) {
        return jsonResponse({ sha: 'parent-commit', tree: { sha: 'parent-tree' } });
      }
      if (url.includes('/git/trees/parent-tree')) {
        return jsonResponse({
          truncated: false,
          tree: [{ path: FILE_PATH, type: 'blob', sha: 'c'.repeat(40), mode: '100644' }],
        });
      }
      return new Response('Not Found', { status: 404 });
    };
    const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });

    await expect(
      client.changes.applyChangeSet(
        REPOSITORY,
        'mcp/claude/change',
        [{ path: FILE_PATH, content: 'updated', expectedSha: FILE_SHA }],
        'Update file',
      ),
    ).rejects.toThrow('Le fichier src/app.ts a changé depuis sa lecture.');
    expect(
      requests.some(request => request.url.endsWith('/git/trees') && request.init?.method === 'POST'),
    ).toBe(false);
  });

  it('désactive la fusion et l’approbation par défaut', async () => {
    let requestCount = 0;
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher: async () => {
        requestCount += 1;
        return new Response();
      },
    });

    await expect(client.pullRequests.mergePullRequest(REPOSITORY, 7)).rejects.toThrow(
      'La fusion de Pull Requests est désactivée (allowMerge).',
    );
    expect(() => client.pullRequests.createReview(REPOSITORY, 7, 'APPROVE', '')).toThrow(
      'L’approbation de Pull Requests est désactivée (allowApproval).',
    );
    expect(requestCount).toBe(0);
  });

  it('crée une Pull Request sur la branche de travail autorisée', async () => {
    let pullRequestBody: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse({ token: INSTALLATION_TOKEN });
      }
      if (url.endsWith('/repos/owner/project/pulls') && init?.method === 'POST') {
        pullRequestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ number: 7, ...pullRequestBody });
      }
      return new Response('Not Found', { status: 404 });
    };
    const client = new GitHubClient({ appId: '123', privateKey, installationId: '456', fetcher });

    await client.pullRequests.createPullRequest(
      REPOSITORY,
      'mcp/claude/fix-login',
      'main',
      'Fix login',
      'Handle expired sessions',
    );

    expect(pullRequestBody).toEqual({
      title: 'Fix login',
      body: 'Handle expired sessions',
      head: 'mcp/claude/fix-login',
      base: 'main',
      draft: false,
    });
  });

  it('bloque les écritures de tous les services en lecture seule avant le réseau', async () => {
    let calls = 0;
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456', policy: { readOnly: true },
      allowedWorkflows: ['ci.yml'], allowedWorkflowRefs: ['main'],
      fetcher: async () => { calls++; return jsonResponse({}); },
    });
    const operations: Array<() => Promise<unknown>> = [
      () => client.issues.createIssue(REPOSITORY, 'Issue'),
      () => client.issues.createComment(REPOSITORY, 1, 'Comment'),
      () => client.pullRequests.updatePullRequest(REPOSITORY, 1, { title: 'Title' }),
      () => client.pullRequests.createReview(REPOSITORY, 1, 'COMMENT', 'Review'),
      () => client.actions.rerunWorkflow(REPOSITORY, 1),
      () => client.actions.dispatchWorkflow(REPOSITORY, 'ci.yml', 'main'),
      () => client.releases.createRelease(REPOSITORY, 'v1'),
    ];
    for (const operation of operations) {
      await expect(Promise.resolve().then(operation)).rejects.toThrow('lecture seule');
    }
    expect(calls).toBe(0);
  });

  it.each(['missing-sha', 'deletion-missing-sha', 'truncated'])('refuse un changement non vérifiable : %s', async scenario => {
    let writes = 0;
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456',
      fetcher: async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith('/access_tokens')) return jsonResponse({ token: INSTALLATION_TOKEN });
        if (init?.method && init.method !== 'GET') writes++;
        if (url.includes('/git/ref/')) return jsonResponse({ object: { sha: 'parent' } });
        if (url.includes('/git/commits/')) return jsonResponse({ tree: { sha: 'tree' } });
        return jsonResponse({ truncated: scenario === 'truncated', tree: [
          { path: FILE_PATH, sha: FILE_SHA, type: 'blob', mode: '100755' },
        ] });
      },
    });
    await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/test/fix',
      scenario === 'deletion-missing-sha' ? [] : [{ path: FILE_PATH, content: 'new' }], 'Update',
      scenario === 'deletion-missing-sha' ? { deletions: [{ path: FILE_PATH }] } : {},
    )).rejects.toThrow(scenario === 'truncated' ? 'tronqué' : 'SHA attendu');
    expect(writes).toBe(0);
  });

  it('compte aussi les suppressions dans la limite de fichiers avant le réseau', async () => {
    let calls = 0;
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456', policy: { maxFilesPerChange: 1 },
      fetcher: async () => { calls++; return jsonResponse({}); },
    });
    await expect(client.changes.applyChangeSet(REPOSITORY, 'mcp/test/fix',
      [{ path: 'new.ts', content: 'new' }], 'Update',
      { deletions: [{ path: 'old.ts', expectedSha: FILE_SHA }] },
    )).rejects.toThrow('nombre de fichiers');
    expect(calls).toBe(0);
  });

  it.each(['main', 'master', 'client', 'client/app'])('refuse de mettre à jour une PR sur %s', async branch => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456',
      fetcher: async (input, init) => {
        const url = requestUrl(input);
        requests.push({ url, init });
        return jsonResponse(url.endsWith('/access_tokens') ? { token: INSTALLATION_TOKEN } : {
          head: { ref: branch, sha: FILE_SHA, repo: { full_name: REPOSITORY } },
        });
      },
    });
    await expect(client.branches.updatePullRequestBranch(REPOSITORY, 1)).rejects.toThrow('protégée');
    expect(requests.some(r => r.init?.method === 'PUT')).toBe(false);
  });

  it('transmet le SHA attendu pour la mise à jour d’une branche de PR autorisée', async () => {
    let updateBody: unknown;
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456',
      fetcher: async (input, init) => {
        if (requestUrl(input).endsWith('/access_tokens')) return jsonResponse({ token: INSTALLATION_TOKEN });
        if (init?.method === 'PUT') { updateBody = JSON.parse(String(init.body)); return jsonResponse({}); }
        return jsonResponse({ head: { ref: 'mcp/test/fix', sha: FILE_SHA, repo: { full_name: REPOSITORY } } });
      },
    });
    await client.branches.updatePullRequestBranch(REPOSITORY, 1);
    expect(updateBody).toEqual({ expected_head_sha: FILE_SHA });
  });

  it.each(['main', 'master', 'client/app'])('refuse une fusion vers %s même si allowMerge est activé', async base => {
    let writes = 0;
    const client = new GitHubClient({
      appId: '123', privateKey, installationId: '456', allowMerge: true,
      fetcher: async (input, init) => {
        if (requestUrl(input).endsWith('/access_tokens')) return jsonResponse({ token: INSTALLATION_TOKEN });
        if (init?.method === 'PUT') writes++;
        return jsonResponse({ base: { ref: base }, head: { sha: FILE_SHA } });
      },
    });
    await expect(client.pullRequests.mergePullRequest(REPOSITORY, 1, { expectedHeadSha: FILE_SHA })).rejects.toThrow('protégée');
    expect(writes).toBe(0);
  });

  it('nomme un délai dépassé sans recopier le message d’origine', async () => {
    const origin = 'https://api.github.com/repos/private/name?token=secret';
    const http = new GitHubHttp({
      fetcher: async () => {
        throw new DOMException(origin, 'TimeoutError');
      },
      userAgent: 'github-mcp-test',
      timeoutMs: 10,
      getInstallationToken: async () => INSTALLATION_TOKEN,
    });

    const failure = await rejection(
      http.request('/repos/owner/project/issues', { method: 'POST', body: '{}' }),
    );

    expect(failure.message).toBe('Délai dépassé lors de l’appel à GitHub.');
    expect(failure.message).not.toContain(origin);
    expect((failure as { status?: number }).status).toBe(0);
  });

  it('nomme une panne réseau sans recopier le message d’origine', async () => {
    const origin = 'https://api.github.com/repos/private/name?token=secret';
    const http = new GitHubHttp({
      fetcher: async () => {
        throw new TypeError(origin);
      },
      userAgent: 'github-mcp-test',
      timeoutMs: 10,
      getInstallationToken: async () => INSTALLATION_TOKEN,
    });

    const failure = await rejection(
      http.request('/repos/owner/project/issues', { method: 'POST', body: '{}' }),
    );

    expect(failure.message).toBe('Échec réseau lors de l’appel à GitHub.');
    expect(failure.message).not.toContain(origin);
  });

  it('refuse une redirection pendant la création du jeton d’installation', async () => {
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher: async () => new Response(null, {
        status: 302,
        headers: { Location: 'https://example.invalid/authorize?next=secret' },
      }),
    });

    const failure = await rejection(client.repositories.getRepository(REPOSITORY));

    expect(failure.message).toBe(
      'Redirection GitHub inattendue : aucune redirection n’est suivie pour créer le jeton.',
    );
    expect(failure.message).not.toContain('example.invalid');
    expect((failure as { status?: number }).status).toBe(302);
  });

  it('cite le statut quand GitHub refuse de créer le jeton', async () => {
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher: async () => new Response(null, { status: 401 }),
    });

    await expect(client.repositories.getRepository(REPOSITORY)).rejects.toThrow(
      'Impossible de créer le jeton GitHub App (statut 401).',
    );
  });

  it('signale une réponse d’authentification illisible', async () => {
    const client = new GitHubClient({
      appId: '123',
      privateKey,
      installationId: '456',
      fetcher: async () => new Response('pas du JSON', { status: 200 }),
    });

    await expect(client.repositories.getRepository(REPOSITORY)).rejects.toThrow(
      'Réponse d’authentification GitHub illisible.',
    );
  });
});

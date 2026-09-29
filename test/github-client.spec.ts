import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github/client';

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

    if (url.includes('/contents/')) {
      return jsonResponse(payload);
    }

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
      'https://api.github.com/repos/owner/project/contents/src/app.ts?ref=main',
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
      'Le dépôt owner/project n’est pas autorisé.',
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

      if (url.includes('/contents/')) {
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

      return new Response('Not Found', { status: 404 });
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
});

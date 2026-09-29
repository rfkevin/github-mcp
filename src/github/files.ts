import type { GitHubContentFile, GitHubContentEntry, GitHubTreeEntry } from './types';
import type { GitHubServiceContext } from './service-context';

export const SENSITIVE_FILE = /(^|\/)(?:\.env(?:\.[^/]*)?|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i;

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, character => character.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

export class GitHubFiles {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async getTextFile(
    repository: string,
    path: string,
    branch: string,
  ): Promise<{ path: string; sha: string; content: string; size: number }> {
    const { assertGitRef, assertReadablePath, encodeSlashPath, repoPath, request, withQuery } =
      this.dependencies;
    assertReadablePath(path);
    assertGitRef(branch);

    const payload = await request<GitHubContentFile | GitHubContentEntry[]>(
      withQuery(repoPath(repository, `/contents/${encodeSlashPath(path)}`), { ref: branch }),
    );

    if (Array.isArray(payload) || payload.type !== 'file') {
      throw new Error('La ressource demandée n’est pas un fichier texte.');
    }

    if (payload.encoding !== 'base64' || (!payload.content && payload.size > 0)) {
      const blob = await request<{ content: string; encoding: string }>(
        repoPath(repository, `/git/blobs/${encodeURIComponent(payload.sha)}`),
      );

      if (blob.encoding !== 'base64') {
        throw new Error('Encodage de fichier non pris en charge.');
      }

      return {
        path: payload.path,
        sha: payload.sha,
        content: decodeBase64(blob.content),
        size: payload.size,
      };
    }

    return {
      path: payload.path,
      sha: payload.sha,
      content: decodeBase64(payload.content),
      size: payload.size,
    };
  }

  async listDirectory(
    repository: string,
    path: string,
    branch: string,
  ): Promise<Array<{ name: string; path: string; type: string; size: number; sha: string }>> {
    const { assertGitRef, assertReadablePath, encodeSlashPath, repoPath, request, withQuery } =
      this.dependencies;
    assertReadablePath(path, true);
    assertGitRef(branch);

    const suffix = path ? `/contents/${encodeSlashPath(path)}` : '/contents';
    const payload = await request<GitHubContentEntry[] | GitHubContentFile>(
      withQuery(repoPath(repository, suffix), { ref: branch }),
    );

    if (!Array.isArray(payload)) {
      throw new TypeError('Le chemin demandé n’est pas un dossier.');
    }

    return payload.map(({ name, path: entryPath, type, size, sha }) => ({
      name,
      path: entryPath,
      type,
      size,
      sha,
    }));
  }

  async getRepositoryTree(
    repository: string,
    ref: string,
    recursive = true,
  ): Promise<{ truncated: boolean; entries: GitHubTreeEntry[] }> {
    const { encodeSlashPath, repoPath, request, withQuery, assertGitRef } = this.dependencies;
    assertGitRef(ref, 'référence');

    const tree = await request<{ truncated?: boolean; tree: GitHubTreeEntry[] }>(
      withQuery(repoPath(repository, `/git/trees/${encodeSlashPath(ref)}`), {
        recursive: recursive ? 1 : undefined,
      }),
    );

    return {
      truncated: Boolean(tree.truncated),
      entries: tree.tree.filter(entry => !entry.path || !SENSITIVE_FILE.test(entry.path)),
    };
  }

  async searchCode(repository: string, query: string, limit = 30): Promise<{
    name: string;
    path: string;
    sha: string;
    html_url: string;
  }[]> {
    if (!query.trim() || query.length > 256) {
      throw new Error('Requête de recherche invalide.');
    }

    const { request, repoPath, splitRepository, withQuery } = this.dependencies;
    const { owner, name } = splitRepository(repository);
    repoPath(repository);

    const payload = await request<{
      items: Array<{ name: string; path: string; sha: string; html_url: string }>;
    }>(
      withQuery('/search/code', {
        q: `${query} repo:${owner}/${name}`,
        per_page: Math.min(Math.max(limit, 1), 100),
      }),
    );

    return payload.items.filter(item => !SENSITIVE_FILE.test(item.path));
  }
}

import type { GitHubContentFile, GitHubContentEntry, GitHubTreeEntry } from './types';
import type { GitHubServiceContext } from './service-context';
import { GitHubApiError, InputValidationError } from './types';

export const SENSITIVE_FILE = /(^|\/)(?:\.env(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i;
export const MAX_FILE_BYTES = 1_000_000;

function decodeBase64(value: string): string {
  if (value.length > Math.ceil(MAX_FILE_BYTES * 1.4)) {
    throw new InputValidationError('Fichier trop volumineux pour une lecture MCP.', 'FILE_TOO_LARGE');
  }
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, character => character.codePointAt(0) ?? 0);
  if (bytes.length > MAX_FILE_BYTES) throw new InputValidationError('Fichier trop volumineux.', 'FILE_TOO_LARGE');
  if (bytes.includes(0)) throw new InputValidationError('Les fichiers binaires ne sont pas lisibles.', 'BINARY_FILE');
  return new TextDecoder().decode(bytes);
}

export class GitHubFiles {
  // Cache limité à l'appel MCP (jamais partagé entre utilisateurs ou commits).
  private readonly trees = new Map<string, Promise<{ truncated: boolean; entries: GitHubTreeEntry[] }>>();
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async getTextFile(
    repository: string,
    path: string,
    branch: string,
  ): Promise<{ path: string; sha: string; content: string; size: number }> {
    const { assertGitRef, assertReadablePath, repoPath, request } =
      this.dependencies;
    assertReadablePath(path);
    assertGitRef(branch);

    // Contents peut suivre un lien symbolique vers un secret. Parcourir les
    // arbres Git, puis lire le blob immuable, ne déréférence jamais ces liens.
    const segments = path.split('/');
    if (segments.length > 32) throw new InputValidationError('Chemin trop profond.');
    let treeRef = branch;
    let entry: GitHubTreeEntry | undefined;
    for (let index = 0; index < segments.length; index += 1) {
      const tree = await this.readTree(repository, treeRef);
      if (tree.truncated) throw new InputValidationError('Arbre Git incomplet : lecture refusée.', 'TREE_TRUNCATED');
      entry = tree.entries.find(item => item.path === segments[index]);
      if (!entry) throw new GitHubApiError(404, '/git/trees', 'Fichier introuvable.');
      if (entry.mode === '120000' || entry.type === 'commit') {
        throw new InputValidationError('Les liens symboliques et sous-modules ne sont pas suivis.', 'LINK_DENIED');
      }
      if (!entry.sha || !/^[a-f0-9]{40}$/i.test(entry.sha)) throw new Error('Invalid tree response');
      if (index < segments.length - 1 && entry.type !== 'tree') {
        throw new InputValidationError('Le chemin demandé ne traverse pas un dossier.');
      }
      treeRef = entry.sha;
    }
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '')) {
      throw new InputValidationError('La ressource demandée n’est pas un fichier texte.');
    }
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > MAX_FILE_BYTES) {
      throw new InputValidationError('Fichier trop volumineux ou taille inconnue.', 'FILE_TOO_LARGE');
    }
    const blob = await request<{ content: string; encoding: string; size: number }>(
      repoPath(repository, `/git/blobs/${entry.sha}`),
    );
    if (blob.encoding !== 'base64') throw new InputValidationError('Encodage de fichier non pris en charge.');
    if (blob.size > MAX_FILE_BYTES) throw new InputValidationError('Fichier trop volumineux.', 'FILE_TOO_LARGE');
    return { path, sha: entry.sha!, content: decodeBase64(blob.content), size: entry.size! };
  }

  private readTree(repository: string, ref: string): Promise<{ truncated: boolean; entries: GitHubTreeEntry[] }> {
    const key = `${repository}:${ref}`;
    let pending = this.trees.get(key);
    if (!pending) {
      pending = this.getRepositoryTree(repository, ref, false);
      this.trees.set(key, pending);
    }
    return pending;
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
      throw new InputValidationError('Le chemin demandé n’est pas un dossier.');
    }

    return payload
      // Same guarantee as the repository tree: a sensitive entry never appears in a listing.
      .filter(({ path: entryPath }) => !SENSITIVE_FILE.test(entryPath))
      .map(({ name, path: entryPath, type, size, sha }) => ({
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
      throw new InputValidationError('Requête de recherche invalide.');
    }
    if (/(?:^|[\s(])(?:repo|org|user):/i.test(query)) {
      throw new InputValidationError('La recherche est déjà limitée au dépôt : retirez les filtres repo, org et user.');
    }

    const { request, repoPath, splitRepository, withQuery } = this.dependencies;
    const { owner, name } = splitRepository(repository);
    repoPath(repository);

    const payload = await request<{
      items: Array<{ name: string; path: string; sha: string; html_url: string; repository?: { full_name: string } }>;
    }>(
      withQuery('/search/code', {
        q: `${query} repo:${owner}/${name}`,
        per_page: Math.min(Math.max(limit, 1), 100),
      }),
    );

    return payload.items.filter(item => item.repository?.full_name.toLowerCase() === repository.toLowerCase() &&
      !SENSITIVE_FILE.test(item.path)).map(({ name: itemName, path, sha, html_url }) => ({ name: itemName, path, sha, html_url }));
  }
}

import {
  assertWritablePath,
  validateChangeSet,
  type FileChange,
} from '../security/policy';
import {
  GitHubApiError,
  GitHubConflictError,
  type AppliedChangeSet,
  type ApplyChangeSetOptions,
  type GitHubTree,
  type FileDeletion,
} from './types';
import type { GitHubServiceContext } from './service-context';
import { APPEND_ONLY_PATHS, assertMemoryAppend, rejectMemoryRewrite } from '../agent-memory';

type GitHubRef = { object: { sha: string } };
type GitHubCommitObject = { sha: string; tree: { sha: string } };
type ExistingFile = { sha: string; mode: string };
type ChangeSetPlan = {
  changes: readonly FileChange[];
  deletions: readonly FileDeletion[];
  paths: Set<string>;
};
type ParentSnapshot = {
  commitSha: string;
  treeSha: string;
  tree: GitHubTree;
};

export class GitHubChanges {
  constructor(private readonly dependencies: GitHubServiceContext) {}

  async applyChangeSet(
    repository: string,
    branch: string,
    changes: readonly FileChange[],
    commitMessage: string,
    options: ApplyChangeSetOptions = {},
  ): Promise<AppliedChangeSet> {
    this.dependencies.assertWritableBranchName(branch);
    const plan = this.prepareChangeSet(changes, commitMessage, options);
    if (options.expectedHeadSha && !/^[a-f0-9]{40}$/i.test(options.expectedHeadSha)) {
      throw new GitHubConflictError('SHA de branche attendu invalide.');
    }
    const snapshot = await this.loadParentSnapshot(repository, branch);
    if (options.expectedHeadSha && snapshot.commitSha.toLowerCase() !== options.expectedHeadSha.toLowerCase()) {
      throw new GitHubConflictError('La branche a changé depuis la préparation du commit.');
    }
    const existing = this.loadExistingFiles(snapshot, plan.paths);
    this.assertExpectedFiles(plan, existing);
    await this.assertMemoryPreserved(repository, plan, existing);

    const newTree = await this.createTree(repository, snapshot.treeSha, plan, existing);
    const commit = await this.createCommit(repository, commitMessage, newTree.sha, snapshot.commitSha);
    await this.advanceBranch(repository, branch, commit.sha);

    return {
      branch,
      commitSha: commit.sha,
      changedPaths: plan.changes.map(change => change.path),
      deletedPaths: plan.deletions.map(deletion => deletion.path),
    };
  }

  private prepareChangeSet(
    changes: readonly FileChange[],
    commitMessage: string,
    options: ApplyChangeSetOptions,
  ): ChangeSetPlan {
    if (!commitMessage.trim() || commitMessage.length > 200) {
      throw new Error('Le message de commit est invalide.');
    }

    const deletions = options.deletions ?? [];
    for (const path of APPEND_ONLY_PATHS) {
      if (deletions.some(deletion => deletion.path === path)) rejectMemoryRewrite(path);
    }
    if (changes.length === 0 && deletions.length === 0) {
      throw new Error('Aucun changement à appliquer.');
    }

    // Count and validate deletions too, before making any network request.
    validateChangeSet([
      ...changes,
      ...deletions.map(deletion => ({ ...deletion, content: '' })),
    ], this.dependencies.policy);
    const validatedChanges = changes;
    const paths = new Set(validatedChanges.map(change => change.path));

    for (const deletion of deletions) {
      assertWritablePath(deletion.path);
      if (paths.has(deletion.path)) {
        throw new Error(`Le chemin ${deletion.path} est à la fois modifié et supprimé.`);
      }
      paths.add(deletion.path);
    }

    return { changes: validatedChanges, deletions, paths };
  }

  private async loadParentSnapshot(repository: string, branch: string): Promise<ParentSnapshot> {
    const { encodeSegment, encodeSlashPath, repoPath, request, withQuery } = this.dependencies;
    const branchRef = await request<GitHubRef>(
      repoPath(repository, `/git/ref/heads/${encodeSlashPath(branch)}`),
    );
    const commitSha = branchRef.object.sha;
    const parentCommit = await request<GitHubCommitObject>(
      repoPath(repository, `/git/commits/${encodeSegment(commitSha)}`),
    );
    const treeSha = parentCommit.tree.sha;
    const tree = await request<GitHubTree>(
      withQuery(repoPath(repository, `/git/trees/${encodeSegment(treeSha)}`), { recursive: 1 }),
    );
    if (tree.truncated) {
      throw new Error('Arbre Git tronqué : impossible de garantir les modes et chemins des fichiers.');
    }

    return { commitSha, treeSha, tree };
  }

  private loadExistingFiles(
    snapshot: ParentSnapshot,
    paths: ReadonlySet<string>,
  ): Map<string, ExistingFile | undefined> {
    // Un seul index, au lieu de rechercher chaque chemin dans tout le dépôt.
    const nodes = new Map(snapshot.tree.tree.map(item => [item.path, item]));

    const files = new Map<string, ExistingFile | undefined>();
    for (const path of paths) {
      const node = nodes.get(path);
      if (node && (node.type !== 'blob' || !['100644', '100755'].includes(node.mode ?? '100644'))) {
        throw new GitHubConflictError('Impossible de remplacer un dossier, un sous-module ou un lien symbolique.');
      }
      const ancestors = path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      if (ancestors.some(ancestor => nodes.has(ancestor) && nodes.get(ancestor)?.type !== 'tree')) {
        throw new GitHubConflictError('Un parent du fichier n’est pas un dossier ordinaire.');
      }
      files.set(path, node?.sha ? { sha: node.sha, mode: node.mode ?? '100644' } : undefined);
    }

    return files;
  }

  private assertExpectedFiles(
    plan: ChangeSetPlan,
    existing: ReadonlyMap<string, ExistingFile | undefined>,
  ): void {
    for (const change of plan.changes) {
      if (existing.get(change.path) && !change.expectedSha) {
        throw new GitHubConflictError(`Le SHA attendu est requis pour modifier ${change.path}.`);
      }
      if (change.expectedSha && existing.get(change.path)?.sha !== change.expectedSha) {
        throw new GitHubConflictError(`Le fichier ${change.path} a changé depuis sa lecture.`);
      }
    }

    for (const deletion of plan.deletions) {
      const current = existing.get(deletion.path);
      if (!current) {
        throw new GitHubConflictError(`Le fichier ${deletion.path} n’existe pas.`);
      }
      if (!deletion.expectedSha) {
        throw new GitHubConflictError(`Le SHA attendu est requis pour supprimer ${deletion.path}.`);
      }
      if (deletion.expectedSha && current.sha !== deletion.expectedSha) {
        throw new GitHubConflictError(`Le fichier ${deletion.path} a changé depuis sa lecture.`);
      }
    }
  }

  private async assertMemoryPreserved(
    repository: string,
    plan: ChangeSetPlan,
    existing: ReadonlyMap<string, ExistingFile | undefined>,
  ): Promise<void> {
    for (const path of APPEND_ONLY_PATHS) {
      const change = plan.changes.find(item => item.path === path);
      const previous = existing.get(path);
      if (!change || !previous) continue;
      const { request, repoPath, encodeSegment } = this.dependencies;
      const blob = await request<{ content: string; encoding: string; size: number }>(
        repoPath(repository, `/git/blobs/${encodeSegment(previous.sha)}`),
      );
      assertMemoryAppend(blob, change.content, path);
    }
  }

  private createTree(
    repository: string,
    parentTreeSha: string,
    plan: ChangeSetPlan,
    existing: ReadonlyMap<string, ExistingFile | undefined>,
  ): Promise<{ sha: string }> {
    const { repoPath, request } = this.dependencies;
    return request<{ sha: string }>(repoPath(repository, '/git/trees'), {
      method: 'POST',
      body: JSON.stringify({
        base_tree: parentTreeSha,
        tree: [
          ...plan.changes.map(change => ({
            path: change.path,
            mode: existing.get(change.path)?.mode ?? '100644',
            type: 'blob',
            content: change.content,
          })),
          ...plan.deletions.map(deletion => ({
            path: deletion.path,
            mode: existing.get(deletion.path)?.mode ?? '100644',
            type: 'blob',
            sha: null,
          })),
        ],
      }),
    });
  }

  private createCommit(
    repository: string,
    message: string,
    treeSha: string,
    parentCommitSha: string,
  ): Promise<{ sha: string }> {
    return this.dependencies.request<{ sha: string }>(
      this.dependencies.repoPath(repository, '/git/commits'),
      {
        method: 'POST',
        body: JSON.stringify({ message, tree: treeSha, parents: [parentCommitSha] }),
      },
    );
  }

  private async advanceBranch(repository: string, branch: string, commitSha: string): Promise<void> {
    const { encodeSlashPath, repoPath, request } = this.dependencies;
    try {
      await request(repoPath(repository, `/git/refs/heads/${encodeSlashPath(branch)}`), {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitSha, force: false }),
      });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 422) {
        throw new GitHubConflictError(
          'La branche a avancé pendant le commit. Relis les fichiers et réessaie.',
        );
      }
      throw error;
    }
  }
}

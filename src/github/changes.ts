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
  type GitHubContentEntry,
  type GitHubContentFile,
  type GitHubTree,
  type FileDeletion,
} from './types';
import type { GitHubServiceContext } from './service-context';

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
    const snapshot = await this.loadParentSnapshot(repository, branch);
    const existing = await this.loadExistingFiles(repository, snapshot, plan.paths);
    this.assertExpectedFiles(plan, existing);

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
    if (changes.length === 0 && deletions.length === 0) {
      throw new Error('Aucun changement à appliquer.');
    }

    const validatedChanges = changes.length > 0
      ? validateChangeSet(changes, this.dependencies.policy)
      : [];
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

    return { commitSha, treeSha, tree };
  }

  private async loadExistingFiles(
    repository: string,
    snapshot: ParentSnapshot,
    paths: ReadonlySet<string>,
  ): Promise<Map<string, ExistingFile | undefined>> {
    const knownFiles = new Map<string, ExistingFile>();

    if (!snapshot.tree.truncated) {
      for (const item of snapshot.tree.tree) {
        if (item.type === 'blob' && item.path && item.sha) {
          knownFiles.set(item.path, { sha: item.sha, mode: item.mode ?? '100644' });
        }
      }
    }

    const files = new Map<string, ExistingFile | undefined>();
    for (const path of paths) {
      files.set(
        path,
        await this.lookupExistingFile(repository, path, snapshot, knownFiles),
      );
    }

    return files;
  }

  private async lookupExistingFile(
    repository: string,
    path: string,
    snapshot: ParentSnapshot,
    knownFiles: ReadonlyMap<string, ExistingFile>,
  ): Promise<ExistingFile | undefined> {
    if (!snapshot.tree.truncated) {
      return knownFiles.get(path);
    }

    const { encodeSlashPath, repoPath, request, withQuery } = this.dependencies;
    try {
      const payload = await request<GitHubContentFile | GitHubContentEntry[]>(
        withQuery(repoPath(repository, `/contents/${encodeSlashPath(path)}`), {
          ref: snapshot.commitSha,
        }),
      );
      return Array.isArray(payload) ? undefined : { sha: payload.sha, mode: '100644' };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private assertExpectedFiles(
    plan: ChangeSetPlan,
    existing: ReadonlyMap<string, ExistingFile | undefined>,
  ): void {
    for (const change of plan.changes) {
      if (change.expectedSha && existing.get(change.path)?.sha !== change.expectedSha) {
        throw new GitHubConflictError(`Le fichier ${change.path} a changé depuis sa lecture.`);
      }
    }

    for (const deletion of plan.deletions) {
      const current = existing.get(deletion.path);
      if (!current) {
        throw new GitHubConflictError(`Le fichier ${deletion.path} n’existe pas.`);
      }
      if (deletion.expectedSha && current.sha !== deletion.expectedSha) {
        throw new GitHubConflictError(`Le fichier ${deletion.path} a changé depuis sa lecture.`);
      }
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

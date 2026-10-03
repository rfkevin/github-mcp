import { GitHubApiError, InputValidationError } from '../../github/types';
import type { BatchOperation } from './schema';

export type TextFile = { path: string; sha: string; content: string; size: number };
type Dependencies = {
  branches: { getBranchHead(repository: string, branch: string): Promise<string> };
  files: { getTextFile(repository: string, path: string, ref: string): Promise<TextFile> };
  commits: { getCommit(repository: string, ref: string): Promise<{ sha: string }> };
};
export type BatchSnapshot = { headSha: string; files: Map<string, TextFile | undefined>; sources: Map<string, TextFile> };

export async function loadBatchSnapshot(deps: Dependencies, repository: string, branch: string, expectedHeadSha: string, operations: readonly BatchOperation[]): Promise<BatchSnapshot> {
  const headSha = (await deps.branches.getBranchHead(repository, branch)).toLowerCase();
  if (headSha !== expectedHeadSha) throw new InputValidationError('La branche a changé : relisez les fichiers.', 'HEAD_CHANGED');
  const paths = [...new Set(operations.map(operation => operation.path))];
  const files = new Map<string, TextFile | undefined>();
  await mapLimit(paths, 3, async path => {
    try { files.set(path, await deps.files.getTextFile(repository, path, expectedHeadSha)); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) files.set(path, undefined);
      else throw error;
    }
  });
  const refCache = new Map<string, Promise<string>>();
  const sources = new Map<string, TextFile>();
  const restores = operations.filter((operation): operation is Extract<BatchOperation, { type: 'restore' }> => operation.type === 'restore');
  await mapLimit(restores, 3, async operation => {
    let resolved = refCache.get(operation.sourceRef);
    if (!resolved) {
      resolved = /^[a-f0-9]{40}$/i.test(operation.sourceRef)
        ? Promise.resolve(operation.sourceRef.toLowerCase())
        : deps.commits.getCommit(repository, operation.sourceRef).then(commit => commit.sha.toLowerCase());
      refCache.set(operation.sourceRef, resolved);
    }
    const commitSha = await resolved;
    const key = `${repository}\n${commitSha}\n${operation.path}`;
    if (!sources.has(key)) sources.set(key, await deps.files.getTextFile(repository, operation.path, commitSha));
  });
  return { headSha, files, sources };
}

async function mapLimit<T>(values: readonly T[], limit: number, work: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const index = next++; if (index >= values.length) return; await work(values[index]); }
  }));
}

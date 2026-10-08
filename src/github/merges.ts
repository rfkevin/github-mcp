import type { GitHubServiceContext } from './service-context';
import { GitHubConflictError, InputValidationError, type GitHubTreeEntry } from './types';
import { APPEND_ONLY_PATHS, assertMergedJournal, rejectMemoryRewrite, type JournalBlob } from '../agent-memory';
import { MAX_FILE_BYTES, decodeTextBlob } from './files';
import { mergeTree, planMerge, sameEntry, assertMergeEntrySize, type MergeEntry } from '../merges/plan';

export type MergeResolution = { path: string; choice: 'ours' | 'theirs' | 'delete' | 'content'; content?: string };
type TreeEdit = { path: string; mode: string; type: 'blob'; sha?: string | null; content?: string };
const sha = (value: string) => {
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new InputValidationError('SHA Git invalide.', 'MERGE_SHA_INVALID');
  return value.toLowerCase();
};

export class GitHubMerges {
  constructor(private readonly dependencies: GitHubServiceContext) {}
  private async snapshot(repository: string, commitSha: string) {
    const { request, repoPath, withQuery } = this.dependencies;
    const commit = await request<{ sha: string; tree: { sha: string } }>(repoPath(repository, `/git/commits/${sha(commitSha)}`));
    if (sha(commit.sha) !== commitSha) throw new InputValidationError('Commit Git différent de celui demandé.', 'MERGE_SHA_INVALID');
    const treeSha = sha(commit.tree.sha);
    const tree = await request<{ truncated: boolean; tree: GitHubTreeEntry[] }>(withQuery(repoPath(repository, `/git/trees/${treeSha}`), { recursive: 1 }));
    return { treeSha, files: mergeTree(tree) };
  }
  async inspect(repository: string, headSha: string, baseSha: string) {
    headSha = sha(headSha); baseSha = sha(baseSha);
    const { request, repoPath } = this.dependencies;
    const comparison = await request<{ merge_base_commit: { sha: string } }>(repoPath(repository, `/compare/${headSha}...${baseSha}`));
    const ancestorSha = sha(comparison.merge_base_commit?.sha ?? '');
    const [ancestor, ours, theirs] = await Promise.all([ancestorSha, headSha, baseSha].map(commit => this.snapshot(repository, commit)));
    return { headSha, baseSha, ancestorSha, ours, theirs, plan: planMerge(ancestor.files, ours.files, theirs.files) };
  }
  private async branchHead(repository: string, branch: string) {
    const { request, repoPath, encodeSlashPath } = this.dependencies;
    const ref = await request<{ object: { sha: string } }>(repoPath(repository, `/git/ref/heads/${encodeSlashPath(branch)}`));
    return sha(ref.object.sha);
  }
  private async assertHeads(repository: string, branch: string, baseBranch: string, headSha: string, baseSha: string) {
    const [head, base] = await Promise.all([this.branchHead(repository, branch), this.branchHead(repository, baseBranch)]);
    if (head !== headSha || base !== baseSha) throw new GitHubConflictError('La branche ou sa base a changé : refaire le diagnostic.');
  }
  async resolve(repository: string, branch: string, baseBranch: string, headSha: string, baseSha: string,
    message: string, resolutions: readonly MergeResolution[]) {
    this.dependencies.assertWritableBranchName(branch);
    headSha = sha(headSha); baseSha = sha(baseSha);
    if (!message.trim() || message.length > 200) throw new InputValidationError('Message de commit trop long.', 'MESSAGE_TOO_LONG');
    await this.assertHeads(repository, branch, baseBranch, headSha, baseSha);
    const snapshot = await this.inspect(repository, headSha, baseSha);
    if (snapshot.ancestorSha === baseSha) throw new InputValidationError('La base est déjà présente dans la branche.', 'NO_CHANGE');
    if (snapshot.plan.rows.some(row => row.blocked)) throw new InputValidationError('Chemin protégé, lien ou changement de type : résolution humaine requise.', 'MERGE_PATH_DENIED');
    const conflicts = new Map(snapshot.plan.rows.filter(row => row.conflict).map(row => [row.path, row]));
    const choices = new Map<string, MergeResolution>();
    for (const resolution of resolutions) {
      if (choices.has(resolution.path) || !conflicts.has(resolution.path)) throw new InputValidationError('Choix dupliqué ou hors des conflits annoncés.', 'MERGE_RESOLUTION_INVALID');
      if (resolution.choice !== 'content' && resolution.content !== undefined) throw new InputValidationError('Le contenu exige choice=content.', 'MERGE_RESOLUTION_INVALID');
      choices.set(resolution.path, resolution);
    }
    if (choices.size !== conflicts.size) throw new InputValidationError('Tous les conflits doivent être résolus explicitement.', 'MERGE_RESOLUTION_REQUIRED');
    const edits: TreeEdit[] = [], contents = new Map<string, string>();
    let bytes = 0;
    const add = (path: string, entry?: MergeEntry, content?: string) => {
      if (content !== undefined) {
        if (/^(?:<{7}|>{7})(?: |$)/m.test(content)) throw new InputValidationError('Marqueurs de conflit encore présents.', 'MERGE_MARKERS_PRESENT');
        bytes += new TextEncoder().encode(content).length;
        contents.set(path, content);
        edits.push({ path, mode: entry?.mode ?? '100644', type: 'blob', content });
      } else {
        assertMergeEntrySize(entry); bytes += entry?.size ?? 0;
        edits.push({ path, mode: entry?.mode ?? '100644', type: 'blob', sha: entry?.sha ?? null });
      }
    };
    for (const [path, entry] of snapshot.plan.updates) add(path, entry);
    for (const [path, resolution] of choices) {
      const row = conflicts.get(path)!;
      if (resolution.choice === 'content') {
        if (resolution.content === undefined) throw new InputValidationError('Contenu résolu manquant.', 'MERGE_RESOLUTION_INVALID');
        add(path, row.ours ?? row.theirs, resolution.content);
      } else {
        const selected = resolution.choice === 'ours' ? row.ours : resolution.choice === 'theirs' ? row.theirs : undefined;
        if (!sameEntry(selected, row.ours)) add(path, selected);
      }
    }
    if (bytes > MAX_FILE_BYTES) throw new InputValidationError('La résolution dépasse 1 Mo.', 'MERGE_TOO_LARGE');
    await this.assertJournals(repository, snapshot, edits, contents);
    const { request, repoPath, encodeSlashPath } = this.dependencies;
    const tree = edits.length ? await request<{ sha: string }>(repoPath(repository, '/git/trees'), {
      method: 'POST', body: JSON.stringify({ base_tree: snapshot.ours.treeSha, tree: edits }) }) : { sha: snapshot.ours.treeSha };
    const commit = await request<{ sha: string }>(repoPath(repository, '/git/commits'), {
      method: 'POST', body: JSON.stringify({ message, tree: sha(tree.sha), parents: [headSha, baseSha] }) });
    const commitSha = sha(commit.sha);
    await this.assertHeads(repository, branch, baseBranch, headSha, baseSha);
    await request(repoPath(repository, `/git/refs/heads/${encodeSlashPath(branch)}`), {
      method: 'PATCH', body: JSON.stringify({ sha: commitSha, force: false }) });
    return { branch, commitSha, changedPaths: edits.filter(edit => edit.sha !== null).map(edit => edit.path),
      deletedPaths: edits.filter(edit => edit.sha === null).map(edit => edit.path), baseSha, ancestorSha: snapshot.ancestorSha };
  }
  private async assertJournals(repository: string, snapshot: Awaited<ReturnType<GitHubMerges['inspect']>>, edits: TreeEdit[], contents: Map<string, string>) {
    const { request, repoPath } = this.dependencies;
    for (const path of APPEND_ONLY_PATHS) {
      const edit = edits.find(item => item.path === path);
      if (!edit && !snapshot.plan.rows.some(row => row.path === path)) continue;
      const selectedSha = edit?.sha ?? snapshot.ours.files.get(path)?.sha;
      if (edit?.sha === null || (!selectedSha && !contents.has(path))) rejectMemoryRewrite(path);
      let content = contents.get(path);
      if (content === undefined) {
        const blob = await request<{ encoding: string; content: string; size: number }>(repoPath(repository, `/git/blobs/${sha(selectedSha!)}`));
        content = decodeTextBlob(blob);
      }
      const ancestorEntry = snapshot.plan.rows.find(row => row.path === path)?.ancestor;
      const [ancestor, ours, theirs] = await Promise.all([ancestorEntry, snapshot.ours.files.get(path), snapshot.theirs.files.get(path)]
        .map(entry => entry ? request<JournalBlob>(repoPath(repository, `/git/blobs/${sha(entry.sha)}`)) : Promise.resolve(undefined)));
      assertMergedJournal(path, content, { ancestor, ours, theirs });
    }
  }
}

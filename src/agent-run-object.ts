/**
 * CC-5 l7 (incrément 7c-1) — Durable Object des exécutions API avec ses lectures GitHub.
 *
 * Le store (src/collab-store/**) ne dépend jamais du client GitHub (invariant CC-3 C6) :
 * la racine du Worker injecte ici des lectures en LECTURE SEULE, un jeton minimal par
 * famille (comme src/mcp/context.ts). Rien n'est lu sans AGENT_RUN_REPOSITORY.
 *
 * 7c-3 : écritures GitHub (contents + pull_requests en écriture, dépôt unique) seulement si
 * AGENT_RUN_GITHUB_WRITES vaut « true ». Aucune fusion, approbation ni résolution de conflit :
 * le client est construit sans allowMerge ni allowApproval. Les refus certains du client
 * (conflit, politique, validation) deviennent GitHubWriteRefused ; le reste reste incertain.
 */
import { GitHubClient } from './github/client';
import { GitHubApiError, GitHubConflictError, InputValidationError } from './github/types';
import { PolicyViolationError } from './security/policy';
import { AgentRunObject as StoreAgentRunObject } from './collab-store/agentrun/object';
import type { GitHubReads } from './collab-store/agentrun/read-tools';
import { GitHubWriteRefused, type GitHubWrites } from './collab-store/agentrun/github-tools';

export function githubReadsFrom(env: { GITHUB_APP_ID?: string; GITHUB_INSTALLATION_ID?: string; GITHUB_PRIVATE_KEY?: string }): GitHubReads | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_PRIVATE_KEY) return null;
  const shared = { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKey: env.GITHUB_PRIVATE_KEY, policy: { readOnly: true } };
  const contents = new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', contents: 'read' } });
  const pulls = new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', pull_requests: 'read' } });
  const checks = new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', checks: 'read' } });
  return {
    getTextFile: (repository, path, ref) => contents.files.getTextFile(repository, path, ref),
    getPullRequest: (repository, number) => pulls.pullRequests.getPullRequest(repository, number),
    listCheckRuns: (repository, ref) => checks.actions.listCheckRuns(repository, ref),
  };
}

type AppEnv = { GITHUB_APP_ID?: string; GITHUB_INSTALLATION_ID?: string; GITHUB_PRIVATE_KEY?: string };

/** Erreur certaine du client (rien d'écrit) → GitHubWriteRefused ; autre erreur inchangée (incertaine). */
async function certain<T>(effect: () => Promise<T>): Promise<T> {
  try {
    return await effect();
  } catch (error) {
    if (error instanceof GitHubConflictError) throw new GitHubWriteRefused('CONFLICT', error.message);
    if (error instanceof PolicyViolationError) throw new GitHubWriteRefused(error.code, error.message);
    if (error instanceof InputValidationError) throw new GitHubWriteRefused(error.code, error.message);
    throw error;
  }
}

export function githubWritesFrom(env: AppEnv, repository: string): GitHubWrites | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_PRIVATE_KEY) return null;
  const client = new GitHubClient({
    appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKey: env.GITHUB_PRIVATE_KEY,
    tokenPermissions: { metadata: 'read', contents: 'write', pull_requests: 'write' },
    allowedRepositories: [repository],
  });
  return {
    async branchHead(repo, branch) {
      try {
        return await client.branches.getBranchHead(repo, branch);
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return null;
        throw error;
      }
    },
    createBranch: (repo, branch, base, expectedBaseSha) =>
      certain(async () => ({ sha: (await client.branches.createWorkingBranch(repo, branch, base, { expectedBaseSha })).sha })),
    commitFiles: (repo, branch, expectedHeadSha, message, files) =>
      certain(async () => ({ commit_sha: (await client.changes.applyChangeSet(repo, branch, files, message, { expectedHeadSha })).commitSha })),
    async recentCommits(repo, branch, limit) {
      const commits = await client.commits.listCommits(repo, { ref: branch, limit });
      return commits.map(commit => ({ sha: commit.sha, message: commit.commit.message }));
    },
    openDraftPullRequest: (repo, branch, base, title, body) =>
      certain(async () => {
        const pr = await client.pullRequests.createPullRequest(repo, branch, base, title, body, { draft: true });
        return { number: pr.number, head_sha: pr.head.sha };
      }),
    async findPullRequest(repo, branch) {
      const owner = repo.split('/')[0];
      const [pr] = await client.pullRequests.listPullRequests(repo, { state: 'all', head: owner + ':' + branch, limit: 1 });
      return pr ? { number: pr.number, head_sha: pr.head.sha } : null;
    },
  };
}

export class AgentRunObject extends StoreAgentRunObject {
  protected override githubReads(): GitHubReads | null {
    return this.env.AGENT_RUN_REPOSITORY ? githubReadsFrom(this.env) : null;
  }

  protected override githubWrites(): GitHubWrites | null {
    const repository = this.env.AGENT_RUN_REPOSITORY;
    return repository && this.env.AGENT_RUN_GITHUB_WRITES === 'true' ? githubWritesFrom(this.env, repository) : null;
  }
}

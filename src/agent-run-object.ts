/**
 * CC-5 l7 (incrément 7c-1) — Durable Object des exécutions API avec ses lectures GitHub.
 *
 * Le store (src/collab-store/**) ne dépend jamais du client GitHub (invariant CC-3 C6) :
 * la racine du Worker injecte ici des lectures en LECTURE SEULE, un jeton minimal par
 * famille (comme src/mcp/context.ts). Rien n'est lu sans AGENT_RUN_REPOSITORY.
 */
import { GitHubClient } from './github/client';
import { AgentRunObject as StoreAgentRunObject } from './collab-store/agentrun/object';
import type { GitHubReads } from './collab-store/agentrun/read-tools';

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

export class AgentRunObject extends StoreAgentRunObject {
  protected override githubReads(): GitHubReads | null {
    return this.env.AGENT_RUN_REPOSITORY ? githubReadsFrom(this.env) : null;
  }
}

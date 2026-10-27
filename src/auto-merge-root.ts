/**
 * CC-7 L6b-3 — racine de la fusion automatique vers l'intégration (S11, Q4).
 *
 * Le store ne dépend jamais du client GitHub (invariant CC-3 C6) : la racine du Worker
 * construit ici, et seulement ici, les lectures et la requête REST injectées dans
 * runAutoMergePass. Rien n'est construit sans autoMergeConfig (AUTO_MERGE_INTEGRATION
 * exact, dépôt et branche d'intégration valides, jamais main ni master) ni sans les
 * secrets de la GitHub App. Jeton : contents en écriture (branche temporaire, merge,
 * fast-forward sans force), pull_requests et checks en lecture ; dépôt unique.
 */
import { GitHubAuthenticator } from './github/auth';
import { GitHubClient } from './github/client';
import { GitHubHttp } from './github/http';
import { autoMergeConfig, type AutoMergeEnv, type AutoMergeGitHub } from './collab-store/gates/auto-merge';

export interface AutoMergeRootEnv extends AutoMergeEnv {
  GITHUB_APP_ID?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
}

const USER_AGENT = 'github-mcp-worker';
const TIMEOUT_MS = 15_000;
const SHA_RE = /^[a-f0-9]{40}$/;

/** Ports GitHub de la fusion automatique, ou null (éteint ou secrets absents) : fail-closed. */
export function autoMergeGitHubFrom(env: AutoMergeRootEnv, fetcher: typeof fetch = (input, init) => fetch(input, init)): AutoMergeGitHub | null {
  const config = autoMergeConfig(env);
  if (!config || !env.GITHUB_APP_ID || !env.GITHUB_INSTALLATION_ID || !env.GITHUB_PRIVATE_KEY) return null;
  const shared = { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, privateKey: env.GITHUB_PRIVATE_KEY };
  const authenticator = new GitHubAuthenticator({ ...shared, fetcher, userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS,
    tokenPermissions: { metadata: 'read', contents: 'write' } });
  const http = new GitHubHttp({ fetcher, userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS,
    getInstallationToken: forceRefresh => authenticator.getInstallationToken(forceRefresh) });
  const reads = new GitHubClient({ ...shared, fetcher, policy: { readOnly: true }, allowedRepositories: [config.repository],
    tokenPermissions: { metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'read' } });
  const repoRoot = '/repos/' + config.repository;
  return {
    // Écritures de l'exécuteur fencé, limitées au dépôt configuré (préfixe imposé).
    request: <T>(path: string, init?: { method: 'POST' | 'PATCH' | 'DELETE'; body?: string }) => {
      if (!path.startsWith(repoRoot + '/')) throw new Error('AUTO_MERGE_PATH_OUTSIDE_REPOSITORY');
      return http.request<T>(path, init ? { method: init.method, body: init.body,
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined } : {});
    },
    async pull(pr) {
      const pull = await reads.pullRequests.getPullRequest(config.repository, pr) as unknown as {
        head: { sha: string }; base: { ref: string }; draft?: boolean; mergeable?: boolean | null; state: string };
      return { head: pull.head.sha, draft: pull.draft === true, mergeable: pull.mergeable ?? null, state: pull.state, baseRef: pull.base.ref };
    },
    async checks(sha) {
      const runs = await reads.actions.listCheckRuns(config.repository, sha) as unknown as Array<{ name: string; status: string; conclusion: string | null }>;
      return runs.map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion ?? null }));
    },
    async changedFiles(base, head) {
      const comparison = await reads.commits.compareRefs(config.repository, base, head);
      return (comparison.files ?? []).map(file => file.filename);
    },
    async branchSha(branch) {
      const ref = await http.request<{ object: { sha: string } }>(repoRoot + '/git/ref/heads/' + branch.split('/').map(encodeURIComponent).join('/'));
      if (!SHA_RE.test(ref.object.sha)) throw new Error('AUTO_MERGE_INVALID_REF');
      return ref.object.sha;
    },
  };
}

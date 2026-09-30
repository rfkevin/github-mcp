import { GitHubClient } from '../github/client';
import type { AppEnv } from '../config';
import { checksConfig } from '../checks/config';
import { CheckCoordinator } from '../checks/coordinator';

export type ToolContext = {
  actor: string;
  /** Permissions minimales (métadonnées) : listing de l'installation. */
  github: Pick<GitHubClient, 'repositories'>;
  /** Contenu du dépôt uniquement. Aucun droit Actions ni Pull Requests requis. */
  reads: Pick<GitHubClient, 'files' | 'commits'>;
  checks: GitHubClient['actions'];
  statuses: GitHubClient['actions'];
  workflows: GitHubClient['actions'];
  checkCoordinator?: CheckCoordinator;
};

/**
 * Un jeton minimal par famille. Une permission manquante ne bloque pas les
 * autres familles. Tous les clients MCP restent en lecture seule.
 */
export function createToolContext(env: AppEnv, actor: string, scopes: readonly string[] = []): ToolContext {
  const shared = {
    appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_INSTALLATION_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    policy: { readOnly: true },
  };

  const context: ToolContext = {
    actor,
    github: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read' } }),
    reads: new GitHubClient({
      ...shared,
      tokenPermissions: {
        metadata: 'read',
        contents: 'read',
      },
    }),
    checks: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', checks: 'read' } }).actions,
    statuses: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', statuses: 'read' } }).actions,
    workflows: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', actions: 'read' } }).actions,
  };
  const checks = checksConfig(env.GITHUB_CHECKS_CONFIG);
  if (checks.length > 0 && scopes.includes('mcp:checks')) {
    const dispatch = new GitHubClient({ ...shared, policy: { readOnly: false },
      apiVersion: '2026-03-10', tokenPermissions: { metadata: 'read', actions: 'write' },
      allowedRepositories: checks.map(item => item.repository), allowedWorkflows: ['agent-checks.yml'],
      allowedWorkflowRefs: checks.map(item => item.ref) });
    context.checkCoordinator = new CheckCoordinator(checks,
      { commits: context.reads.commits, repositories: context.github.repositories }, dispatch.actions);
  }
  return context;
}

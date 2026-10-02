import { GitHubClient } from '../github/client';
import type { AppEnv } from '../config';
import { checksConfig } from '../checks/config';
import { CheckCoordinator } from '../checks/coordinator';
import { WriteCoordinator } from '../writes/coordinator';
import { IssueWriteCoordinator } from '../writes/issues';
import { MergeCoordinator } from '../merges/coordinator';
import { writesEnabled } from '../writes/config';
import { automationEnabled } from '../automation/config';
import { AutomationCoordinator } from '../automation/coordinator';
import { WORKFLOW_NAME } from '../automation/workflow';
import { IntegrationCoordinator } from '../integration/coordinator';

export type ToolContext = {
  actor: string;
  /** Permissions minimales (métadonnées) : listing de l'installation. */
  github: Pick<GitHubClient, 'repositories'>;
  /** Contenu du dépôt uniquement. Aucun droit Actions ni Pull Requests requis. */
  reads: Pick<GitHubClient, 'files' | 'commits' | 'branches' | 'merges'>;
  /** PR isolées : une permission manquante ne bloque pas les fichiers. */
  pulls: Pick<GitHubClient, 'pullRequests' | 'issues'>;
  /** Issues isolées : permission GitHub Issues: Read, indépendante des PR. */
  issues: GitHubClient['issues'];
  checks: GitHubClient['actions'];
  statuses: GitHubClient['actions'];
  workflows: GitHubClient['actions'];
  checkCoordinator?: CheckCoordinator;
  writeCoordinator?: WriteCoordinator;
  issueWriteCoordinator?: IssueWriteCoordinator;
  mergeCoordinator?: MergeCoordinator;
  automationCoordinator?: AutomationCoordinator;
  integrationCoordinator?: IntegrationCoordinator;
};

/**
 * Un jeton minimal par famille. Une permission manquante ne bloque pas les
 * autres familles. Les clients de lecture restent en lecture seule ; les écritures sont opt-in.
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
    pulls: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', pull_requests: 'read' } }),
    issues: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read', issues: 'read' } }).issues,
  };
  const checks = checksConfig(env.GITHUB_CHECKS_CONFIG);
  context.mergeCoordinator = new MergeCoordinator(actor, { repositories: context.github.repositories, ...context.reads });
  if (automationEnabled(env.GITHUB_AUTOMATION_ENABLED) && scopes.includes('mcp:automation')) {
    const canPrepare = writesEnabled(env.GITHUB_WRITES_ENABLED) && scopes.includes('mcp:write');
    const setup = canPrepare ? new GitHubClient({ ...shared, policy: { readOnly: false, managedChecks: true },
      tokenPermissions: { metadata: 'read', contents: 'write', workflows: 'write' } }) : undefined;
    context.automationCoordinator = new AutomationCoordinator(actor,
      { repositories: context.github.repositories, ...context.reads }, context.workflows,
      (repository, ref, inputs) => new GitHubClient({ ...shared, policy: { readOnly: false },
        apiVersion: '2026-03-10', tokenPermissions: { metadata: 'read', actions: 'write' },
        allowedRepositories: [repository], allowedWorkflows: [WORKFLOW_NAME], allowedWorkflowRefs: [ref],
      }).actions.dispatchWorkflow(repository, WORKFLOW_NAME, ref, inputs), setup?.changes);
  }
  if (writesEnabled(env.GITHUB_WRITES_ENABLED) && scopes.includes('mcp:write')) {
    const contents = new GitHubClient({ ...shared, policy: { readOnly: false },
      tokenPermissions: { metadata: 'read', contents: 'write' } });
    const pulls = new GitHubClient({ ...shared, policy: { readOnly: false },
      tokenPermissions: { metadata: 'read', pull_requests: 'write' } });
    const issues = new GitHubClient({ ...shared, policy: { readOnly: false },
      tokenPermissions: { metadata: 'read', issues: 'write' } });
    context.issueWriteCoordinator = new IssueWriteCoordinator(actor, context.github.repositories, issues.issues);
    context.mergeCoordinator = new MergeCoordinator(actor, { repositories: context.github.repositories, ...context.reads }, contents.merges);
    context.writeCoordinator = new WriteCoordinator(actor,
      { repositories: context.github.repositories, branches: context.reads.branches, commits: context.reads.commits },
      { branches: contents.branches, changes: contents.changes, pullRequests: pulls.pullRequests, issues: pulls.issues, commits: contents.commits });
    if (scopes.includes('mcp:integration')) {
      context.integrationCoordinator = new IntegrationCoordinator(actor, context, (repository, head, message) =>
        new GitHubClient({ ...shared, policy: { readOnly: false }, allowIntegrationMerge: true,
          allowedRepositories: [repository], tokenPermissions: { metadata: 'read', contents: 'write' },
        }).branches.mergeIntegration(repository, head, message));
    }
  }
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

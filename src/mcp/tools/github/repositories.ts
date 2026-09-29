import type { McpServer } from '@modelcontextprotocol/server';
import { GitHubApiError, GitHubConflictError, GitHubRateLimitError } from '../../../github/client';
import { PolicyViolationError } from '../../../security/policy';
import type { ToolContext } from '../../context';

// Le motif journalisé est une classe fermée : jamais le message d'erreur d'origine.
function failureReason(error: unknown): string {
  if (error instanceof GitHubRateLimitError) return 'rate_limited';
  if (error instanceof GitHubApiError) {
    return error.status === 0 ? 'github_api_unreachable' : `github_api_${error.status}`;
  }
  if (error instanceof PolicyViolationError) return `policy_${error.code.toLowerCase()}`;
  if (error instanceof GitHubConflictError) return 'conflict';
  return 'unexpected_error';
}

function failureMessage(error: unknown): string {
  return error instanceof GitHubRateLimitError
    ? 'Limite de requêtes GitHub atteinte. Réessayez plus tard.'
    : 'Impossible de lister les dépôts GitHub.';
}

export function registerRepositoryTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_list_repositories', {
    description: 'Lister les dépôts sélectionnés dans l’installation GitHub App de ce serveur.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const repositories = await context.github.repositories.listInstallationRepositories();
      console.log(JSON.stringify({ actor: context.actor, service: 'github', action: 'list_repositories', outcome: 'success' }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ repositories }) }] };
    } catch (error) {
      console.log(JSON.stringify({ actor: context.actor, service: 'github', action: 'list_repositories', outcome: 'error', reason: failureReason(error) }));
      return { isError: true, content: [{ type: 'text' as const, text: failureMessage(error) }] };
    }
  });
}

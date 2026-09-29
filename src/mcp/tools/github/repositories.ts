import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../../context';

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
    } catch {
      console.log(JSON.stringify({ actor: context.actor, service: 'github', action: 'list_repositories', outcome: 'error' }));
      return { isError: true, content: [{ type: 'text' as const, text: 'Impossible de lister les dépôts GitHub.' }] };
    }
  });
}

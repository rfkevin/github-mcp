import type { McpServer } from '@modelcontextprotocol/server';
import { outputSchemas } from './output-schemas';
import { oauthMetadata } from './metadata';
import type { ToolContext } from '../../context';
import { textPayload, toolFailure, toolSuccess } from './result';

export function registerRepositoryTools(server: McpServer, context: ToolContext): void {
  server.registerTool('github_list_repositories', {
    title: 'Lister les dépôts accessibles',
    _meta: oauthMetadata(),
    outputSchema: outputSchemas.github_list_repositories,
    description: 'Lister les dépôts sélectionnés dans l’installation GitHub App de ce serveur.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const repositories = await context.github.repositories.listInstallationRepositories();
      toolSuccess(context, 'list_repositories');
      return textPayload({ repositories });
    } catch (error) {
      return toolFailure(context, 'list_repositories', 'Impossible de lister les dépôts GitHub.', error);
    }
  });
}

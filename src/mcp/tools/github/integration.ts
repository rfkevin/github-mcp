import type { McpServer } from '@modelcontextprotocol/server';
import { outputSchemas } from './output-schemas';
import type { ToolContext } from '../../context';
import { mergeIntegrationSchema } from '../../../integration/coordinator';
import { textPayload, toolFailure, toolSuccess } from './result';

export function registerIntegrationTools(server: McpServer, context: ToolContext): void {
  const integration = context.integrationCoordinator;
  if (!integration) return;
  server.registerTool('github_merge_integration', {
    title: 'Fusionner une pull request vers integration',
    outputSchema: outputSchemas.github_merge_integration,
    description: 'Intégrer une PR uniquement dans integration, jamais main/master ou la branche par défaut. Exige consentement mcp:integration + mcp:write, politique .mcp/integration.json validée sur la branche principale, PR interne ouverte hors brouillon, CI réussie et accords déclarés des participants aux SHA head/base actuels. Lire toute la discussion, résoudre les objections et fournir son résumé et le dernier ID de commentaire. Les labels sont déclaratifs, pas des identités de modèles. Refuser par commentaire sans fermer la PR. Après fusion, suivre la CI du résultat ; en cas de désaccord, protection GitHub ou contrôle incomplet, demander au propriétaire, sans contourner. Aucun rejeu après résultat incertain.',
    inputSchema: mergeIntegrationSchema.shape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async args => {
    try {
      const result = await integration.mergePullRequest(args);
      toolSuccess(context, 'merge_integration');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'merge_integration', 'Intégration refusée ou non confirmée. Relire la PR et integration avant toute nouvelle tentative.', error); }
  });
}

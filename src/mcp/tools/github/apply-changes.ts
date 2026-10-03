import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../../context';
import { BatchChangeCoordinator } from '../../../writes/batch/coordinator';
import { applyChangesSchema } from '../../../writes/batch/schema';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerApplyChangesTool(server: McpServer, context: ToolContext): void {
  if (!context.writeCoordinator) return;
  server.registerTool('github_apply_changes', {
    title: 'Appliquer plusieurs changements de fichiers atomiquement',
    _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_apply_changes,
    description: 'Préparer replace, append, restore et create en mémoire puis publier au plus un commit. Tous les expectedSha visent le blob initial. Les erreurs de prévalidation n’écrivent rien. Utiliser pour plusieurs changements déjà connus ; conserver les outils unitaires pour une opération simple.',
    inputSchema: applyChangesSchema.shape,
    annotations,
  }, async args => {
    try {
      const batch = new BatchChangeCoordinator(context.writeCoordinator!.branchPrefix, context.reads, context.writeCoordinator!);
      const result = await batch.apply(args);
      toolSuccess(context, 'apply_changes');
      return textPayload(result);
    } catch (error) {
      return toolFailure(context, 'apply_changes', 'Lot de changements impossible. Relisez la branche et les fichiers avant de réessayer.', error);
    }
  });
}

import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../../context';
import { commentIssueSchema, createIssueSchema } from '../../../writes/issues';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { safeDiagnostic } from './reports';
import { textPayload, toolFailure, toolSuccess } from './result';

const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerIssueWriteTools(server: McpServer, context: ToolContext): void {
  const coordinator = context.issueWriteCoordinator;
  if (!coordinator) return;
  server.registerTool('github_create_issue', {
    title: 'Créer une issue GitHub', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_create_issue,
    description: 'Créer une issue dans un dépôt non archivé de l’installation. Nécessite les écritures activées, mcp:write et un jeton dédié Issues: Write. Le corps porte le compte et le nom déclaré de l’agent. Peut notifier les collaborateurs. Après une réponse perdue ou WRITE_RESULT_UNKNOWN, lister les issues avant toute nouvelle demande ; aucun rejeu automatique ni détection garantie des doublons.',
    inputSchema: createIssueSchema.shape,
    annotations: writeAnnotations,
  }, async args => {
    try {
      const result = await coordinator.createIssue(args);
      toolSuccess(context, 'create_issue'); return textPayload({ ...result, title: safeDiagnostic(result.title, 2000) });
    } catch (error) { return toolFailure(context, 'create_issue', 'Création impossible. Vérifiez les issues existantes et la permission Issues: Write avant de réessayer.', error); }
  });
  server.registerTool('github_comment_issue', {
    title: 'Commenter une issue GitHub', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_comment_issue,
    description: 'Commenter une issue GitHub existante. Refuse les numéros de PR. Nécessite les écritures activées, mcp:write et Issues: Write. Le commentaire porte le compte GitHub et le nom déclaré de l’agent. Peut notifier les collaborateurs. Après une réponse perdue ou WRITE_RESULT_UNKNOWN, relire l’issue et ses commentaires avant tout rejeu pour éviter un doublon.',
    inputSchema: commentIssueSchema.shape,
    annotations: writeAnnotations,
  }, async args => {
    try {
      const result = await coordinator.commentIssue(args);
      toolSuccess(context, 'comment_issue'); return textPayload(result);
    } catch (error) { return toolFailure(context, 'comment_issue', 'Commentaire impossible. Relisez l’issue et vérifiez la permission Issues: Write avant de réessayer.', error); }
  });
}

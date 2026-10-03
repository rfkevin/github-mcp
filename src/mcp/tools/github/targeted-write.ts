import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { fileSha, fileWriteInputs, readWriteTarget } from './file-write-context';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';
import { replaceExactOnce } from '../../../writes/text-transforms';

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerTargetedWriteTools(server: McpServer, context: ToolContext): void {
  if (!context.writeCoordinator) return;
  server.registerTool('github_replace_text', {
    title: 'Remplacer exactement un texte dans un fichier', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_replace_text,
    description: 'Modifier un fichier existant sur sa branche de travail sans renvoyer tout le contenu. Lecture au SHA expectedHeadSha, contrôle du blob expectedSha et occurrence unique de oldText, même si les occurrences se chevauchent. Protections des commits conservées. Suivre followUp et la CI du nouveau SHA. Après une réponse perdue, relire la branche avant de rejouer. Ne garantit pas la validité du nouveau texte.',
    inputSchema: { ...fileWriteInputs, expectedSha: fileSha, oldText: z.string().min(1).max(100_000), newText: z.string().max(100_000) }, annotations,
  }, async args => {
    try {
      const file = (await readWriteTarget(context, args))!;
      const content = replaceExactOnce(file.content, args.oldText, args.newText);
      const result = await context.writeCoordinator!.commitChanges({ repository: args.repository, branch: args.branch, expectedHeadSha: args.expectedHeadSha,
        message: args.message, agentLabel: args.agentLabel, changes: [{ path: args.path, content, expectedSha: file.sha }], deletions: [] });
      toolSuccess(context, 'replace_text'); return textPayload(result);
    } catch (error) { return toolFailure(context, 'replace_text', 'Remplacement ciblé impossible. Relisez le fichier et la branche avant de réessayer.', error); }
  });
}

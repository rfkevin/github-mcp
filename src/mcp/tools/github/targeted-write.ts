import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { fileSha, fileWriteInputs, readWriteTarget } from './file-write-context';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

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
      const first = file.content.indexOf(args.oldText);
      if (first < 0) throw new InputValidationError('Le texte attendu est introuvable ; relisez le fichier.', 'TEXT_NOT_FOUND');
      if (file.content.indexOf(args.oldText, first + 1) >= 0) throw new InputValidationError('Le texte attendu apparaît plusieurs fois ; fournissez un contexte plus précis.', 'TEXT_NOT_UNIQUE');
      if (args.oldText === args.newText) throw new InputValidationError('Le remplacement ne change pas le fichier.', 'NO_CHANGE');
      const content = file.content.slice(0, first) + args.newText + file.content.slice(first + args.oldText.length);
      const result = await context.writeCoordinator!.commitChanges({ repository: args.repository, branch: args.branch, expectedHeadSha: args.expectedHeadSha,
        message: args.message, agentLabel: args.agentLabel, changes: [{ path: args.path, content, expectedSha: file.sha }], deletions: [] });
      toolSuccess(context, 'replace_text'); return textPayload(result);
    } catch (error) { return toolFailure(context, 'replace_text', 'Remplacement ciblé impossible. Relisez le fichier et la branche avant de réessayer.', error); }
  });
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { resolveCommit } from './batch';
import { fileSha, fileWriteInputs, readWriteTarget } from './file-write-context';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerFileWriteTools(server: McpServer, context: ToolContext): void {
  const coordinator = context.writeCoordinator;
  if (!coordinator) return;
  server.registerTool('github_restore_file', {
    title: 'Restaurer un fichier depuis un commit ou une référence Git', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_restore_file,
    description: 'Restaurer le contenu texte complet du même chemin depuis sourceRef, résolu une fois en SHA. expectedSha est le blob actuel, ou null pour un fichier absent. Branche personnelle, head et blob vérifiés ; protections des commits et journaux en ajout seul conservées. Pas de revert du commit entier. Suivre followUp ; relire la branche avant de rejouer une réponse perdue.',
    inputSchema: { ...fileWriteInputs, expectedSha: fileSha.nullable(), sourceRef: z.string().min(1).max(240) }, annotations,
  }, async args => {
    try {
      const current = await readWriteTarget(context, args);
      const sourceSha = await resolveCommit(context, args.repository, args.sourceRef);
      const source = await context.reads.files.getTextFile(args.repository, args.path, sourceSha);
      if (current?.content === source.content) throw new InputValidationError('Le contenu est déjà identique à la source.', 'NO_CHANGE');
      const result = await coordinator.commitChanges({ repository: args.repository, branch: args.branch,
        expectedHeadSha: args.expectedHeadSha, message: args.message, agentLabel: args.agentLabel,
        changes: [{ path: args.path, content: source.content, ...(current ? { expectedSha: current.sha } : {}) }], deletions: [] });
      toolSuccess(context, 'restore_file'); return textPayload({ ...result, sourceSha, sourceBlobSha: source.sha });
    } catch (error) { return toolFailure(context, 'restore_file', 'Restauration impossible. Relisez la source et la branche avant de réessayer.', error); }
  });
  server.registerTool('github_append_file', {
    title: 'Ajouter du texte à la fin d’un fichier', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_append_file,
    description: 'Ajouter text exactement en fin d’un fichier texte existant, sans reconstruire son contenu ni ajouter de séparateur implicite. Idéal pour AGENT_MEMORY.md et TOOL_IMPROVEMENTS.md : octets précédents conservés côté serveur. head/blob attendus et protections des commits vérifiés. Fournir les sauts de ligne nécessaires. Suivre followUp ; relire avant de rejouer pour éviter un doublon.',
    inputSchema: { ...fileWriteInputs, expectedSha: fileSha, text: z.string().min(1).max(100_000) }, annotations,
  }, async args => {
    try {
      const current = (await readWriteTarget(context, args))!;
      const result = await coordinator.commitChanges({ repository: args.repository, branch: args.branch,
        expectedHeadSha: args.expectedHeadSha, message: args.message, agentLabel: args.agentLabel,
        changes: [{ path: args.path, content: current.content + args.text, expectedSha: current.sha }], deletions: [] });
      toolSuccess(context, 'append_file'); return textPayload(result);
    } catch (error) { return toolFailure(context, 'append_file', 'Ajout impossible. Relisez le fichier et la branche avant de réessayer.', error); }
  });
}

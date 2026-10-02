import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { oauthMetadata } from './metadata';
import { textPayload, toolFailure, toolSuccess } from './result';

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerTargetedWriteTools(server: McpServer, context: ToolContext): void {
  if (!context.writeCoordinator) return;
  server.registerTool('github_replace_text', {
    title: 'Remplacer exactement un texte dans un fichier', _meta: oauthMetadata('mcp:write'),
    description: 'Modifier un fichier existant sans renvoyer son contenu complet. Le serveur relit le fichier sur la branche, vérifie expectedSha et exige que oldText apparaisse exactement une fois. Évite les écrasements accidentels de type PLACEHOLDER. Ne convient pas aux suppressions ni aux fichiers nouveaux.',
    inputSchema: { repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), path: z.string().min(1).max(1024),
      expectedHeadSha: sha, expectedSha: sha, oldText: z.string().min(1).max(100_000), newText: z.string().max(100_000),
      message: z.string().trim().min(1).max(140), agentLabel: z.string().trim().min(1).max(80).default('agent non précisé') }, annotations,
  }, async args => {
    try {
      const file = await context.reads.files.getTextFile(args.repository, args.path, args.branch);
      if (file.sha.toLowerCase() !== args.expectedSha.toLowerCase()) throw new InputValidationError('Le fichier a changé depuis sa lecture.', 'FILE_CHANGED');
      const first = file.content.indexOf(args.oldText);
      if (first < 0) throw new InputValidationError('Le texte attendu est introuvable ; relisez le fichier.', 'TEXT_NOT_FOUND');
      if (file.content.indexOf(args.oldText, first + args.oldText.length) >= 0) throw new InputValidationError('Le texte attendu apparaît plusieurs fois ; fournissez un contexte plus précis.', 'TEXT_NOT_UNIQUE');
      const content = file.content.slice(0, first) + args.newText + file.content.slice(first + args.oldText.length);
      const result = await context.writeCoordinator!.commitChanges({ repository: args.repository, branch: args.branch, expectedHeadSha: args.expectedHeadSha,
        message: args.message, agentLabel: args.agentLabel, changes: [{ path: args.path, content, expectedSha: file.sha }], deletions: [] });
      toolSuccess(context, 'replace_text'); return textPayload(result);
    } catch (error) { return toolFailure(context, 'replace_text', 'Remplacement ciblé impossible. Relisez le fichier et la branche avant de réessayer.', error); }
  });
}

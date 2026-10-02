import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolContext } from '../../context';
import { InputValidationError } from '../../../github/types';
import { SENSITIVE_FILE } from '../../../github/files';
import { assertWritableBranch, assertWritablePath } from '../../../security/policy';
import { agentLabelSchema } from '../../../writes/coordinator';
import { oauthMetadata } from './metadata';
import { outputSchemas } from './output-schemas';
import { textPayload, toolFailure, toolSuccess } from './result';

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerTargetedWriteTools(server: McpServer, context: ToolContext): void {
  if (!context.writeCoordinator) return;
  server.registerTool('github_replace_text', {
    title: 'Remplacer exactement un texte dans un fichier', _meta: oauthMetadata('mcp:write'),
    outputSchema: outputSchemas.github_replace_text,
    description: 'Modifier un fichier existant sur sa branche de travail sans renvoyer tout le contenu. Lecture au SHA expectedHeadSha, contrôle du blob expectedSha et occurrence unique de oldText, même si les occurrences se chevauchent. Protections des commits conservées. Suivre followUp et la CI du nouveau SHA. Après une réponse perdue, relire la branche avant de rejouer. Ne garantit pas la validité du nouveau texte.',
    inputSchema: { repository: z.string().min(3).max(200), branch: z.string().min(1).max(240), path: z.string().min(1).max(1024),
      expectedHeadSha: sha, expectedSha: sha, oldText: z.string().min(1).max(100_000), newText: z.string().max(100_000),
      message: z.string().trim().min(1).max(200), agentLabel: agentLabelSchema.default('agent non précisé') }, annotations,
  }, async args => {
    try {
      assertWritableBranch(args.branch);
      if (!args.branch.startsWith(context.writeCoordinator!.branchPrefix)) {
        throw new InputValidationError('Cette branche n’appartient pas à l’utilisateur connecté.', 'BRANCH_OWNER_MISMATCH');
      }
      assertWritablePath(args.path);
      if (SENSITIVE_FILE.test(args.path)) throw new InputValidationError('Fichier sensible interdit.', 'SENSITIVE_FILE');
      const head = await context.reads.branches.getBranchHead(args.repository, args.branch);
      if (head.toLowerCase() !== args.expectedHeadSha.toLowerCase()) throw new InputValidationError('La branche a changé : relisez le fichier.', 'HEAD_CHANGED');
      const file = await context.reads.files.getTextFile(args.repository, args.path, args.expectedHeadSha);
      if (file.sha.toLowerCase() !== args.expectedSha.toLowerCase()) throw new InputValidationError('Le fichier a changé depuis sa lecture.', 'FILE_CHANGED');
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

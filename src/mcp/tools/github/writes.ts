import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from '../../context';
import { createBranchSchema, commitChangesSchema, openPullRequestSchema, commentPullRequestSchema } from '../../../writes/coordinator';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerWriteTools(server: McpServer, context: ToolContext): void {
  const writes = context.writeCoordinator;
  if (!writes) return;
  server.registerTool('github_comment_pull_request', {
    description: 'Publier un bilan sur une PR ouverte de sa propre branche, dans le même dépôt. Fournir le SHA actuel de la PR. Aucun pouvoir de revue APPROVE, de fusion ou de déploiement. En cas de réponse perdue, lire les commentaires avant de relancer.',
    inputSchema: commentPullRequestSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.commentPullRequest(args);
      toolSuccess(context, 'comment_pull_request');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'comment_pull_request', 'Commentaire impossible. Vérifiez la discussion avant de relancer.', error); }
  });
  server.registerTool('github_create_branch', {
    description: 'Créer une branche mcp/<utilisateur connecté>/<task> dans un dépôt sélectionné dans l’installation GitHub. Fournir le SHA de base lu auparavant. Aucun écrasement de branche existante. Peut déclencher les automatisations du dépôt.',
    inputSchema: createBranchSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.createBranch(args);
      toolSuccess(context, 'create_branch');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'create_branch', 'Création de branche impossible. Vérifiez son état avant de relancer.', error); }
  });
  server.registerTool('github_commit_changes', {
    description: 'Créer un commit atomique sur sa branche de travail uniquement. Fournir expectedHeadSha et le SHA du blob pour chaque fichier modifié ou supprimé. Sans expectedSha, le fichier doit être nouveau. AGENT_MEMORY.md : ajout en fin uniquement, conserver intégralement les anciennes notes et signer sa contribution. Maximum 50 fichiers et 1 Mo cumulé. Secrets et fichiers de contrôle CI interdits. Peut déclencher la CI ; ne fusionne pas.',
    inputSchema: commitChangesSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.commitChanges(args);
      toolSuccess(context, 'commit_changes');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'commit_changes', 'Commit impossible. Vérifiez la branche avant de relancer.', error); }
  });
  server.registerTool('github_open_pull_request', {
    description: 'Après relecture du diff, ouvrir une PR en brouillon de sa branche vers baseBranch (branche de départ choisie) ou la branche par défaut. Fournir expectedHeadSha. Ne fusionne ni n’approuve la PR. Peut déclencher les automatisations du dépôt. Vérifier les PR existantes avant de relancer après une erreur.',
    inputSchema: openPullRequestSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.openPullRequest(args);
      toolSuccess(context, 'open_pull_request');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'open_pull_request', 'Ouverture de PR impossible. Vérifiez les PR existantes avant de relancer.', error); }
  });
}

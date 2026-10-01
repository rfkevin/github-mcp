import type { McpServer } from '@modelcontextprotocol/server';
import { outputSchemas } from './output-schemas';
import type { ToolContext } from '../../context';
import { createBranchSchema, commitChangesSchema, openPullRequestSchema, commentPullRequestSchema, commentCommitSchema } from '../../../writes/coordinator';
import { textPayload, toolFailure, toolSuccess } from './result';

const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export function registerWriteTools(server: McpServer, context: ToolContext): void {
  const writes = context.writeCoordinator;
  if (!writes) return;
  server.registerTool('github_comment_commit', {
    title: 'Commenter un commit',
    outputSchema: outputSchemas.github_comment_commit,
    description: 'Commenter un commit exact, y compris celui d’un autre agent, dans un dépôt sélectionné. Lire d’abord github_get_commit et ses commentaires. Fournir SHA, agentLabel (nom déclaré), constat, impact sur votre intégration et preuve/suggestion. Commentaire général uniquement, aucune modification de code, revue APPROVE ou fusion. Peut notifier et déclencher des automatisations. Ne pas rejouer après une réponse perdue : relire les commentaires.',
    inputSchema: commentCommitSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.commentCommit(args);
      toolSuccess(context, 'comment_commit');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'comment_commit', 'Commentaire impossible. Relisez les commentaires du commit avant de réessayer.', error); }
  });
  server.registerTool('github_comment_pull_request', {
    title: 'Participer à la discussion d’une pull request',
    outputSchema: outputSchemas.github_comment_pull_request,
    description: 'Discuter sur une PR ouverte, y compris celle d’un autre agent (hors fork). Lire toute la discussion avant de répondre. Fournir expectedHeadSha et agentLabel stable. decision=comment pour discuter ; changes_requested pour un blocage ; agree après résolution et vérification. Ces deux avis exigent aussi expectedBaseSha et deviennent périmés si head/base change. Proposer une solution avec preuves, ne pas parler au nom des autres. Refus par commentaire, sans fermeture. Ni modification du code ni APPROVE GitHub. En cas de réponse perdue, relire avant de rejouer.',
    inputSchema: commentPullRequestSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.commentPullRequest(args);
      toolSuccess(context, 'comment_pull_request');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'comment_pull_request', 'Commentaire impossible. Vérifiez la discussion avant de relancer.', error); }
  });
  server.registerTool('github_create_branch', {
    title: 'Créer une branche de travail',
    outputSchema: outputSchemas.github_create_branch,
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
    title: 'Enregistrer les modifications dans un commit',
    outputSchema: outputSchemas.github_commit_changes,
    description: 'Créer un commit atomique sur sa branche de travail uniquement. Fournir expectedHeadSha, agentLabel déclaré et le SHA du blob pour chaque fichier modifié ou supprimé. Sans expectedSha, le fichier doit être nouveau. Le message complet avec trace MCP doit tenir dans 200 caractères. AGENT_MEMORY.md et TOOL_IMPROVEMENTS.md : ajout en fin uniquement, conserver intégralement les anciennes notes et signer sa contribution. Maximum 50 fichiers et 1 Mo cumulé. Secrets et fichiers de contrôle CI interdits. Suivre followUp jusqu’aux résultats CI/build du SHA produit ; ne fusionne pas.',
    inputSchema: commitChangesSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.commitChanges(args);
      toolSuccess(context, 'commit_changes');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'commit_changes', 'Commit impossible. Vérifiez la branche avant de relancer.', error); }
  });
  server.registerTool('github_open_pull_request', {
    title: 'Ouvrir une pull request',
    outputSchema: outputSchemas.github_open_pull_request,
    description: 'Après relecture du diff, ouvrir une PR de sa branche vers baseBranch ou la branche par défaut. draft=true par défaut ; false seulement si prête pour revue. Fournir expectedHeadSha. Ne fusionne ni n’approuve. PR créée ne signifie pas tâche terminée : suivre followUp, attendre CI/build au dernier SHA et discuter avec les collaborateurs jusqu’à résolution des objections. Peut déclencher les automatisations. Vérifier les PR existantes avant de relancer après une erreur.',
    inputSchema: openPullRequestSchema.shape, annotations,
  }, async args => {
    try {
      const result = await writes.openPullRequest(args);
      toolSuccess(context, 'open_pull_request');
      return textPayload(result);
    } catch (error) { return toolFailure(context, 'open_pull_request', 'Ouverture de PR impossible. Vérifiez les PR existantes avant de relancer.', error); }
  });
}

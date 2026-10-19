import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure } from './result';
import { previewNextActions } from '../controller/next-actions';
import { CollabStoreError } from '../store/collab-store';

/**
 * CC-5 L3d — lecture des prochaines actions du contrôleur pour l'appelant.
 * Identité issue du jeton OAuth (jamais un participant fourni par le client),
 * lecture seule : rien n'est journalisé ni exécuté.
 */
export function registerControllerTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_next_actions', {
    title: 'Prochaines actions (contrôleur CC-5)',
    description: 'CC-5 L3d : ce que le contrôleur attend de VOUS dans ce cycle, calculé sur l\'état courant du store : implémenter, relire ou tester au head/base exacts, renouveler un verdict périmé ou sans SHA, corriger après un verdict négatif, répondre à une question qui vous est adressée (clarify.answer), renouveler ou clore une question expirée ; les décisions « coordinator » s\'ajoutent si vous tenez le mandat actif. Identité dérivée du jeton serveur. all=true ajoute toutes les décisions du cycle (dont merge_ready pour Kevin). Lecture seule : rien n\'est journalisé ni exécuté ; HALT → mode halted sans décision ; store illisible → mode degraded.',
    inputSchema: { cycle: z.string().min(1).max(64), all: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const identity = await context.identity();
      if (identity.status !== 'registered') {
        throw new CollabStoreError('UNREGISTERED_CLIENT', 'collab_next_actions : client non associé à un participant enregistré.');
      }
      const view = await previewNextActions(context.db, input.cycle, identity.participant_id, { all: input.all === true });
      return { content: [{ type: 'text' as const, text: JSON.stringify(view) }] };
    } catch (error) {
      return collabFailure(error, 'Lecture des prochaines actions impossible.', {}, context.fallback);
    }
  });
}

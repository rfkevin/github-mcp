import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure } from './result';
import { previewNextActions } from '../controller/next-actions';
import { CollabStoreError } from '../store/collab-store';
import { adjustPhase, SOFT_PHASE_OPS, SOFT_REASON_MAX, SOFT_REASON_MIN } from '../phases/soft';

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
  server.registerTool('collab_phase_adjust', {
    title: 'Phases souples (coordinateur CC-5)',
    description: 'CC-5 L3d B1 : réorganisation du cycle par le coordinateur qui tient le mandat actif (nommé par Kevin sur /owner) — round.add (nouveau tour de la phase courante), phase.reopen (rouvrir une phase antérieure, target_phase obligatoire), phase.skip (sauter la phase courante si facultative). Justification obligatoire, journalisée. Le code vérifie dans le lot : mandat, HALT, révision et phase, au plus 3 tours par phase et 10 réorganisations par cycle, jamais de saut de P5, d\'une phase à conditions de sortie ni d\'un tour scellé. Une nouvelle ronde repart de zéro ; les scellés de la ronde quittée sont révélés. D12 inchangé. op_id strict {client}:{cycle}:{op}:{n} ; rejeu = duplicate.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      op: z.enum(SOFT_PHASE_OPS),
      target_phase: z.string().min(1).max(8).optional(),
      reason: z.string().min(SOFT_REASON_MIN).max(SOFT_REASON_MAX),
      op_id: z.string().min(1).max(253),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const identity = await context.identity();
      if (identity.status !== 'registered') {
        throw new CollabStoreError('UNREGISTERED_CLIENT', 'collab_phase_adjust : client non associé à un participant enregistré.');
      }
      const outcome = await adjustPhase(context.db, {
        cycle_id: input.cycle, participant_id: identity.participant_id, op: input.op, target_phase: input.target_phase,
        expected_revision: input.expected_rev, reason: input.reason, op_id: input.op_id,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] };
    } catch (error) {
      return collabFailure(error, 'Réorganisation de phase impossible.', {}, context.fallback);
    }
  });
}

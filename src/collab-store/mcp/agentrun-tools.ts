/**
 * CC-5 l7e — outils MCP de continuité chat pour les exécutions API du participant.
 * Identité uniquement depuis le jeton serveur ; jamais d'accès aux runs d'autrui.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure } from './result';
import { CollabStoreError } from '../store/collab-store';
import {
  listRunsForParticipant,
  runSummaryForParticipant,
  preemptOwnRun,
  releaseOwnRun,
  CHAT_HOLD_SECONDS_DEFAULT,
} from '../agentrun/chat-continuity';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

async function registered(context: CollabToolContext, tool: string): Promise<string> {
  const identity = await context.identity();
  if (identity.status !== 'registered') {
    throw new CollabStoreError('UNREGISTERED_CLIENT', tool + ' : client non associé à un participant enregistré.');
  }
  return identity.participant_id;
}

export function registerAgentRunTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_list_agent_runs', {
    title: 'Lister mes exécutions API (CC-5 l7e)',
    description: 'Lecture seule : exécutions agent API de VOTRE participant serveur uniquement (masquage CR-C). Option cycle_id pour filtrer. Aucune écriture.',
    inputSchema: {
      cycle_id: z.string().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_list_agent_runs');
      const runs = await listRunsForParticipant(context.db, participantId, {
        cycleId: input.cycle_id,
        limit: input.limit,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ runs }) }] };
    } catch (error) {
      return collabFailure(error, 'Liste des exécutions impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_agent_run_summary', {
    title: 'Résumé d’une exécution API (CC-5 l7e)',
    description: 'Lecture seule : résumé d’une exécution qui vous appartient (statut, étapes, jetons, effets). run_id inconnu ou d’un autre participant → null.',
    inputSchema: {
      run_id: z.string().min(1).max(128),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_agent_run_summary');
      const summary = await runSummaryForParticipant(context.db, participantId, input.run_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ summary }) }] };
    } catch (error) {
      return collabFailure(error, 'Résumé d’exécution impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_preempt_agent_run', {
    title: 'Préempter une exécution API (chat prioritaire, CC-5 l7e)',
    description: 'Le chat reprend le bail (fencing 7a) pour VOS exécutions seulement. hold_seconds défaut 900. Une étape API en vol perd ses écritures LIVE.',
    inputSchema: {
      cycle_id: z.string().min(1).max(64),
      task_id: z.string().max(64).optional(),
      hold_seconds: z.number().int().min(0).max(86_400).optional(),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_preempt_agent_run');
      const now = Math.floor(Date.now() / 1000);
      const result = await preemptOwnRun(context.db, {
        participantId,
        cycleId: input.cycle_id,
        taskId: input.task_id ?? '',
        now,
        holdSeconds: input.hold_seconds ?? CHAT_HOLD_SECONDS_DEFAULT,
      });
      if (!result.ok) {
        throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Aucune exécution à vous pour ce cycle/tâche.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ preempted: true, generation: result.generation }) }] };
    } catch (error) {
      return collabFailure(error, 'Préemption impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_release_agent_run', {
    title: 'Rendre la main à l’API (CC-5 l7e)',
    description: 'Libère le bail chat pour VOS exécutions seulement (holder none, sans nouvelle génération).',
    inputSchema: {
      cycle_id: z.string().min(1).max(64),
      task_id: z.string().max(64).optional(),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_release_agent_run');
      const now = Math.floor(Date.now() / 1000);
      const result = await releaseOwnRun(context.db, {
        participantId,
        cycleId: input.cycle_id,
        taskId: input.task_id ?? '',
        now,
      });
      if (!result.ok) {
        throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Aucune exécution à vous pour ce cycle/tâche.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ released: true }) }] };
    } catch (error) {
      return collabFailure(error, 'Relâchement impossible.', {}, context.fallback);
    }
  });
}

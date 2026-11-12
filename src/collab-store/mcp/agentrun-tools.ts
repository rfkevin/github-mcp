/**
 * CC-5 l7e — outils MCP de continuité chat pour les exécutions API du participant.
 * Identité uniquement depuis le jeton serveur ; jamais d'accès aux runs d'autrui.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { outputSchemas } from './schemas';
import { collabFailure, collabSuccess } from './result';
import { CollabStoreError } from '../store/collab-store';
import {
  listRunsForParticipant,
  runSummaryForParticipant,
  redactedRunSummaryFor,
  preemptOwnRun,
  releaseOwnRun,
  CHAT_HOLD_SECONDS_DEFAULT,
} from '../agentrun/chat-continuity';
import { coordinatorRunOverview } from '../agentrun/capacity';
import { assignCoordinatorWorksession } from '../agentrun/coordinator-launch';
import { previewNextActions } from '../controller/next-actions';
import { isCoordinator } from '../owner/coordinators';

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
  server.registerTool('collab_agent_runs_overview', {
    title: 'Vue du coordinateur sur les exécutions API (CC-8 S1a)',
    description: 'Lecture seule, coordinateur seulement (mandat du cycle ou coordinateur owner-approved, sinon COORDINATOR_REQUIRED) : '
      + 'pour un cycle, état des exécutions API de TOUS les agents (statut, code d’arrêt, étapes, jetons, coût), comptes par agent, '
      + 'dernier verdict de capacité du planificateur par agent et type (refus typé ou modèle retenu) et maillons en pause coupe-circuit. '
      + 'Métadonnées seulement : ni consigne, ni résumé, ni sortie de modèle.',
    inputSchema: {
      cycle_id: z.string().min(1).max(64),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_agent_runs_overview');
      const view = await previewNextActions(context.db, input.cycle_id, participantId);
      if (!view.coordinator && !await isCoordinator(context.db, participantId)) {
        throw new CollabStoreError('COORDINATOR_REQUIRED', 'collab_agent_runs_overview : réservé au coordinateur du cycle ' + input.cycle_id + '.');
      }
      const overview = await coordinatorRunOverview(context.db, input.cycle_id, { now: Math.floor(Date.now() / 1000), limit: input.limit });
      return { content: [{ type: 'text' as const, text: JSON.stringify(overview) }] };
    } catch (error) {
      return collabFailure(error, 'Vue des exécutions impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_assign_worksession',{
    title:'Attribuer une WorkSession (exécution automatique)',
    description:'Attribution et mandat GitHub par coordinateur owner-approved. Aucun run créé ou réveillé ici : '
      +'le contrôleur/planificateur unique démarre immédiatement par défaut, ou à scheduled_at UTC explicite.',
    inputSchema:{
      cycle:z.string().min(1).max(64),task:z.string().min(1).max(64),
      participant:z.string().min(1).max(128),reviewer:z.string().min(1).max(128).optional(),
      tester:z.string().min(1).max(128).optional(),
      paths:z.array(z.string().min(1).max(400)).min(1).max(5).optional(),
      acceptance:z.array(z.string().min(1).max(350)).min(1).max(4).optional(),
      scheduled_at:z.number().int().nonnegative().optional(),op_id:z.string().min(1).max(253),
    },
    outputSchema:outputSchemas.collab_assign_worksession,annotations:WRITE,
  },async input=>{
    try{
      const identity=await context.identity();
      if(identity.status!=='registered'||!context.agentRunEnv.AGENT_RUN)
        throw new CollabStoreError('AGENT_RUN_UNAVAILABLE','Identity and Durable Object binding required.');
      const result=await assignCoordinatorWorksession({
        db:context.db,store:context.store,env:context.agentRunEnv,
        coordinator:identity.participant_id,cycle:input.cycle,task:input.task,participant:input.participant,
        reviewer:input.reviewer,tester:input.tester,paths:input.paths,acceptance:input.acceptance,
        scheduledAt:input.scheduled_at,opId:input.op_id,now:Math.floor(Date.now()/1000),
      });
      return collabSuccess({ ...result });
    }catch(error){return collabFailure(error,'Attribution WorkSession refusée.',{},context.fallback);}
  });

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
    description: 'Lecture seule : résumé d’une exécution. Propriétaire du run : résumé complet (summary) et résumé expurgé (redacted). Coordinateur au mandat actif du cycle du run (CC8 lot B #282) : résumé expurgé seulement — statut, stop_reason masqué, étapes serveur/modèle, jetons, coût, reçus d’effets (SHA, PR, CI), relevés CI, appels modèle (maillon choisi, servi, repli), preuve serveur run.proof ; jamais de prompt, sortie modèle, argument ni contenu. Toute autre identité ou run inconnu → null.',
    inputSchema: {
      run_id: z.string().min(1).max(128),
    },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const participantId = await registered(context, 'collab_agent_run_summary');
      const summary = await runSummaryForParticipant(context.db, participantId, input.run_id);
      const redacted = await redactedRunSummaryFor(context.db, participantId, input.run_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ summary, redacted }) }] };
    } catch (error) {
      return collabFailure(error, 'Résumé d’exécution impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_preempt_agent_run', {
    title: 'Préempter le bail API (chat prioritaire, CC-5 l7e / CC-7 L1)',
    description: 'Le chat prend le bail (fencing 7a) pour VOTRE identité serveur (cycle/task). CC-7 L1 : aucune exécution préalable requise — ouverture de session chat. hold_seconds défaut 900. Une étape API en vol perd ses écritures LIVE. CC-7 L15 : collab_append_event prend déjà ce bail automatiquement (1 h, renouvelée) à chaque écriture sur une tâche ; cet outil sert à le prendre plus longtemps (jusqu’à 24 h) avant un long travail sans écriture.',
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
        throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Identité ou cycle invalide pour la préemption.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ preempted: true, generation: result.generation }) }] };
    } catch (error) {
      return collabFailure(error, 'Préemption impossible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_release_agent_run', {
    title: 'Rendre la main à l’API (CC-5 l7e / CC-7 L1)',
    description: 'Libère le bail chat pour VOTRE identité (holder none). CC-7 L1 : aucune exécution préalable requise.',
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
        throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Identité ou cycle invalide pour le relâchement.');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ released: true }) }] };
    } catch (error) {
      return collabFailure(error, 'Relâchement impossible.', {}, context.fallback);
    }
  });
}

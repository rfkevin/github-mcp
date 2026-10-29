/**
 * CC-7 L11 — outil MCP des chercheurs en tournante : le coordinateur confie la passe du jour
 * (veille des prix ou recherche infrastructure) à un agent du canal API. Présent seulement si
 * AGENT_RUNS_ENABLED et AGENT_RUN_RESEARCH valent « true » (catalogue par défaut inchangé).
 * Identité depuis le jeton serveur ; la consigne de l'exécution est écrite par le serveur.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure, collabSuccess } from './result';
import { CollabStoreError } from '../store/collab-store';
import { assignResearch, RESEARCH_SUBJECTS, type ResearchEnv } from '../agentrun/research';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ID = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i);

export function registerResearchTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_research_assign', {
    title: 'Confier la passe de recherche du jour à un agent API (CC-7 L11)',
    description: 'Coordinateur actif seulement. Crée une exécution API de type research pour participant (canal API, AGENT_RUN_PARTICIPANTS) : subject prix (veille des prix et des modèles) ou infra (recherche infrastructure). Une seule passe par agent, sujet et jour (rejouer rend la même). L’agent lit les pages officielles, le salon (journal partagé) et publie au plus un message info ; coût plafonné par AGENT_RUN_COST_CENTS_RESEARCH (0 = gratuit seulement). Suivi : collab_list_agent_runs / collab_agent_run_summary.',
    inputSchema: {
      cycle: ID,
      participant: z.string().min(1).max(128),
      subject: z.enum(RESEARCH_SUBJECTS),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const identity = await context.identity();
      if (identity.status !== 'registered') {
        throw new CollabStoreError('UNREGISTERED_CLIENT', 'collab_research_assign : client non associé à un participant enregistré.');
      }
      const result = await assignResearch(context.db, context.models as unknown as ResearchEnv, {
        actor: identity.participant_id, cycleId: input.cycle, participantId: input.participant, subject: input.subject,
        now: Math.floor(Date.now() / 1000),
      });
      return collabSuccess({ ...result });
    } catch (error) {
      return collabFailure(error, 'Passe de recherche impossible.', {}, context.fallback);
    }
  });
}

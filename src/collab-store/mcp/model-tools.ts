/**
 * CC-7 L9a — outils MCP du catalogue des modèles et du choix de modèle des agents API.
 * Présents seulement si AGENT_RUNS_ENABLED="true" (catalogue par défaut inchangé).
 * Identité depuis le jeton serveur ; la présence d'une clé est un booléen, jamais sa valeur.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { collabFailure, collabSuccess } from './result';
import { CollabStoreError } from '../store/collab-store';
import { isCoordinator } from '../owner/coordinators';
import { modelCatalog, setModelPreference, POLICY_MAX_MODELS } from '../agentrun/model-policy';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const ID = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i);

async function registered(context: CollabToolContext, tool: string): Promise<string> {
  const identity = await context.identity();
  if (identity.status !== 'registered') {
    throw new CollabStoreError('UNREGISTERED_CLIENT', tool + ' : client non associé à un participant enregistré.');
  }
  return identity.participant_id;
}

export function registerModelTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_model_catalog', {
    title: 'Catalogue des modèles des agents API (CC-7 L9a)',
    description: 'Lecture seule. Pour chaque agent API : famille, modèles autorisés (gratuit / payant / indisponible), tarif daté (périmé > 30 jours), clé présente (oui / non), disponibilité mesurée (appels réussis / en échec, dernière erreur, latence), budget restant du jour et du cycle, modèle retenu par défaut par type de tâche et préférences posées. cycle facultatif (budget du cycle et préférences).',
    inputSchema: { cycle: ID.optional() },
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      await registered(context, 'collab_model_catalog');
      const agents = await modelCatalog(context.db, context.models, { cycleId: input.cycle ?? null });
      return collabSuccess({ agents, max_models_per_agent: POLICY_MAX_MODELS });
    } catch (error) {
      return collabFailure(error, 'Catalogue des modèles indisponible.', {}, context.fallback);
    }
  });

  server.registerTool('collab_choose_model', {
    title: 'Choisir le modèle d’un agent API (CC-7 L9a)',
    description: 'Pose (ref) ou retire (ref null) la préférence de modèle d’un agent pour un cycle, et pour une tâche si task est donné. L’agent choisit pour lui-même ; un coordinateur actif peut choisir pour n’importe quel agent. Le modèle doit figurer dans la liste de l’agent (sa famille) ; le serveur l’applique à chaque étape s’il est abordable, sinon prend l’option suivante de la liste et le journalise.',
    inputSchema: {
      cycle: ID,
      participant: z.string().min(1).max(128).optional(),
      task: ID.optional(),
      ref: z.string().min(3).max(220).nullable(),
      reason: z.string().max(500).optional(),
    },
    annotations: WRITE,
  }, async (input) => {
    try {
      const actor = await registered(context, 'collab_choose_model');
      const participantId = input.participant ?? actor;
      const result = await setModelPreference(context.db, context.models, {
        actor, actorIsCoordinator: participantId !== actor && await isCoordinator(context.db, actor),
        cycleId: input.cycle, participantId, taskId: input.task, ref: input.ref, reason: input.reason,
        now: Math.floor(Date.now() / 1000),
      });
      return collabSuccess({ participant: participantId, ...result });
    } catch (error) {
      return collabFailure(error, 'Choix de modèle impossible.', {}, context.fallback);
    }
  });
}

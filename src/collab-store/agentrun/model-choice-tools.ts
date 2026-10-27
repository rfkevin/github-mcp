/**
 * CC-7 L9b — `store_choose_model` : un agent API choisit lui-même son modèle (dans SA liste,
 * donc sa famille) et son niveau de réflexion pour les étapes suivantes de SA tâche.
 * Le serveur relit l'exécution (cycle, participant, tâche) dans agent_runs, jamais dans les
 * arguments ; la préférence suit les mêmes règles que collab_choose_model (liste de l'agent,
 * appliquée seulement si abordable, sinon option suivante journalisée). Écriture idempotente :
 * un rejeu repose la même préférence.
 */
import { CollabStoreError } from '../store/collab-store';
import { EFFORTS } from './effort';
import { setModelPreference, type PolicyEnv } from './model-policy';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';

export const MODEL_CHOICE_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_choose_model', description: 'Choisir, pour les prochaines étapes de votre tâche, un modèle de votre liste (ref) et un niveau de réflexion (effort : low, medium, high, xhigh). Le serveur vérifie la liste et votre budget ; sans ref, votre choix est retiré.',
    parameters: { type: 'object', properties: {
      ref: { type: 'string', maxLength: 220 },
      effort: { type: 'string', enum: [...EFFORTS] },
      reason: { type: 'string', maxLength: 500 },
    }, additionalProperties: false } },
]);

export interface ModelChoiceTools {
  execute(call: ToolCall, ctx: { run_id: string }): Promise<unknown>;
  lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

export function createModelChoiceTools(db: D1Database, env: PolicyEnv, now: () => number = () => Math.floor(Date.now() / 1000)): ModelChoiceTools {
  return {
    async execute(call, ctx) {
      const run = await db.prepare('SELECT cycle_id, participant_id, task_id FROM agent_runs WHERE run_id = ?1').bind(ctx.run_id)
        .first<{ cycle_id: string; participant_id: string; task_id: string }>();
      if (!run) throw new ToolRefused('unknown_run');
      const args = call.args ?? {};
      const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref.trim() : null;
      try {
        return await setModelPreference(db, env, {
          actor: run.participant_id, actorIsCoordinator: false, cycleId: run.cycle_id, participantId: run.participant_id,
          taskId: run.task_id || undefined, ref, effort: typeof args.effort === 'string' ? args.effort : null,
          reason: typeof args.reason === 'string' ? args.reason : 'choix de l’agent', now: now(),
        });
      } catch (error) {
        if (error instanceof CollabStoreError) throw new ToolRefused(error.code);
        throw error;
      }
    },
    // Préférence posée par upsert : rejouer l'écriture est sans effet supplémentaire.
    async lookup() {
      return { found: false };
    },
  };
}

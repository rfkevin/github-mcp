/**
 * CC-3 C2 — les 3 outils collab_* du store (plan CC-PLAN-3/v1.1 §5) :
 * lecture de contexte minimal, reprise par curseur de séquence, append
 * idempotent. Résolution complète de contexte (mémoire, packets par rôle) : C3.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { outputSchemas } from './schemas';
import { collabFailure as failure, collabSuccess } from './result';
import { CollabStoreError, type AppendOutcome } from '../store/collab-store';
import type { StoreEventType } from '../contracts';
import { authorizeAppend } from '../identity';
import { exportCycleState, exportMemoryMarkdown } from '../export';
import { resolveContextTarget } from '../context';
import { advanceGuarded } from '../phases/gate';
import type { Phase } from '../../collab/contracts';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createCollabServer(context: CollabToolContext): McpServer {
  const server = new McpServer({ name: 'collab-store', version: '0.1.0' }, {
    instructions: 'Store dynamique CC-3 : journal append-only par cycle, CAS fail-closed par expected_rev. Le scope collab: est requis ; les scopes GitHub n\'ouvrent aucun outil ici. Append idempotent par op_id ({client}:{cycle}:{op}:{n}) ; duplicate = l\'événement original est renvoyé sans seconde écriture ; STALE = rejouez le delta puis réessayez à currentRevision. collab_export produit l\'instantané CC-STATE-1 à proposer par PR (il n\'écrit jamais dans GitHub). STORE_UNAVAILABLE = repli en lecture seule via github_collab_context (champ fallback), aucune écriture de substitution dans GitHub. Guide : docs/collaboration/cc3/collab-store-guide.md.',
  });
  registerCollabStoreTools(server, context);
  return server;
}

export function registerCollabStoreTools(server: McpServer, context: CollabToolContext): void {
  const collabFailure = (error: unknown, fallback: string, extra: Record<string, unknown> = {}) =>
    failure(error, fallback, extra, context.fallback);
  server.registerTool('collab_get_context', {
    title: 'Contexte de cycle (store CC-3)',
    description: 'En-tête du cycle (phase, statut, révision) et tâches impliquant le participant (auteur, reviewer ou testeur ; par défaut le vôtre, dérivé du jeton). Renvoie aussi caller : votre participant_id et votre statut (registered/unregistered). Lecture seule. La résolution complète (mémoire, packets par rôle) arrive en C3.',
    inputSchema: {
      cycle: z.string().min(1).max(64).optional(),
      issue: z.string().min(1).max(128).optional(),
      repository: z.string().min(1).max(200).optional(),
      task: z.string().min(1).max(64).optional(),
      participant_id: z.string().min(1).max(128).optional(),
    },
    outputSchema: outputSchemas.collab_get_context,
    annotations: READ_ONLY,
  }, async ({ cycle, issue, repository, task, participant_id }) => {
    try {
      const identity = await context.identity();
      const participantId = participant_id ?? identity.participant_id;
      const resolved = await resolveContextTarget(context.db, {
        cycle, issue, repository, task, participant_id: participantId,
      });
      const value = await context.store.getContext(resolved.cycle_id, participantId);
      return collabSuccess({
        ...value,
        participant_id: participantId,
        caller: { participant_id: identity.participant_id, status: identity.status },
        resolved: { cycle_id: resolved.cycle_id, task: resolved.task },
      });
    } catch (error) {
      return collabFailure(error, 'Contexte de cycle indisponible.');
    }
  });

  server.registerTool('collab_phase_advance', {
    title: 'Avance de phase (store CC-3)',
    description: 'Avance policy avec transitions autorisées et conditions d\'entrée de la cible (A07). La policy est dérivée de auto_advance de la phase courante (jamais fournie par l\'agent). Rejeu de la même intention détecté avant STALE. N\'est pas un canal owner.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      next_phase: z.string().min(1).max(32),
    },
    outputSchema: outputSchemas.collab_phase_advance,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cycle, expected_rev, next_phase }) => {
    try {
      const outcome = await advanceGuarded(context.db, {
        cycle_id: cycle,
        expected_revision: expected_rev,
        next_phase: next_phase as Phase,
      });
      return collabSuccess(outcome);
    } catch (error) {
      return collabFailure(error, 'Avance de phase impossible.');
    }
  });

  server.registerTool('collab_get_delta', {
    title: 'Delta de cycle (store CC-3)',
    description: 'Événements du cycle après un curseur de séquence, pour reprise incrémentale. Lecture seule.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      since_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    outputSchema: outputSchemas.collab_get_delta,
    annotations: READ_ONLY,
  }, async ({ cycle, since_seq, limit }) => {
    try {
      const { events, hasMore } = await context.store.getDelta(cycle, since_seq, limit);
      return collabSuccess({ events, has_more: hasMore, next_seq: events.length ? events[events.length - 1].seq : since_seq });
    } catch (error) {
      return collabFailure(error, 'Delta de cycle indisponible.');
    }
  });

  server.registerTool('collab_append_event', {
    title: 'Append d\'événement (store CC-3)',
    description: 'Écriture idempotente dans le journal du cycle. Voir le guide pour les types et codes d\'erreur.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      type: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      payload_json: z.string().min(2).max(100000),
      op_id: z.string().min(1).max(200),
      evidence_ref: z.string().max(512).optional(),
    },
    outputSchema: outputSchemas.collab_append_event,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      const identity = await context.identity();
      authorizeAppend(identity);
      const outcome: AppendOutcome = await context.store.appendEvent({
        cycle_id: args.cycle,
        type: args.type as StoreEventType,
        participant_id: identity.participant_id,
        expected_rev: args.expected_rev,
        payload_json: args.payload_json,
        op_id: args.op_id,
        evidence_ref: args.evidence_ref,
      });
      return collabSuccess(outcome);
    } catch (error) {
      return collabFailure(error, 'Append refusé.');
    }
  });

  server.registerTool('collab_export', {
    title: 'Export CC-STATE-1 / memory-md (store CC-3)',
    description: 'Instantané cohérent (lecture seule). Voir le guide.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      format: z.enum(['cc-state-1', 'memory-md']).default('cc-state-1'),
    },
    outputSchema: outputSchemas.collab_export,
    annotations: READ_ONLY,
  }, async ({ cycle, format }) => {
    try {
      if (format === 'memory-md') {
        const identity = await context.identity();
        const md = await exportMemoryMarkdown(context.db, cycle, identity.participant_id);
        return collabSuccess(md);
      }
      const state = await exportCycleState(context.db, cycle);
      return collabSuccess(state);
    } catch (error) {
      return collabFailure(error, 'Export impossible.');
    }
  });
}

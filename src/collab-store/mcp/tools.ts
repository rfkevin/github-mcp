/**
 * CC-3 C2 — les 3 outils collab_* du store (plan CC-PLAN-3/v1.1 §5) :
 * lecture de contexte minimal, reprise par curseur de séquence, append
 * idempotent. Résolution complète de contexte (mémoire, packets par rôle) : C3.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { outputSchemas } from './schemas';
import { collabFailure, collabSuccess } from './result';
import { CollabStoreError, type AppendOutcome } from '../store/collab-store';
import type { StoreEventType } from '../contracts';
import { authorizeAppend } from '../identity';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createCollabServer(context: CollabToolContext): McpServer {
  const server = new McpServer({ name: 'collab-store', version: '0.1.0' }, {
    instructions: 'Store dynamique CC-3 : journal append-only par cycle, CAS fail-closed par expected_rev. Le scope collab: est requis ; les scopes GitHub n\'ouvrent aucun outil ici. Append idempotent par op_id ({client}:{cycle}:{op}:{n}) ; duplicate = l\'événement original est renvoyé sans seconde écriture ; STALE = rejouez le delta puis réessayez à currentRevision.',
  });
  registerCollabStoreTools(server, context);
  return server;
}

export function registerCollabStoreTools(server: McpServer, context: CollabToolContext): void {
  server.registerTool('collab_get_context', {
    title: 'Contexte de cycle (store CC-3)',
    description: 'En-tête du cycle (phase, statut, révision) et tâches impliquant le participant (auteur, reviewer ou testeur ; par défaut le vôtre, dérivé du jeton). Renvoie aussi caller : votre participant_id et votre statut (registered/unregistered). Lecture seule. La résolution complète (mémoire, packets par rôle) arrive en C3.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      participant_id: z.string().min(1).max(128).optional(),
    },
    outputSchema: outputSchemas.collab_get_context,
    annotations: READ_ONLY,
  }, async ({ cycle, participant_id }) => {
    try {
      const identity = await context.identity();
      const value = await context.store.getContext(cycle, participant_id ?? identity.participant_id);
      return collabSuccess({ ...value, participant_id: participant_id ?? identity.participant_id,
        caller: { participant_id: identity.participant_id, status: identity.status } });
    } catch (error) {
      return collabFailure(error, 'Contexte de cycle indisponible.');
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
      return collabSuccess({ cycle_id: cycle, events, hasMore });
    } catch (error) {
      return collabFailure(error, 'Delta indisponible.');
    }
  });

  server.registerTool('collab_append_event', {
    title: 'Append d\'événement (store CC-3)',
    description: 'Ajout idempotent au journal du cycle. participant_id doit être le vôtre (voir caller dans collab_get_context) : sinon PARTICIPANT_MISMATCH ; client non enregistré : owner.request uniquement (UNREGISTERED_CLIENT). CAS fail-closed : fournissez expected_rev (0 = création de cycle). Un op_id rejoué renvoie l\'événement original (status duplicate) sans seconde écriture. Un expected_rev périmé renvoie l\'erreur typée STALE avec currentRevision et le delta à rejouer. Quota quotidien épuisé : QUOTA_EXHAUSTED, aucune écriture.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      op_id: z.string().min(1).max(256),
      type: z.string().min(1).max(64),
      participant_id: z.string().min(1).max(128),
      payload_json: z.string().min(1).max(65536),
      session_id: z.string().min(1).max(128).optional(),
      role: z.string().min(1).max(64).optional(),
      evidence_ref: z.string().min(1).max(1024).optional(),
    },
    outputSchema: outputSchemas.collab_append_event,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    let outcome: AppendOutcome;
    try {
      // CC-3 C5 : participant_id doit être celui dérivé du jeton ; client non enregistré = owner.request seulement.
      const participantId = authorizeAppend(await context.identity(), input.participant_id, input.type);
      outcome = await context.store.appendEvent({
        cycle_id: input.cycle,
        type: input.type as StoreEventType,
        participant_id: participantId,
        expected_rev: input.expected_rev,
        payload_json: input.payload_json,
        op_id: input.op_id,
        session_id: input.session_id,
        role: input.role,
        evidence_ref: input.evidence_ref,
      });
    } catch (error) {
      return collabFailure(error, 'Ajout impossible.');
    }
    if (outcome.status === 'applied') {
      return collabSuccess({ status: 'applied', revision: outcome.revision, event: outcome.event });
    }
    if (outcome.status === 'duplicate') {
      return collabSuccess({ status: 'duplicate', event: outcome.event });
    }
    if (outcome.status === 'stale') {
      return collabFailure(
        new CollabStoreError('STALE', 'Conflit de révision : rejouez le delta puis réessayez à currentRevision.'),
        'Conflit de révision.',
        { currentRevision: outcome.currentRevision, delta: outcome.delta },
      );
    }
    return collabFailure(
      new CollabStoreError('QUOTA_EXHAUSTED', 'Quota quotidien épuisé (jour ' + outcome.day + ', limite ' + outcome.limit + ').'),
      'Quota épuisé.',
    );
  });
}

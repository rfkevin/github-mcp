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

  server.registerTool('collab_export', {
    title: 'Instantané GitHub (store CC-3)',
    description: 'Lecture seule. format cc-state-1 : l\'état CC-STATE-1 du cycle = dernier état importé par le propriétaire (/owner) + ce que le store a enregistré depuis (tâches, phase, décisions owner authentifiées, preuves evidence.add). Sans changement : identique à l\'état importé ; avec changements : proposition de révision N+1 sur la base N, validée par le parser L1. Ne contient ni proposition ni contenu scellé. format memory-md : mémoire active des scopes partagés + votre scope participant uniquement. N\'écrit jamais dans GitHub : pour publier, committez content sur une branche (outils GitHub) et ouvrez une PR ; fusion = Kevin, puis import sur /owner. NO_STATE_SNAPSHOT si aucun état n\'a été importé.',
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
        const memory = await exportMemoryMarkdown(context.db, identity.status === 'registered' ? identity.participant_id : null);
        return collabSuccess({ cycle_id: cycle, format, content: memory.content, content_sha256: memory.content_sha256,
          memory: { entries: memory.entries, scopes: memory.scopes },
          publish: 'Lecture seule : aucun fichier GitHub n\'est écrit par cet outil.' });
      }
      const state = await exportCycleState(context.db, cycle);
      const target = state.imported.target;
      return collabSuccess({
        cycle_id: cycle, format, content: state.content, content_sha256: state.content_sha256,
        state: {
          revision: state.state_revision, base_revision: state.base_revision, changed: state.changed, changes: state.changes,
          imported: state.imported, store_revision: state.store_revision, last_seq: state.last_seq,
        },
        publish: state.changed
          ? 'Proposez content tel quel' + (target ? ' dans ' + target.repository + ':' + target.path + ' (base ' + target.ref + ')' : '')
            + ' via une branche et une PR (outils GitHub) ; fusion = Kevin, puis import de l\'état fusionné sur /owner.'
          : 'Aucun changement depuis l\'import : rien à publier.',
      });
    } catch (error) {
      return collabFailure(error, 'Export indisponible.');
    }
  });
}

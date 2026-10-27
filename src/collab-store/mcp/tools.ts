/**
 * CC-3 C2/C3/F5 — outils collab_* du store.
 * A09 : collab_get_context résout issue/cycle, identité serveur, packet rôle/tâche,
 * phase, mémoire C4 visible, contribution/delta optionnelle.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CollabToolContext } from './context';
import { outputSchemas } from './schemas';
import { collabFailure as failure, collabSuccess, toEventOutput } from './result';
import { CollabStoreError, type AppendOutcome } from '../store/collab-store';
import { MAX_OP_ID_LENGTH, type StoreEventType } from '../contracts';
import { authorizeAppend, authorizePhaseAdvance } from '../identity';
import { equivalentParticipantIds } from '../identity/families';
import { exportCycleState, exportMemoryMarkdown } from '../export';
import { resolveContextTarget, buildRolePacket, loadContinuity } from '../context';
import { advanceGuarded } from '../phases/gate';
import type { Phase } from '../../collab/contracts';
import { dispatchCoordinatorTask } from '../coordinator/tasks';
import { listExecutorProfiles } from '../executors/profiles';
import { isCoordinator } from '../owner/coordinators';
import { registerDelegationTools } from './delegation-tools';
import { registerControllerTools } from './controller-tools';
import { registerAgentRunTools } from './agentrun-tools';
import { registerSalonTools } from './salon-tools';
import { registerModelTools } from './model-tools';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Default C0 baseline for packet budget when the caller does not pass one. */
const DEFAULT_C0_BASELINE = 12_000;

export function createCollabServer(context: CollabToolContext): McpServer {
  const server = new McpServer({ name: 'collab-store', version: '0.1.0' }, {
    instructions: 'Store dynamique CC-3 : journal append-only par cycle, CAS fail-closed par expected_rev. Le scope collab: est requis ; les scopes GitHub n\'ouvrent aucun outil ici. Append idempotent par op_id strict {client}:{cycle}:{op}:{n} — quatre segments exactement, client = votre participant serveur avec « : » remplacés par « . » (ex. unregistered.<empreinte>), cycle = le cycle visé (INVALID_OP_ID) ; une seule proposition par participant et par ronde (PROPOSAL_ALREADY_SUBMITTED) ; sans issue ni cycle, collab_get_context découvre votre unique cycle ouvert (NO_ACTIVE_CYCLE, AMBIGUOUS_CYCLE) ; duplicate = l\'événement original est renvoyé sans seconde écriture ; STALE = rejouez le delta puis réessayez à currentRevision. collab_export produit l\'instantané CC-STATE-1 à proposer par PR (il n\'écrit jamais dans GitHub). STORE_UNAVAILABLE = repli en lecture seule via github_collab_context (champ fallback), aucune écriture de substitution dans GitHub. CC-5 L2 : clarify.ask pose une question ouverte (payload {question, subject?, task?, to?} — to optionnel adresse la question à un participant ou à un rôle de la tâche) et clarify.answer y répond ({ask_seq, answer}) ; les questions sans réponse alimentent packet.open_questions de collab_get_context — une question adressée n\'y apparaît qu\'à son auteur et à son destinataire, et seuls ceux-ci peuvent la fermer (CLARIFY_ANSWER_FORBIDDEN) ; un task fourni mais absent ou non tenu renvoie TASK_UNKNOWN ou TASK_NOT_HELD, jamais un packet sans tâche. Guide : docs/collaboration/cc3/collab-store-guide.md.',
  });
  registerCollabStoreTools(server, context);
  return server;
}

export function registerCollabStoreTools(server: McpServer, context: CollabToolContext): void {
  registerDelegationTools(server, context);
  registerControllerTools(server, context);
  registerAgentRunTools(server, context);
  // CC-7 L4 : outils salon absents du catalogue tant que la porte est éteinte.
  if (context.flags.salonEnabled) registerSalonTools(server, context);
  // CC-7 L9a : catalogue et choix de modèle absents tant que les exécutions API sont éteintes.
  if (context.flags.agentRunsEnabled) registerModelTools(server, context);
  const collabFailure = (error: unknown, fallback: string, extra: Record<string, unknown> = {}) =>
    failure(error, fallback, extra, context.fallback);

  server.registerTool('collab_dispatch_task', {
    title: 'Confier une tâche à un worker gratuit (CC-4 A4)',
    description: 'Coordinateur owner-approved uniquement. Crée une invocation A1 dans coordinator-tasks puis l’exécute immédiatement sur un endpoint actif gratuit. task_kind est une liste serveur fixe ; brief (<=2000) et materials (<=60000) sont bornés et non fiables. Même op_id = aucun second appel fournisseur et aucune restitution de la sortie précédente.',
    inputSchema: {
      endpoint_id: z.string().min(1).max(128),
      task_kind: z.string().min(1).max(64),
      brief: z.string().min(1).max(3000),
      materials: z.string().max(65536),
      max_tokens: z.number().int().min(1).max(2048),
      op_id: z.string().min(1).max(MAX_OP_ID_LENGTH),
    },
    outputSchema: outputSchemas.collab_dispatch_task,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const identity = await context.identity();
      const result = await dispatchCoordinatorTask(context.db, context.executor.factory, {
        participant_id: identity.participant_id,
        endpoint_id: input.endpoint_id,
        task_kind: input.task_kind,
        brief: input.brief,
        materials: input.materials,
        max_tokens: input.max_tokens,
        op_id: input.op_id,
        daily_cap: context.executor.dailyCap,
        neuron_budget: context.executor.neuronBudget,
        now: context.executor.now,
      });
      return collabSuccess({ ...result });
    } catch (error) {
      return collabFailure(error, 'Délégation au worker impossible.');
    }
  });

  server.registerTool('collab_list_executors', {
    title: 'Fiches des workers disponibles (CC-4 A4)',
    description: 'Lecture seule réservée au coordinateur owner-approved : endpoints, provider/modèle, capacités, quotas restants, statistiques A1 des 7 derniers jours et notes owner.',
    inputSchema: {},
    outputSchema: outputSchemas.collab_list_executors,
    annotations: READ_ONLY,
  }, async () => {
    try {
      const identity = await context.identity();
      if (!await isCoordinator(context.db, identity.participant_id)) {
        throw new CollabStoreError('COORDINATOR_REQUIRED', 'Le rôle coordinateur actif est requis pour lire les fiches exécutants.');
      }
      const executors = await listExecutorProfiles(context.db, {
        dailyCap: context.executor.dailyCap,
        neuronBudget: context.executor.neuronBudget,
        now: context.executor.now,
      });
      return collabSuccess({ executors });
    } catch (error) {
      return collabFailure(error, 'Fiches exécutants indisponibles.');
    }
  });

  server.registerTool('collab_get_context', {
    title: 'Contexte de cycle (store CC-3)',
    description: 'A09 : résout issue/cycle/task, identité serveur (jamais un participant_id client), packet rôle/tâche sous budget, phase, mémoire C4 visible (scopes partagés + votre participant), delta optionnel depuis last_seen_seq. CC-4 A0 : sans issue ni cycle, découverte de votre unique cycle ouvert où vous tenez un rôle (sinon NO_ACTIVE_CYCLE ou AMBIGUOUS_CYCLE). CC-5 L2 : packet.open_questions = les clarify.ask du cycle sans clarify.answer (format #<seq> (<participant>) <question>), budget 300 — une question adressée (to = participant ou rôle) n\'y apparaît qu\'à son auteur et à son destinataire ; un task fourni absent ou non tenu renvoie TASK_UNKNOWN ou TASK_NOT_HELD. Lecture seule.',
    inputSchema: {
      cycle: z.string().min(1).max(64).optional(),
      issue: z.string().min(1).max(128).optional(),
      repository: z.string().min(1).max(200).optional(),
      task: z.string().min(1).max(64).optional(),
      last_seen_seq: z.number().int().min(0).optional(),
      include_delta: z.boolean().optional(),
      delta_limit: z.number().int().min(1).max(200).optional(),
      c0_baseline_tokens: z.number().int().min(1).max(100_000).optional(),
      approved_budget_tokens: z.number().int().min(1).max(6000).optional(),
    },
    outputSchema: outputSchemas.collab_get_context,
    annotations: READ_ONLY,
  }, async (input) => {
    try {
      const identity = await context.identity();
      const participantId = identity.participant_id;
      const resolved = await resolveContextTarget(context.db, {
        cycle: input.cycle,
        issue: input.issue,
        repository: input.repository,
        task: input.task,
        participant_id: participantId,
      });
      const value = await context.store.getContext(resolved.cycle_id, participantId);
      const packet = await buildRolePacket(context.db, {
        cycle: resolved.cycle_id,
        task: input.task,
        participant_id: participantId,
      }, {
        c0BaselineTokens: input.c0_baseline_tokens ?? DEFAULT_C0_BASELINE,
        approvedBudgetTokens: input.approved_budget_tokens,
        lastSeenSeq: input.last_seen_seq ?? 0,
      });
      // CC-7 L3 : « depuis ta dernière visite » — exécutions API et notes de passation du participant
      // (identités équivalentes), jamais celles d'un autre ; client non enregistré : rien.
      const continuity = identity.status === 'registered'
        ? await loadContinuity(context.db, resolved.cycle_id, await equivalentParticipantIds(context.db, participantId))
        : null;
      let delta: Awaited<ReturnType<typeof context.store.getDelta>> | undefined;
      if (input.include_delta) {
        delta = await context.store.getDelta(
          resolved.cycle_id,
          input.last_seen_seq ?? 0,
          input.delta_limit ?? 50,
          // CR-C (GPT6-01) : rendu pour l'identité serveur ; non enregistré = anonyme.
          identity.status === 'registered' ? identity.participant_id : null,
        );
      }
      return collabSuccess({
        ...value,
        participant_id: participantId,
        caller: { participant_id: identity.participant_id, status: identity.status },
        resolved: { cycle_id: resolved.cycle_id, task: resolved.task },
        packet: {
          header: packet.header,
          role_card: packet.role_card,
          memory: packet.memory,
          open_questions: packet.open_questions,
          refs: packet.refs,
          excluded_memory_ids: packet.excluded_memory_ids,
          budget: packet.budget,
        },
        ...(continuity ? { since_last_visit: continuity } : {}),
        ...(delta ? { delta: { events: delta.events.map(toEventOutput), hasMore: delta.hasMore } } : {}),
      });
    } catch (error) {
      return collabFailure(error, 'Contexte de cycle indisponible.');
    }
  });

  server.registerTool('collab_phase_advance', {
    title: 'Avance de phase (store CC-3)',
    description: 'Avance policy avec transitions autorisées et conditions d\'entrée de la cible (A07). La policy est dérivée de auto_advance de la phase courante (jamais fournie par l\'agent). Réservé aux participants enregistrés qui tiennent un rôle sur une tâche du cycle (UNREGISTERED_CLIENT, PHASE_ADVANCE_FORBIDDEN, vérifiés avant tout effet). Rejeu de la même intention détecté avant STALE. Les définitions de phase sont installées par Kevin sur /owner. N\'est pas un canal owner.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      next_phase: z.string().min(1).max(32),
    },
    outputSchema: outputSchemas.collab_phase_advance,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cycle, expected_rev, next_phase }) => {
    try {
      // CR-A / CR-01 : garde d'identité C5 avant toute mutation, y compris un rejeu.
      await authorizePhaseAdvance(context.db, await context.identity(), cycle);
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
    description: 'Événements du cycle après un curseur de séquence, pour reprise incrémentale. Lecture seule. Les événements memory.* qui touchent le scope privé participant:<autre> sont rendus masqués (payload {"memory":{id,version},"redacted":"private_scope"}, session_id/role/evidence_ref vides) selon votre identité serveur ; seq et curseurs inchangés (CR-C).',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      since_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    outputSchema: outputSchemas.collab_get_delta,
    annotations: READ_ONLY,
  }, async ({ cycle, since_seq, limit }) => {
    try {
      // CR-C (GPT6-01) : mémoire privée d'autrui masquée selon l'identité serveur.
      const identity = await context.identity();
      const viewer = identity.status === 'registered' ? identity.participant_id : null;
      const { events, hasMore } = await context.store.getDelta(cycle, since_seq, limit, viewer);
      return collabSuccess({ cycle_id: cycle, events: events.map(toEventOutput), hasMore });
    } catch (error) {
      return collabFailure(error, 'Delta indisponible.');
    }
  });

  server.registerTool('collab_append_event', {
    title: 'Append d\'événement (store CC-3)',
    description: 'Ajout idempotent au journal du cycle. participant_id doit être le vôtre (voir caller dans collab_get_context) : sinon PARTICIPANT_MISMATCH ; client non enregistré : owner.request uniquement (UNREGISTERED_CLIENT). CAS fail-closed : fournissez expected_rev (0 = création de cycle). Un op_id rejoué renvoie l\'événement original (status duplicate) sans seconde écriture ; le même op_id avec une intention différente (type, auteur, contenu) donne IDEMPOTENCY_CONFLICT : incrémentez le compteur n. Le segment cycle de l\'op_id doit viser ce cycle ; CC-4 A0 : op_id strict {client}:{cycle}:{op}:{n}, quatre segments exactement — client = votre participant serveur avec « : » remplacés par « . » (ex. agent:a → agent.a, unregistered:<empreinte> → unregistered.<empreinte>), pour tous les participants, cycle = le cycle visé (INVALID_OP_ID). Un second proposal.submit du même participant dans la même ronde est refusé (PROPOSAL_ALREADY_SUBMITTED). task.claim, task.status et task.handoff sont limités aux rôles de la tâche (owner courant pour claim/handoff, owner/reviewer/testeur pour status : TASK_FORBIDDEN) et aux participants enregistrés actifs (UNREGISTERED_PARTICIPANT). memory.propose, memory.review, memory.consolidate et memory.retire (lifecycle C4, CR-02) appliquent leurs effets memory_entries dans la MÊME transaction que l\'append : l\'auteur est votre participant serveur, memory.review exige un reviewer distinct de l\'auteur (MEMORY_SELF_ACTIVATION), memory.consolidate exige evidence_refs, les kinds protégés exigent owner_decision_ref lié au sujet exact (PROTECTED_KIND_OWNER_REQUIRED) ; scopes participant:<autre> privés : propose, consolidate et retire uniquement par le propriétaire du scope (MEMORY_SCOPE_FORBIDDEN) ; payload {\"memory\":{\"...\"}} sinon INVALID_MEMORY_PAYLOAD, un applied renvoie l\'effet dans le champ memory, un refus n\'écrit rien du tout (ni journal, ni mémoire). Un expected_rev périmé renvoie l\'erreur typée STALE avec currentRevision et le delta à rejouer. Quota quotidien épuisé : QUOTA_EXHAUSTED, aucune écriture. Cycle fermé par le propriétaire : CYCLE_CLOSED, aucune écriture des agents ; les lectures restent disponibles. CC-5 L2 : clarify.ask attend {\"question\", \"subject\"?, \"task\"?, \"to\"?} — to optionnel adresse la question à un participant ou à un rôle (owner/reviewer/tester ; un rôle exige task : CLARIFY_TO_REQUIRES_TASK sans task, TASK_UNKNOWN si la tâche est inconnue, CLARIFY_TO_INVALID si to est mal formé ; sans to, la question est publique) ; clarify.answer attend {\"ask_seq\", \"answer\"} où ask_seq est le seq du clarify.ask visé — une question adressée ne se ferme que par son auteur ou son destinataire (CLARIFY_ANSWER_FORBIDDEN sinon, rien n\'est écrit) ; une réponse orpheline (ask_seq inconnu) reste acceptée et ne ferme rien. Mode d\'emploi : proposal.submit dépose une seule proposition scellée par participant et par ronde — seuls sealed_id et content_hash sont visibles avant la révélation, le contenu n\'est jamais publié avant la fin de la ronde ; evidence.add consigne un bilan au couple SHA exact — payload {\"task\", \"source\", \"state\", \"review\"} avec le head et la base réellement testés.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      expected_rev: z.number().int().min(0),
      op_id: z.string().min(1).max(MAX_OP_ID_LENGTH),
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
      return collabSuccess({
        status: 'applied',
        revision: outcome.revision,
        event: toEventOutput(outcome.event),
        // CR-B (CR-02) : effet memory_entries d'un événement memory.* applied.
        ...(outcome.memory ? { memory: outcome.memory } : {}),
      });
    }
    if (outcome.status === 'duplicate') {
      return collabSuccess({ status: 'duplicate', event: toEventOutput(outcome.event) });
    }
    if (outcome.status === 'stale') {
      // CC-4 A0 (point 2) : le message porte la valeur — la révision ne doit
      // plus être déduite du delta (constat P1 : deux STALE réels).
      return collabFailure(
        new CollabStoreError(
          'STALE',
          'Conflit de révision : currentRevision = ' + outcome.currentRevision + ' (expected_rev ' + input.expected_rev + ' fourni). Rejouez le delta puis réessayez à cette révision.',
        ),
        'Conflit de révision.',
        { currentRevision: outcome.currentRevision, delta: outcome.delta.map(toEventOutput) },
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
          snapshot_seq: state.snapshot_seq,
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

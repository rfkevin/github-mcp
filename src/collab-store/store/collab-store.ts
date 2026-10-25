/**
 * CC-3 C2 — CollabStore: D1 adapter over the canonical C1 schema
 * (src/collab-store/schema/0001_init.sql). The append-only event log is the
 * source of truth; cycles.revision counts applied events (F3: stored rows
 * start at 1, expected_rev 0 = creation).
 *
 * CAS is fail-closed: one D1 batch (a single SQL transaction). The first
 * statement inserts a guard row whose CHECK fails — and therefore rolls back
 * the whole batch — unless (1) the idempotency key is new, (2) the cycle is
 * exactly at expected_rev and (3) the daily quota is open. Never
 * last-write-wins: a stale writer changes nothing.
 */
import { opIdClientFor, opIdToIdempotencyKey, parseOpId, validateAgentEvent, validateTaskAssignment, type StoreEvent, type StoreEventType } from '../contracts';
import { phaseEntrySeq } from '../phases/entry-seq';
import { createSealedEnvelope, parseSealedEnvelope } from '../phases/sealed-envelope';
import { ensureSchema } from './schema';
import { sha256Hex } from './hash';
import { DEFAULT_DAILY_WRITE_LIMIT } from './config';
import { isMemoryEventType, prepareMemoryEvent } from '../memory/journal-lifecycle';
import { redactEventsFor } from './visibility';
import { revealProposalPayloads } from './sealed-reveal';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { prepareDelegationApproval } from './delegation-approval';
import { describeInvocation, type InvocationDescriptor, type InvocationIntent, type InvocationRecord } from '../invocations/contracts';
import { invocationByWakeKey, invocationInsertStatement } from '../invocations/repository';
import {
  assertDistinctLogicalParticipants, equivalentParticipantIds, logicalIdentityOf, participantsEquivalent,
} from '../identity/families';

export class CollabStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CollabStoreError';
  }
}

export const TASK_STATUSES = ['proposed', 'accepted', 'in_progress', 'review', 'verified', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface AppendEventInput {
  cycle_id: string;
  type: StoreEventType;
  participant_id: string;
  /** Expected revision. 0 = row creation (F3: stored rows start at 1). */
  expected_rev: number;
  payload_json: string;
  /** op_id policy (C1): {client}:{cycle}:{op}:{n}. */
  op_id: string;
  session_id?: string;
  role?: string;
  evidence_ref?: string;
}

export interface StoredStoreEvent {
  seq: number;
  cycle_id: string;
  at: number;
  type: string;
  participant_id: string;
  session_id: string;
  role: string;
  payload_json: string;
  expected_rev: number;
  idempotency_key: string;
  evidence_ref: string;
}

/**
 * Public columns of an event row: exactly the fields of StoredStoreEvent.
 * Store reads list them explicitly instead of SELECT *: an internal column
 * added by a store migration (model_meta, 0002) must never reach a caller,
 * since strict MCP clients reject any property absent from the published
 * output schema (additionalProperties: false).
 */
export const STORED_EVENT_COLUMNS = [
  'seq', 'cycle_id', 'at', 'type', 'participant_id', 'session_id', 'role',
  'payload_json', 'expected_rev', 'idempotency_key', 'evidence_ref',
] as const satisfies ReadonlyArray<keyof StoredStoreEvent>;
const EVENT_SELECT = 'SELECT ' + STORED_EVENT_COLUMNS.join(', ') + ' FROM events';

export type AppendOutcome =
  | { status: 'applied'; revision: number; event: StoredStoreEvent; memory?: { id: string; version: number; status: string }; invocation?: InvocationRecord }
  | { status: 'duplicate'; event: StoredStoreEvent; invocation?: InvocationRecord }
  | { status: 'stale'; currentRevision: number; delta: StoredStoreEvent[] }
  | { status: 'quota_exhausted'; day: string; limit: number };

export interface StoreContextTask {
  task_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  status: string;
  owned_paths: string;
  next_action: string;
  revision: number;
}

export interface StoreOptions {
  dailyWriteLimit?: number;
  now?: () => Date;
}

export class CollabStore {
  private readonly now: () => Date;
  private readonly dailyWriteLimit: number;

  constructor(private readonly db: D1Database, options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.dailyWriteLimit = options.dailyWriteLimit ?? DEFAULT_DAILY_WRITE_LIMIT;
  }

  async currentRevision(cycleId: string): Promise<number> {
    await ensureSchema(this.db);
    const row = await this.db.prepare(
      'SELECT COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?1), 0) AS revision'
    ).bind(cycleId).first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  async appendEvent(input: AppendEventInput): Promise<AppendOutcome> {
    return this.appendEventInternal(input);
  }

  /** A1 internal path: event + durable outbox intent share the same CAS batch. */
  async appendActionableEvent(input: AppendEventInput, invocation: InvocationIntent): Promise<AppendOutcome> {
    return this.appendEventInternal(input, invocation);
  }

  private async appendEventInternal(input: AppendEventInput, invocationIntent?: InvocationIntent): Promise<AppendOutcome> {
    // CC-4 A0 (point 1) : grammaire stricte appliquée par opIdToIdempotencyKey
    // (StateContractError INVALID_OP_ID) — les ids réels relâchés comme
    // « op:op:vibe:cc4-design:p2-review:1 » (seq 103/104) sont refusés ici.
    const key = opIdToIdempotencyKey(input.op_id);
    const event: StoreEvent = {
      cycle_id: input.cycle_id,
      type: input.type,
      participant_id: input.participant_id,
      session_id: input.session_id ?? '',
      role: input.role ?? '',
      expected_rev: input.expected_rev,
      payload_json: input.payload_json,
      idempotency_key: key,
      evidence_ref: input.evidence_ref ?? '',
    };
    validateAgentEvent(event);
    await ensureSchema(this.db);
    // A05 (F1): fingerprint the incoming intent BEFORE P1 sealing rewrites
    // the payload, so a replay compares the raw intent to the stored one.
    const intentFingerprint = await this.intentFingerprint(event);
    const invocation = invocationIntent ? await describeInvocation(invocationIntent, intentFingerprint) : null;

    // A05 (F1, review Claude): judge an existing key BEFORE the P1 sealing
    // and the task permission statements. Otherwise a lost-response replay
    // of task.handoff or of a task.claim reassignment would be judged on the
    // state its own first write produced (TASK_FORBIDDEN) instead of
    // returning duplicate with the original event.
    const replayed = await this.replayOutcome(key, intentFingerprint);
    if (replayed) {
      if (!invocation) return replayed;
      const wakeReplay = await this.invocationReplayOutcome(invocation);
      if (!wakeReplay) throw new CollabStoreError('INVOCATION_INCONSISTENT', 'Événement rejoué sans invocation durable associée.');
      return wakeReplay;
    }
    if (invocation) {
      const wakeReplay = await this.invocationReplayOutcome(invocation);
      if (wakeReplay) return wakeReplay;
      if (invocation.source_revision !== event.expected_rev + 1) {
        throw new CollabStoreError('INVALID_INVOCATION', 'source_revision doit être la révision créée par l’événement actionnable.');
      }
    }

    // CC-4 A0 (point 1) : égalités du contrat op_id, jugées APRÈS le rejeu
    // (une réponse perdue rejouée reste duplicate). Le segment cycle vise
    // TOUJOURS ce cycle ; le segment client est la forme canonique du
    // participant serveur pour TOUS les participants (review GPT-6 R1 :
    // ':' → '.', ex. « unregistered.<hash> », « agent.a ») — aucune identité
    // ne peut réserver le namespace d'idempotence d'une autre.
    const parsedOpId = parseOpId(input.op_id);
    if (parsedOpId.cycle !== event.cycle_id) {
      throw new CollabStoreError(
        'INVALID_OP_ID',
        'op_id doit porter le segment cycle de la requête ({client}:{cycle}:{op}:{n}) : attendu « ' + event.cycle_id + ' », reçu « ' + parsedOpId.cycle + ' »',
      );
    }
    const expectedClient = opIdClientFor(event.participant_id);
    if (parsedOpId.client !== expectedClient) {
      throw new CollabStoreError(
        'INVALID_OP_ID',
        'op_id doit porter le segment client du participant serveur ({client}:{cycle}:{op}:{n}, « : » de l’id remplacés par « . ») : attendu « ' + expectedClient + ' », reçu « ' + parsedOpId.client + ' »',
      );
    }

    // CC-5 L2 (X13, review Claude R2) : adressage des questions ouvertes.
    // Pré-checks lecture seule avant le batch, fail-closed : un refus ne
    // consomme ni révision ni quota et n'écrit rien du tout.
    if (event.type === 'clarify.ask') {
      await this.validateClarifyAsk(event);
    } else if (event.type === 'clarify.answer') {
      await this.validateClarifyAnswer(event);
    }

    let sealedInsert: D1PreparedStatement | null = null;
    let proposalRound: { phase: string; entrySeq: number; logicalIdentity: string } | null = null;
    if (event.type === 'proposal.submit') {
      const cycle = await this.db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1')
        .bind(event.cycle_id).first<{ phase: string }>();
      const phase = cycle?.phase ?? (event.expected_rev === 0 ? 'P1' : '');
      // CC-4 A0 (point 5) : une seule sortie requise par participant et par
      // phase — le 2e proposal.submit du même participant dans la MÊME ronde
      // (depuis la dernière (re)entrée dans cette phase, CR-F01) est refusé,
      // réponse perdue ou pas (cas réel GPT-6, seq 95/96 du cycle cc4-design).
      const entrySeq = await phaseEntrySeq(this.db, event.cycle_id, phase);
      const logicalIdentity = await logicalIdentityOf(this.db, event.participant_id);
      proposalRound = { phase, entrySeq, logicalIdentity };
      if (await this.currentRoundProposal(event.cycle_id, logicalIdentity, entrySeq)) {
        throw new CollabStoreError(
          'PROPOSAL_ALREADY_SUBMITTED',
          'Une seule proposition par participant et par ronde : ' + event.participant_id + ' a déjà soumis une proposition en ' + phase + ' (ronde courante).',
        );
      }
      if (phase === 'P1') {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        } catch {
          throw new CollabStoreError('INVALID_PROPOSAL_PAYLOAD', 'proposal.submit payload_json must be an object.');
        }
        if (typeof payload.content !== 'string' || !payload.content) {
          throw new CollabStoreError('INVALID_PROPOSAL_PAYLOAD', 'proposal.submit requires payload_json.content in P1.');
        }
        // A01 (F1): hash the full key + cycle instead of truncating the
        // key: long op_ids sharing a 48-char prefix collided on sealed ids.
        const sealedId = 'sealed-' + (await sha256Hex(key + '|' + event.cycle_id));
        const envelope = await createSealedEnvelope(payload.content);
        // CC-7 L0 : l'identifiant de tâche (jamais secret) reste public à côté du scellé, pour que le contrôleur
        // sache quelle tâche a reçu sa proposition (sinon réveil « no-submission » périmé). Seul `content` est scellé.
        const sealedTask = typeof payload.task === 'string' && TASK_ID_RE.test(payload.task) ? payload.task : null;
        event.payload_json = JSON.stringify({ sealed_id: sealedId, content_hash: envelope.content_hash,
          ...(sealedTask ? { task: sealedTask } : {}) });
        sealedInsert = this.db.prepare([
          'INSERT INTO sealed_items (id, cycle_id, phase, participant_id, content_hash, content, revealed_at)',
          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)',
        ].join(' ')).bind(
          sealedId,
          event.cycle_id,
          phase,
          event.participant_id,
          envelope.content_hash,
          envelope.serialized,
        );
      }
    }

    const now = this.now();
    const at = Math.floor(now.getTime() / 1000);
    const day = now.toISOString().slice(0, 10);
    const nextRevision = event.expected_rev + 1;
    const taskStatements = await this.taskStatements(event, nextRevision);
    const invocationStatement = invocation ? invocationInsertStatement(this.db, invocation, key, at) : null;
    // CR-B (CR-02) : un événement memory.* porte ses effets memory_entries
    // dans le MÊME batch CAS que l'append du journal — un applied garantit
    // l'effet mémoire (champ memory), un refus n'écrit rien du tout (ni
    // journal, ni mémoire). Les pre-checks typés sont read-only : les rejeter
    // ici reste fail-closed, et les rejouer re-diagnostique un échec.
    const delegationApprovalStatements = event.type === 'delegation.approve'
      ? await prepareDelegationApproval(this.db, event) : [];
    const memoryEffect = isMemoryEventType(event.type)
      ? await prepareMemoryEvent(this.db, event, nextRevision)
      : null;
    // CC-4 A0 (point 5) : pour proposal.submit, la garde CAS vérifie AUSSI
    // en transaction qu'aucune proposition du participant n'existe dans la
    // ronde courante — le pré-check ci-dessus est read-only, deux appels
    // concurrents peuvent le passer ; seul le batch tranche (fail-closed).
    const proposalClause = proposalRound
      ? [
        "             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.cycle_id = ?6 AND e.type = 'proposal.submit'",
        "                              AND COALESCE((SELECT family_id FROM participant_identity_families f WHERE f.participant_id = e.participant_id), e.participant_id) = ?7",
        '                              AND e.seq > ?8)',
      ]
      : [];
    const guardParams: Array<string | number> = [
      key, event.cycle_id, event.expected_rev, day, this.dailyWriteLimit,
      ...(proposalRound ? [event.cycle_id, proposalRound.logicalIdentity, proposalRound.entrySeq] : []),
    ];
    const journal: D1PreparedStatement[] = [
      // Transactional CAS guard: the whole batch rolls back unless the key is
      // new AND the cycle is exactly at expected_rev AND the quota is open
      // AND the cycle is open (CC-Owner V2 L1: a closed cycle refuses every
      // agent write — COALESCE keeps cycle creation, the cycles row is born
      // below in the same batch with its default open status)
      // AND (proposal.submit) no proposal from this participant in this round.
      this.db.prepare([
        'INSERT INTO collab_store_guard (ok)',
        'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?1)',
        '             AND COALESCE((SELECT revision FROM cycles WHERE cycle_id = ?2), 0) = ?3',
        '             AND COALESCE((SELECT writes FROM quota_counters WHERE day = ?4), 0) < ?5',
        '             AND COALESCE((SELECT status FROM cycles WHERE cycle_id = ?2), \'open\') = \'open\'',
        ...proposalClause,
        '       THEN 1 ELSE 0 END',
      ].join(' ')).bind(...guardParams),
      this.db.prepare(
        'INSERT INTO quota_counters (day, writes) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET writes = writes + 1'
      ).bind(day),
      this.db.prepare(
        'INSERT INTO cycles (cycle_id) VALUES (?1) ON CONFLICT(cycle_id) DO NOTHING'
      ).bind(event.cycle_id),
      ...(sealedInsert ? [sealedInsert] : []),
      this.db.prepare([
        'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json,',
        '                   expected_rev, idempotency_key, evidence_ref)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
      ].join(' ')).bind(event.cycle_id, at, event.type, event.participant_id, event.session_id,
        event.role, event.payload_json, event.expected_rev, key, event.evidence_ref),
      ...(invocationStatement ? [invocationStatement] : []),
      this.db.prepare(
        'UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3'
      ).bind(event.cycle_id, nextRevision, event.expected_rev),
      ...taskStatements,
    ];
    // CR-B (CR-02) : les statements mémoire rejoignent le MÊME batch, avant le
    // nettoyage du garde ; l'index de vérification est décalé d'autant.
    const memoryVerifyIndex = memoryEffect ? journal.length + memoryEffect.verifyIndex : -1;
    const statements: D1PreparedStatement[] = [
      ...journal,
      ...(memoryEffect ? memoryEffect.statements : []),
      ...delegationApprovalStatements,
      // CR-F04 (#96) : les hypothèses de CE cycle que la nouvelle révision
      // rend échues passent retired dans la même transaction (après l'effet
      // mémoire : l'index de vérification ci-dessus est inchangé).
      expireDueHypotheses(this.db, event.cycle_id),
      this.db.prepare('DELETE FROM collab_store_guard'),
    ];
    let results: Array<{ meta?: { changes?: number } }>;
    try {
      results = (await this.db.batch(statements)) as unknown as Array<{ meta?: { changes?: number } }>;
    } catch (error) {
      // Fail-closed: diagnose from the durable state, never guess. F1: a
      // duplicate idempotency key wins over STALE.
      const replay = await this.replayOutcome(key, intentFingerprint);
      if (replay) {
        if (!invocation) return replay;
        const wakeReplay = await this.invocationReplayOutcome(invocation);
        if (!wakeReplay) throw new CollabStoreError('INVOCATION_INCONSISTENT', 'Événement rejoué sans invocation durable associée.');
        return wakeReplay;
      }
      if (invocation) {
        const wakeReplay = await this.invocationReplayOutcome(invocation);
        if (wakeReplay) return wakeReplay;
      }
      const quota = await this.db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
        .bind(day).first<{ writes: number }>();
      if ((quota?.writes ?? 0) >= this.dailyWriteLimit) {
        return { status: 'quota_exhausted', day, limit: this.dailyWriteLimit };
      }
      const currentRevision = await this.currentRevision(event.cycle_id);
      if (currentRevision !== event.expected_rev) {
        // CR-C (GPT6-01) : le delta d'erreur est rendu pour l'appelant (identité
        // serveur, déjà autorisée) : aucune mémoire privée d'autrui.
        const delta = await this.deltaSinceRevision(event.cycle_id, event.expected_rev);
        return { status: 'stale', currentRevision, delta: await redactEventsFor(this.db, event.participant_id, delta) };
      }
      // CC-Owner V2 (L1) : le batch a pu ruer en arrière parce que le cycle
      // est fermé. Re-diagnostic depuis l'état durable, APRÈS le rejeu (un
      // op_id d'avant la clôture reste duplicate) et APRÈS STALE (une écriture
      // en vol absorbe d'abord le conflit de révision ; au nouvel essai à la
      // révision courante, la garde renvoie CYCLE_CLOSED).
      const cycleStatus = await this.db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1')
        .bind(event.cycle_id).first<{ status: string }>();
      if ((cycleStatus?.status ?? 'open') === 'closed') {
        throw new CollabStoreError(
          'CYCLE_CLOSED',
          'Cycle « ' + event.cycle_id + ' » fermé par le propriétaire : les écritures des agents sont refusées ; les lectures (contexte, delta, export) restent disponibles.',
        );
      }
      // CC-4 A0 (point 5) : un proposal.submit concurrent a pu gagner la ronde
      // entre le pré-check read-only et le batch — re-diagnostiquer depuis
      // l'état durable avant toute autre cause.
      if (event.type === 'proposal.submit') {
        const cycle = await this.db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1')
          .bind(event.cycle_id).first<{ phase: string }>();
        const phase = cycle?.phase ?? (event.expected_rev === 0 ? 'P1' : '');
        if (await this.currentRoundProposal(event.cycle_id, await logicalIdentityOf(this.db, event.participant_id), await phaseEntrySeq(this.db, event.cycle_id, phase))) {
          throw new CollabStoreError(
            'PROPOSAL_ALREADY_SUBMITTED',
            'Une seule proposition par participant et par ronde : ' + event.participant_id + ' a déjà soumis une proposition en ' + phase + ' (ronde courante).',
          );
        }
      }
      // CR-B (CR-02) : le batch a roulé en arrière au complet (garde CAS ou
      // garde d'effet mémoire) ; re-préparer le lifecycle sur l'état durable
      // donne la cause typée (ex. une candidature devenue non candidate),
      // sinon l'erreur d'origine est relancée telle quelle.
      if (event.type === 'task.claim' || event.type === 'task.handoff') {
        // #126 : une famille a pu être activée entre le pré-check et le batch.
        // Re-préparer donne alors DUPLICATE_LOGICAL_IDENTITY au lieu d'une erreur SQL opaque.
        await this.taskStatements(event, nextRevision);
      }
      if (isMemoryEventType(event.type)) {
        await prepareMemoryEvent(this.db, event, nextRevision);
      }
      throw error;
    }
    if (memoryEffect) {
      // Défensif : les gardes transactionnelles du lifecycle garantissent
      // l'effet dans le batch ; un changes nul trahit un défaut imprévu.
      const changes = results[memoryVerifyIndex]?.meta?.changes;
      if (changes === 0) {
        throw new CollabStoreError('ACTIVATION_RACE', 'Effet mémoire non appliqué dans le batch (changement concurrent).');
      }
      await memoryEffect.postCommit?.();
    }
    const stored = await this.eventByKey(key);
    const storedInvocation = invocation ? await invocationByWakeKey(this.db, invocation.wake_key) : null;
    if (invocation && !storedInvocation) {
      throw new CollabStoreError('INVOCATION_INCONSISTENT', 'Événement actionnable appliqué sans invocation durable.');
    }
    return {
      status: 'applied',
      revision: nextRevision,
      event: stored!,
      ...(memoryEffect ? { memory: memoryEffect.summary } : {}),
      ...(storedInvocation ? { invocation: storedInvocation } : {}),
    };
  }

  // CC-5 L2 (X13, review Claude R2) : clarify.ask — `to` optionnel adresse la
  // question à un participant ou à un rôle (owner/reviewer/tester) ; un rôle
  // exige `task` et la tâche doit exister dans le cycle. Sans `to` (ou payload
  // illisible), la question est publique — comportement inchangé.
  private async validateClarifyAsk(event: StoreEvent): Promise<void> {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      return;
    }
    const to = payload?.to;
    if (to === undefined || to === null) return;
    if (typeof to !== 'string' || !to || to.length > 128) {
      throw new CollabStoreError(
        'CLARIFY_TO_INVALID',
        'clarify.ask : « to » doit être un participant (« claude ») ou un rôle (« owner », « reviewer », « tester ») — chaîne de 1 à 128 caractères.',
      );
    }
    if (to === 'owner' || to === 'reviewer' || to === 'tester') {
      const task = payload?.task;
      if (typeof task !== 'string' || !task) {
        throw new CollabStoreError(
          'CLARIFY_TO_REQUIRES_TASK',
          'clarify.ask : un adressage par rôle (« ' + to + ' ») exige « task » — la question est adressée au titulaire du rôle sur cette tâche.',
        );
      }
      const row = await this.db.prepare('SELECT task_id FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
        .bind(event.cycle_id, task).first();
      if (!row) {
        throw new CollabStoreError(
          'TASK_UNKNOWN',
          'clarify.ask : tâche « ' + task + ' » inconnue dans le cycle « ' + event.cycle_id + ' » (adressage par rôle « ' + to + ' »).',
        );
      }
    }
  }

  // CC-5 L2 (X13, review Claude R2) : seul l'auteur d'une question adressée ou
  // son destinataire (identité logique comprise) peut déposer le
  // clarify.answer qui la ferme. Une réponse orpheline (ask_seq inconnu ou
  // illisible) reste acceptée et ne ferme rien ; une question publique reste
  // fermable par tous — comportements inchangés.
  private async validateClarifyAnswer(event: StoreEvent): Promise<void> {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      return;
    }
    const askSeq = payload?.ask_seq;
    if (typeof askSeq !== 'number' || !Number.isInteger(askSeq)) return;
    const ask = await this.db.prepare(
      EVENT_SELECT + " WHERE cycle_id = ?1 AND seq = ?2 AND type = 'clarify.ask' LIMIT 1",
    ).bind(event.cycle_id, askSeq).first<StoredStoreEvent>();
    if (!ask) return; // orpheline : acceptée, ne ferme rien
    const equivalents = new Set(await equivalentParticipantIds(this.db, event.participant_id));
    if (equivalents.has(ask.participant_id)) return; // l'auteur (ou sa famille logique)
    let askPayload: Record<string, unknown> | null = null;
    try {
      askPayload = JSON.parse(ask.payload_json) as Record<string, unknown>;
    } catch {
      return; // question illisible : publique
    }
    const to = askPayload?.to;
    if (typeof to !== 'string' || !to) return; // sans adressage : tous
    let addressee: string | null = null;
    if (to === 'owner' || to === 'reviewer' || to === 'tester') {
      const task = askPayload?.task;
      if (typeof task === 'string' && task) {
        const row = await this.db.prepare('SELECT owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
          .bind(event.cycle_id, task).first<{ owner_pid: string; reviewer_pid: string; tester_pid: string }>();
        if (row) addressee = to === 'owner' ? row.owner_pid : to === 'reviewer' ? row.reviewer_pid : row.tester_pid;
      }
    } else {
      addressee = to;
    }
    if (addressee && equivalents.has(addressee)) return; // le destinataire (ou sa famille)
    throw new CollabStoreError(
      'CLARIFY_ANSWER_FORBIDDEN',
      'La question #' + askSeq + ' de « ' + ask.participant_id + ' » est adressée' +
        (addressee ? ' à « ' + addressee + ' »' : ' à un rôle sans tâche résolvable') +
        ' : seul le destinataire ou l’auteur peut la fermer (clarify.answer).',
    );
  }

  /**
   * Events after `sinceSeq`, rendered for `viewer` (CR-C, GPT6-01): the server
   * identity of a registered reader, or null for an unregistered client or an
   * internal reader without identity (most restrictive). memory.* events on
   * another participant's private scope come back redacted; seq and cursors
   * are unchanged.
   */
  async getDelta(cycleId: string, sinceSeq: number, limit = 200, viewer: string | null = null): Promise<{ events: StoredStoreEvent[]; hasMore: boolean }> {
    await ensureSchema(this.db);
    const { results } = await this.db.prepare(
      EVENT_SELECT + ' WHERE cycle_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3'
    ).bind(cycleId, sinceSeq, limit + 1).all<StoredStoreEvent>();
    const revealed = await revealProposalPayloads(this.db, cycleId, results.slice(0, limit));
    const events = await redactEventsFor(this.db, viewer, revealed);
    return { events, hasMore: results.length > limit };
  }

  async getContext(cycleId: string, participantId?: string): Promise<{
    cycle_id: string;
    phase: string;
    status: string;
    revision: number;
    tasks: StoreContextTask[];
  }> {
    await ensureSchema(this.db);
    const cycle = await this.db.prepare(
      'SELECT cycle_id, phase, status, revision FROM cycles WHERE cycle_id = ?1'
    ).bind(cycleId).first<{ cycle_id: string; phase: string; status: string; revision: number }>();
    if (!cycle) {
      throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);
    }
    const equivalents = participantId ? await equivalentParticipantIds(this.db, participantId) : [];
    const placeholders = equivalents.map((_, index) => '?' + (index + 2)).join(',');
    const sql = [
      'SELECT task_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, next_action, revision ',
      'FROM tasks WHERE cycle_id = ?1',
      equivalents.length ? ' AND (owner_pid IN (' + placeholders + ') OR reviewer_pid IN (' + placeholders + ') OR tester_pid IN (' + placeholders + '))' : '',
      ' ORDER BY task_id',
    ].join('');
    const query = equivalents.length
      ? this.db.prepare(sql).bind(cycleId, ...equivalents)
      : this.db.prepare(sql).bind(cycleId);
    const { results } = await query.all<StoreContextTask>();
    return { cycle_id: cycle.cycle_id, phase: cycle.phase, status: cycle.status, revision: cycle.revision, tasks: results };
  }

  /** Events applied after revision `sinceRevision` (revision k = k-th event by seq). */
  private async deltaSinceRevision(cycleId: string, sinceRevision: number): Promise<StoredStoreEvent[]> {
    // Events applied after revision R = events excluding the first R by seq:
    // the anchor is the R-th event (OFFSET R - 1); R = 0 means the whole journal.
    const { results } = await this.db.prepare([
      EVENT_SELECT + ' WHERE cycle_id = ?1 AND (',
      '  ?2 = 0 OR seq > COALESCE(',
      '    (SELECT seq FROM events WHERE cycle_id = ?1 ORDER BY seq LIMIT 1 OFFSET (?2 - 1)), 0))',
      ' ORDER BY seq',
    ].join(' ')).bind(cycleId, sinceRevision).all<StoredStoreEvent>();
    return results;
  }

  private async eventByKey(key: string): Promise<StoredStoreEvent | null> {
    return this.db.prepare(EVENT_SELECT + ' WHERE idempotency_key = ?1').bind(key).first<StoredStoreEvent>();
  }

  private async eventBySeq(seq: number): Promise<StoredStoreEvent | null> {
    return this.db.prepare(EVENT_SELECT + ' WHERE seq = ?1').bind(seq).first<StoredStoreEvent>();
  }

  private async invocationReplayOutcome(descriptor: InvocationDescriptor): Promise<AppendOutcome | null> {
    const existing = await invocationByWakeKey(this.db, descriptor.wake_key);
    if (!existing) return null;
    if (existing.payload_hash !== descriptor.payload_hash) {
      throw new CollabStoreError(
        'INVOCATION_PAYLOAD_CONFLICT',
        'wake_key déjà utilisé pour un payload d’invocation différent ; ne créez pas une nouvelle tentative.',
      );
    }
    const source = await this.eventBySeq(existing.source_event_seq);
    if (!source) throw new CollabStoreError('INVOCATION_INCONSISTENT', 'Invocation durable sans événement source.');
    return { status: 'duplicate', event: source, invocation: existing };
  }

  /**
   * A05 (F1): a reused op_id is only idempotent for the same intent; a
   * different intent under the same key is a conflict, never a silent
   * overwrite of the stored event. Returns null for a new key, the duplicate
   * outcome otherwise (IDEMPOTENCY_CONFLICT on intent mismatch). The message
   * stays neutral: it never echoes the stored seq/type.
   */
  private async replayOutcome(key: string, intentFingerprint: string): Promise<AppendOutcome | null> {
    const existing = await this.eventByKey(key);
    if (!existing) return null;
    const storedFingerprint = await this.intentFingerprint(existing);
    if (storedFingerprint !== intentFingerprint) {
      throw new CollabStoreError(
        'IDEMPOTENCY_CONFLICT',
        'op_id déjà utilisé pour une intention différente. Incrémentez le compteur n de l\'op_id.',
      );
    }
    return { status: 'duplicate', event: existing };
  }

  /**
   * Materialized task statements, validated BEFORE the batch (fail-closed).
   *
   * TOCTOU (accepted, review C2) : the existence check for task.status/handoff
   * reads before the batch runs; a concurrent delete in between makes the UPDATE
   * a no-op. Deletes are not part of the C2 tool surface (append-only journal),
   * so the window is not reachable through this API.
   */
  private async taskStatements(event: StoreEvent, nextRevision: number): Promise<D1PreparedStatement[]> {
    if (event.type !== 'task.claim' && event.type !== 'task.status' && event.type !== 'task.handoff') return [];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    } catch {
      throw new CollabStoreError('INVALID_TASK_PAYLOAD', 'payload_json must be an object for ' + event.type);
    }
    const task = payload.task;
    if (typeof task !== 'object' || task === null) {
      throw new CollabStoreError('INVALID_TASK_PAYLOAD', 'payload_json.task is required for ' + event.type);
    }
    const record = task as Record<string, unknown>;
    const taskId = typeof record.task_id === 'string' ? record.task_id : '';
    if (!TASK_ID_RE.test(taskId)) {
      throw new CollabStoreError('INVALID_TASK_ID', 'task_id must match [a-z0-9][a-z0-9_-]{0,63}');
    }
    if (event.type === 'task.claim') {
      // D12 enforced at write time: author, reviewer and tester are distinct.
      const assignment = validateTaskAssignment({
        task_id: taskId,
        cycle_id: event.cycle_id,
        owner_pid: typeof record.owner_pid === 'string' ? record.owner_pid : '',
        reviewer_pid: typeof record.reviewer_pid === 'string' ? record.reviewer_pid : '',
        tester_pid: typeof record.tester_pid === 'string' ? record.tester_pid : '',
      });
      // A08 (F1): a first claim is filed by the owner themselves; an
      // existing task can only be reassigned by its current owner.
      const current = await this.db.prepare(
        'SELECT owner_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
      ).bind(event.cycle_id, taskId).first<{ owner_pid: string }>();
      const allowedOwner = current ? current.owner_pid : assignment.owner_pid;
      if (!await participantsEquivalent(this.db, allowedOwner, event.participant_id)) {
        throw new CollabStoreError(
          'TASK_FORBIDDEN',
          current
            ? 'task.claim sur une tâche existante est réservé à son owner courant (' + current.owner_pid + '), pas à ' + event.participant_id
            : 'task.claim initial doit être fait par l\'owner de la tâche (' + assignment.owner_pid + '), pas par ' + event.participant_id,
        );
      }
      const assignmentPids = [assignment.owner_pid, assignment.reviewer_pid, assignment.tester_pid] as const;
      await this.requireRegisteredParticipants([...assignmentPids]);
      await assertDistinctLogicalParticipants(this.db, assignmentPids);
      return [this.logicalTaskD12Guard(assignmentPids), this.db.prepare([
        'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status,',
        '                  owned_paths, target_ref, next_action, revision)',
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, \'\', ?8, ?9)',
        'ON CONFLICT(cycle_id, task_id) DO UPDATE SET owner_pid = excluded.owner_pid,',
        '  reviewer_pid = excluded.reviewer_pid, tester_pid = excluded.tester_pid,',
        '  status = excluded.status, owned_paths = excluded.owned_paths,',
        '  next_action = excluded.next_action, revision = excluded.revision',
      ].join(' ')).bind(assignment.task_id, event.cycle_id, assignment.owner_pid, assignment.reviewer_pid,
        assignment.tester_pid, 'in_progress',
        JSON.stringify(Array.isArray(record.owned_paths) ? record.owned_paths : []),
        typeof record.next_action === 'string' ? record.next_action : '', nextRevision)];
    }
    const existing = await this.db.prepare(
      'SELECT owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
    ).bind(event.cycle_id, taskId).first<{ owner_pid: string; reviewer_pid: string; tester_pid: string }>();
    if (!existing) {
      throw new CollabStoreError('TASK_UNKNOWN', 'Tâche inconnue dans le cycle ' + event.cycle_id + ' : ' + taskId);
    }
    if (event.type === 'task.status') {
      // A08 (F1): only the task roles may move the status.
      const roles = [existing.owner_pid, existing.reviewer_pid, existing.tester_pid];
      const authorized = (await Promise.all(roles.map(pid => participantsEquivalent(this.db, pid, event.participant_id)))).some(Boolean);
      if (!authorized) {
        throw new CollabStoreError(
          'TASK_FORBIDDEN',
          'task.status réservé aux rôles de la tâche ' + taskId + ' (' + roles.join(', ') + '), pas à ' + event.participant_id,
        );
      }
      const status = typeof record.status === 'string' ? record.status : '';
      if (!TASK_STATUSES.includes(status as TaskStatus)) {
        throw new CollabStoreError('INVALID_TASK_STATUS', 'Statut de tâche non supporté : ' + status);
      }
      return [this.db.prepare(
        'UPDATE tasks SET status = ?2, revision = ?3 WHERE cycle_id = ?1 AND task_id = ?4'
      ).bind(event.cycle_id, status, nextRevision, taskId)];
    }
    // task.handoff: transfer the task to a new owner with a new next action.
    // A08 (F1): only the current owner may hand the task over.
    if (!await participantsEquivalent(this.db, existing.owner_pid, event.participant_id)) {
      throw new CollabStoreError(
        'TASK_FORBIDDEN',
        'task.handoff réservé à l\'owner courant de la tâche ' + taskId + ' (' + existing.owner_pid + '), pas à ' + event.participant_id,
      );
    }
    // D12 stays enforced at write time: the (possibly new) owner must remain
    // distinct from the reviewer and the tester.
    const ownerPid = typeof record.owner_pid === 'string' && record.owner_pid ? record.owner_pid : existing.owner_pid;
    const pids = [ownerPid, existing.reviewer_pid, existing.tester_pid];
    if (pids.some(pid => !pid) || new Set(pids).size !== pids.length) {
      throw new CollabStoreError('DUPLICATE_TASK_ROLE', 'D12 : auteur, reviewer et testeur doivent etre distincts.');
    }
    await assertDistinctLogicalParticipants(this.db, pids);
    // A08 (F1): the (possibly new) owner must be a participant registered as
    // active on /owner (K6).
    await this.requireRegisteredParticipants([ownerPid]);
    return [this.logicalTaskD12Guard(pids as [string, string, string]), this.db.prepare(
      'UPDATE tasks SET next_action = ?2, owner_pid = ?3, revision = ?4 WHERE cycle_id = ?1 AND task_id = ?5'
    ).bind(event.cycle_id,
      typeof record.next_action === 'string' ? record.next_action : '',
      ownerPid,
      nextRevision, taskId)];
  }

  /**
   * #126 : garde D12 dans le batch lui-même. Si une famille est créée après
   * le pré-check mais avant le commit de task.claim/task.handoff, l'écriture
   * échoue et tout le journal est rollback au lieu de matérialiser deux rôles
   * de la même identité logique.
   */
  private logicalTaskD12Guard(pids: readonly [string, string, string]): D1PreparedStatement {
    return this.db.prepare([
      'INSERT INTO collab_store_guard (ok)',
      'SELECT CASE WHEN COUNT(DISTINCT logical_id) = 3 THEN 1 ELSE 0 END FROM (',
      '  SELECT COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?1), ?1) AS logical_id',
      '  UNION ALL SELECT COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?2), ?2)',
      '  UNION ALL SELECT COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?3), ?3)',
      ')',
    ].join(' ')).bind(...pids);
  }

  /**
   * A08 (F1): every task role must be a participant registered as active on
   * /owner (K6). Unregistered identities cannot own store work.
   */
  private async requireRegisteredParticipants(pids: string[]): Promise<void> {
    for (const pid of pids) {
      const row = await this.db.prepare(
        'SELECT status FROM participants WHERE participant_id = ?1'
      ).bind(pid).first<{ status: string }>();
      if (!row || row.status !== 'active') {
        throw new CollabStoreError(
          'UNREGISTERED_PARTICIPANT',
          'participant non enregistré (actif) pour ce rôle : ' + pid + '. Enregistrement par le propriétaire sur /owner (K6).',
        );
      }
    }
  }

  /**
   * CC-4 A0 (point 5) : une proposition du participant existe-t-elle dans la
   * ronde courante de la phase (événements de seq > entrySeq) ?
   */
  private async currentRoundProposal(cycleId: string, logicalIdentity: string, entrySeq: number): Promise<boolean> {
    const row = await this.db.prepare([
      "SELECT 1 FROM events e WHERE e.cycle_id = ?1 AND e.type = 'proposal.submit'",
      "AND COALESCE((SELECT family_id FROM participant_identity_families f WHERE f.participant_id = e.participant_id), e.participant_id) = ?2",
      'AND e.seq > ?3 LIMIT 1',
    ].join(' ')).bind(cycleId, logicalIdentity, entrySeq).first();
    return !!row;
  }

  /**
   * A05 (F1): canonical intent fingerprint of an append. expected_rev is
   * excluded on purpose: a retry after STALE replays the same intent at a
   * new revision and must stay idempotent.
   */
  private async intentFingerprint(source: {
    cycle_id: string;
    type: string;
    participant_id: string;
    session_id?: string;
    role?: string;
    payload_json: string;
    evidence_ref?: string;
  }): Promise<string> {
    const payloadIntent = source.type === 'proposal.submit'
      ? await this.proposalIntent(source.payload_json, source.cycle_id)
      : source.payload_json;
    return JSON.stringify({
      cycle_id: source.cycle_id,
      type: source.type,
      participant_id: source.participant_id,
      session_id: source.session_id ?? '',
      role: source.role ?? '',
      payload_intent: payloadIntent,
      evidence_ref: source.evidence_ref ?? '',
    });
  }

  /**
   * A05 (F1): content-level intent of a proposal — raw content before P1
   * sealing, sealed envelope content once stored — so a raw replay of a P1
   * proposal compares equal to its sealed event.
   */
  private async proposalIntent(payloadJson: string, cycleId: string): Promise<unknown> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadJson) as Record<string, unknown>;
    } catch {
      return { invalid: payloadJson };
    }
    if (typeof payload.content === 'string' && payload.content) {
      return { proposal_content: await sha256Hex(payload.content) };
    }
    if (typeof payload.sealed_id === 'string' && payload.sealed_id) {
      const row = await this.db.prepare(
        'SELECT content, content_hash FROM sealed_items WHERE id = ?1 AND cycle_id = ?2'
      ).bind(payload.sealed_id, cycleId).first<{ content: string; content_hash: string }>();
      if (row) {
        try {
          return { proposal_content: await sha256Hex(parseSealedEnvelope(row.content).content) };
        } catch {
          return { proposal_content: 'sealed:' + row.content_hash };
        }
      }
      return { sealed_id: payload.sealed_id, content_hash: typeof payload.content_hash === 'string' ? payload.content_hash : '' };
    }
    return { raw: payloadJson };
  }
}

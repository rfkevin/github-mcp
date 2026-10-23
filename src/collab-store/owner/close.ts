/**
 * CC-Owner V2 L2 — clôture d'un cycle par le propriétaire (I7, /owner only).
 *
 * Politique owner (cycle cc-owner-v2, consolidation seq 655, politique seq 656) :
 * - la clôture douce est refusée si des demandes actionnables sont en attente
 *   (le compte est affiché dans le refus) ;
 * - la clôture forcée est réservée à l'owner : motif obligatoire (10 à 500
 *   caractères, journalisé) et confirmation explicite (ressaisie du
 *   cycle_id), compte des demandes affiché ;
 * - des tâches actives (statut hors done/verified) interdisent la
 *   clôture, même forcée ;
 * - l'état fermé est terminal : re-clôturer → CYCLE_ALREADY_CLOSED ;
 * - après clôture, decide reste possible ; les autres actes owner
 *   cycle-scopés (install_phases, import_state, appoint_cycle_coordinator)
 *   et les appends des agents → CYCLE_CLOSED.
 *
 * La clôture est un owner.decision écrit par ownerAppend dans le même lot
 * CAS que son effet (cycles.status = 'closed'). Le compte des demandes
 * pending, lu hors transaction, est ancré par une garde SQL sur la plus
 * grande seq d'événement de demande du cycle : une demande déposée entre la
 * lecture et le lot annule la clôture (refuse-soft atomique) sur un balayage
 * paginé du journal des demandes du cycle, sans plafond silencieux (review
 * GPT-6 seq 662) ni duplication de la classification JS (validité,
 * homonymie) en SQL — une demande arrivée après le comptage reste
 * tranchable après la clôture (borne documentée, decide reste possible).
 */
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { listCyclePendingRequests, ownerAppend, type OwnerWriteResult } from './decisions';
import { assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import type { OwnerProof } from './proof';

/**
 * Garde d'ouverture, réutilisée par les actes owner cycle-scopés (L2) :
 * ?2 est le cycle déjà lié par ownerAppend (clé, cycle, révision, puis
 * binds supplémentaires). COALESCE 'open' : un cycle créé par l'acte
 * lui-même reste légitime (expected_rev = 0), seul un cycle clos est refusé.
 */
export const CYCLE_OPEN_GUARD = "COALESCE((SELECT status FROM cycles WHERE cycle_id = ?2), 'open') = 'open'";

const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_ATTEMPTS = 3;
/** Cycles système exclus : registre owner, alarmes mémoire, tâches du coordinateur. */
const SYSTEM_CYCLES = /^(owner-registry|memory-alarms|coordinator-tasks)$/;

/** Tâches actives d'un cycle : tout statut autre que done / verified. */
const ACTIVE_TASKS_GUARD = "COALESCE((SELECT COUNT(*) FROM tasks WHERE cycle_id = ?2 AND status NOT IN ('done', 'verified')), 0) = 0";
/** Plus grande seq d'événement de demande du cycle (-1 : aucune). */
const LAST_REQUEST_SEQ_SQL = "SELECT COALESCE(MAX(seq), -1) AS n FROM events WHERE cycle_id = ?1 AND type IN ('owner.request', 'phase.request')";
/** La même expression, évaluée dans la garde du lot (?4 = valeur observée au comptage). */
const LAST_REQUEST_SEQ_GUARD = "COALESCE((SELECT MAX(seq) FROM events WHERE cycle_id = ?2 AND type IN ('owner.request', 'phase.request')), -1) = ?4";
/**
 * CC-Owner V2 L6 : variantes liées — la demande close elle-même (seq exclue)
 * ne compte ni au comptage ni dans la garde : exclusion SYMÉTRIQUE JS/SQL,
 * sinon une demande close pending sur son propre cycle se bloquerait seule.
 */
const LAST_REQUEST_SEQ_SQL_EXCLUDING = "SELECT COALESCE(MAX(seq), -1) AS n FROM events WHERE cycle_id = ?1 AND type IN ('owner.request', 'phase.request') AND seq != ?2";
const LAST_REQUEST_SEQ_GUARD_EXCLUDING = "COALESCE((SELECT MAX(seq) FROM events WHERE cycle_id = ?2 AND type IN ('owner.request', 'phase.request') AND seq != ?8), -1) = ?7";

export interface CycleCloseResult extends OwnerWriteResult {
  cycle_id: string;
  force: boolean;
  /** Demandes pending observées au moment de la clôture (tranchables après par decide). */
  pending_requests: number;
  /** Tâches actives au moment de la clôture (0 : la garde du lot l'exige). */
  active_tasks: number;
}

/**
 * Acte owner : fermer un cycle. op nomme la soumission (formulaire /owner) ;
 * la clé d'idempotence rend un double envoi inoffensif, un second close sous
 * une nouvelle clé sur un cycle déjà clos → CYCLE_ALREADY_CLOSED.
 *
 * CC-Owner V2 L6 : version exécutable DOUCE — binding lie la clôture à
 * l’approbation d’une demande close_cycle (cycle_id seul, previous_seq null) ;
 * la demande close elle-même est exclue du comptage et de la garde
 * (exclusion symétrique JS/SQL), sinon elle se bloquerait toute seule.
 */
export async function closeCycle(db: D1Database, input: {
  cycle_id: string;
  force?: boolean;
  reason?: string;
  confirm?: string;
  proof: OwnerProof;
  op: string;
  /** CC-Owner V2 L6 : approbation d’une demande close_cycle — clôture DOUCE liée. */
  binding?: OwnerRequestBinding;
  /** Seq de la demande close elle-même : exclue du comptage et de la garde. */
  excludeRequestSeq?: number | null;
  now?: () => Date;
}): Promise<CycleCloseResult> {
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'La clôture d’un cycle est un acte owner non déléguable.');
  }
  const cycleId = input.cycle_id.trim();
  if (!CYCLE_RE.test(cycleId)) {
    throw new CollabStoreError('INVALID_CYCLE_ID', 'Identifiant de cycle invalide.');
  }
  if (SYSTEM_CYCLES.test(cycleId)) {
    throw new CollabStoreError('CYCLE_CLOSE_SYSTEM_INVALID',
      'Cycle système (registre owner, alarmes mémoire, tâches du coordinateur) : la clôture ne s’applique qu’aux cycles de travail.');
  }
  // CC-Owner V2 L6 : clôture exécutable DOUCE liée — force n’est pas un
  // paramètre approuvable (validateParams l’a déjà refusé ; défense en
  // profondeur), previous_seq est toujours null et la demande close elle-même
  // (excludeRequestSeq) est exclue du comptage et de la garde.
  if (input.binding && input.force === true) {
    throw new CollabStoreError('EXECUTABLE_REQUEST_INVALID',
      'La clôture demandée par un agent est douce (cycle_id seul) : force, reason et confirm ne sont pas approuvables.');
  }
  if (input.binding) assertBindingPrecondition(input.binding, null);
  const excludeSeq = input.excludeRequestSeq ?? null;
  if (input.binding && (excludeSeq === null || !Number.isSafeInteger(excludeSeq) || excludeSeq <= 0)) {
    throw new CollabStoreError('INVALID_REQUEST_ID', 'Clôture exécutable : seq de la demande à exclure du comptage requise.');
  }
  await ensureSchema(db);
  const force = input.force === true;
  const reason = (input.reason ?? '').trim();
  if (force && (reason.length < 10 || reason.length > 500)) {
    throw new CollabStoreError('CYCLE_CLOSE_FORCE_INVALID', 'La clôture forcée exige un motif de 10 à 500 caractères.');
  }
  if (force && input.confirm !== cycleId) {
    throw new CollabStoreError('CYCLE_CLOSE_FORCE_INVALID',
      'Confirmation attendue : ressaisissez l’identifiant exact du cycle (' + cycleId + ').');
  }
  // A05 : le contrôle d'idempotence précède toute garde — le rejeu de la même
  // soumission (même op) renvoie l'événement original (duplicate), même sur un
  // cycle déjà clos ; CYCLE_ALREADY_CLOSED ne vise qu'une clôture distincte.
  // L6 lié : clé de liaison ; garde de famille ?5 sur les actes close du cycle.
  const key = input.binding
    ? bindingKey('owner:cycle-close:' + cycleId, input.binding)
    : 'owner:cycle-close:' + cycleId + ':' + input.op;
  const bound = input.binding ? bindingGuard(input.binding, 'owner:cycle-close:' + cycleId + ':') : null;
  const replay = await db.prepare('SELECT * FROM events WHERE idempotency_key = ?1').bind(key)
    .first<StoredStoreEvent>();
  if (replay) {
    const closedAs = JSON.parse(replay.payload_json) as { force?: boolean; pending_requests?: number; active_tasks?: number };
    return { status: 'duplicate', event: replay, cycle_id: cycleId, force: closedAs.force === true,
      pending_requests: closedAs.pending_requests ?? 0, active_tasks: closedAs.active_tasks ?? 0 };
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const cycle = await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(cycleId).first<{ status: string }>();
    if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId + '.');
    if (cycle.status === 'closed') {
      throw new CollabStoreError('CYCLE_ALREADY_CLOSED', 'Ce cycle est déjà clos (état terminal).');
    }
    const activeTasks = (await db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE cycle_id = ?1 AND status NOT IN ('done', 'verified')"
    ).bind(cycleId).first<{ n: number }>())?.n ?? 0;
    if (activeTasks > 0) {
      throw new CollabStoreError('CYCLE_CLOSE_ACTIVE_TASKS',
        activeTasks + ' tâche(s) active(s) sur ce cycle : terminez-les (done/verified) avant toute clôture, même forcée.');
    }
    // La borne du comptage est lue AVANT les demandes : une demande déposée
    // ensuite fait échouer la garde (refuse-soft atomique), jamais passer.
    // L6 : exclusion symétrique — la borne ET le comptage ignorent la demande close.
    const lastRequestSeq = input.binding
      ? ((await db.prepare(LAST_REQUEST_SEQ_SQL_EXCLUDING).bind(cycleId, excludeSeq as number).first<{ n: number }>())?.n ?? -1)
      : ((await db.prepare(LAST_REQUEST_SEQ_SQL).bind(cycleId).first<{ n: number }>())?.n ?? -1);
    const pending = (await listCyclePendingRequests(db, cycleId))
      .filter(request => request.state === 'pending' && (excludeSeq === null || request.seq !== excludeSeq));
    if (!force && pending.length > 0) {
      throw new CollabStoreError('CYCLE_CLOSE_PENDING_REQUESTS',
        pending.length + ' demande(s) d’agent encore en attente sur ce cycle (la plus récente : seq '
          + Math.max(...pending.map(request => request.seq))
          + ') : tranchez-les sur /owner (K-decide), ou forcez la clôture avec motif et confirmation.');
    }
    try {
      const result = await ownerAppend(db, {
        cycleId,
        key,
        payload: { action: 'close_cycle', cycle_id: cycleId, force,
          pending_requests: pending.length, active_tasks: activeTasks,
          ...(force ? { reason } : {}), ...(input.binding ? bindingPayload(input.binding) : {}) },
        proof: input.proof,
        // Gardes dans le lot : cycle ouvert, aucune tâche active, et (douce)
        // aucune demande déposée depuis le comptage. Force : les demandes ne
        // bloquent plus, le compte reste journalisé.
        extraGuard: bound ? {
          // L6 lié : garde de liaison (?4..?6), ouverture et tâches (?2),
          // refuse-soft atomique avec exclusion symétrique (?7 borne, ?8 exclue).
          sql: [CYCLE_OPEN_GUARD, ACTIVE_TASKS_GUARD, '(' + bound.sql + ')', LAST_REQUEST_SEQ_GUARD_EXCLUDING].join(' AND '),
          binds: [...bound.binds, lastRequestSeq, excludeSeq as number],
        } : {
          sql: [CYCLE_OPEN_GUARD, ACTIVE_TASKS_GUARD, force ? '1 = 1' : LAST_REQUEST_SEQ_GUARD].join(' AND '),
          binds: force ? [] : [lastRequestSeq],
        },
        sideEffects: key => [
          ...(input.binding ? bindingStatements(db, input.binding, input.proof, key, input.now) : []),
          db.prepare("UPDATE cycles SET status = 'closed' WHERE cycle_id = ?1").bind(cycleId),
        ],
        now: input.now,
      });
      return { ...result, cycle_id: cycleId, force, pending_requests: pending.length, active_tasks: activeTasks };
    } catch (error) {
      if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
        // La course (demande déposée, tâche créée, clôture concurrente) annule
        // le lot : re-diagnostic, puis nouvel essai aux valeurs fraîches.
        const status = (await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(cycleId)
          .first<{ status: string }>())?.status;
        if (status === 'closed') {
          throw new CollabStoreError('CYCLE_ALREADY_CLOSED', 'Ce cycle est déjà clos (état terminal).');
        }
        continue;
      }
      throw error;
    }
  }
  throw new CollabStoreError('STALE', 'Le cycle change trop vite ; réessayez la clôture.');
}

/**
 * Re-diagnostic partagé des actes owner cycle-scopés (L2) : une garde de lot
 * échouée (OWNER_PRECONDITION_FAILED) devient CYCLE_CLOSED si le cycle a été
 * clos entre-temps ; toute autre erreur passe telle quelle.
 */
export async function rethrowIfCycleClosed(db: D1Database, cycleId: string, error: unknown): Promise<never> {
  if (error instanceof CollabStoreError && error.code === 'OWNER_PRECONDITION_FAILED') {
    const status = (await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(cycleId)
      .first<{ status: string }>())?.status;
    if (status === 'closed') {
      throw new CollabStoreError('CYCLE_CLOSED',
        'Cycle clos par le propriétaire : cet acte cycle-scopé est refusé (les décisions restent possibles).');
    }
  }
  throw error;
}

/**
 * CC-Owner V2 L4 : synthèse lecture seule des statuts de cycle pour le bandeau
 * /owner. Même frontière que la clôture : les cycles système (registre owner,
 * alarmes mémoire, tâches du coordinateur) ne comptent pas ; tout statut autre
 * que open/closed est ignoré. Aucune écriture.
 */
export async function cycleStatusCounts(db: D1Database): Promise<{ open: number; closed: number }> {
  await ensureSchema(db);
  const { results } = await db.prepare('SELECT cycle_id, status FROM cycles').all<{ cycle_id: string; status: string }>();
  const counts = { open: 0, closed: 0 };
  for (const row of results) {
    if (SYSTEM_CYCLES.test(row.cycle_id)) continue;
    if (row.status === 'open') counts.open += 1;
    else if (row.status === 'closed') counts.closed += 1;
  }
  return counts;
}

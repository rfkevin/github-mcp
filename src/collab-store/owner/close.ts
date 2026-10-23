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
 * lecture et le lot annule la clôture (refuse-soft atomique) sans dupliquer
 * la classification JS (validité, homonymie) en SQL — une demande arrivée
 * après le comptage reste tranchable après la clôture (borne documentée,
 * decide reste possible).
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { listCyclePendingRequests, ownerAppend, type OwnerWriteResult } from './decisions';
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
 */
export async function closeCycle(db: D1Database, input: {
  cycle_id: string;
  force?: boolean;
  reason?: string;
  confirm?: string;
  proof: OwnerProof;
  op: string;
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
    const lastRequestSeq = (await db.prepare(LAST_REQUEST_SEQ_SQL).bind(cycleId).first<{ n: number }>())?.n ?? -1;
    const pending = (await listCyclePendingRequests(db, cycleId)).filter(request => request.state === 'pending');
    if (!force && pending.length > 0) {
      throw new CollabStoreError('CYCLE_CLOSE_PENDING_REQUESTS',
        pending.length + ' demande(s) d’agent encore en attente sur ce cycle (la plus récente : seq '
          + Math.max(...pending.map(request => request.seq))
          + ') : tranchez-les sur /owner (K-decide), ou forcez la clôture avec motif et confirmation.');
    }
    try {
      const result = await ownerAppend(db, {
        cycleId,
        key: 'owner:cycle-close:' + cycleId + ':' + input.op,
        payload: { action: 'close_cycle', cycle_id: cycleId, force,
          pending_requests: pending.length, active_tasks: activeTasks,
          ...(force ? { reason } : {}) },
        proof: input.proof,
        // Gardes dans le lot : cycle ouvert, aucune tâche active, et (douce)
        // aucune demande déposée depuis le comptage. Force : les demandes ne
        // bloquent plus, le compte reste journalisé.
        extraGuard: {
          sql: [CYCLE_OPEN_GUARD, ACTIVE_TASKS_GUARD, force ? '1 = 1' : LAST_REQUEST_SEQ_GUARD].join(' AND '),
          binds: force ? [] : [lastRequestSeq],
        },
        sideEffects: () => [db.prepare("UPDATE cycles SET status = 'closed' WHERE cycle_id = ?1").bind(cycleId)],
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

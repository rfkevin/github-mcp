/**
 * CC-5 l3d (incrément 2b-2c) — réattribution d'une tâche, acte owner exécutable.
 *
 * Jusqu'ici, changer l'auteur, le relecteur ou le testeur d'une tâche exigeait
 * de réimporter tout l'état CC-STATE-1. `reassign_task` change les trois rôles
 * d'UNE tâche, déposé par un agent comme demande owner exécutable et approuvé
 * par Kevin sur /owner (même circuit que install_phases / import_state).
 *
 * Garanties, toutes revérifiées DANS le lot d'écriture (garde ownerAppend) :
 * - demande non tranchée et dernier acte de réattribution de CETTE tâche
 *   inchangé (précondition previous_seq, owner/binding.ts) ;
 * - CAS sur la tâche : même révision ET mêmes rôles qu'au dépôt. Les rôles
 *   d'origine sont FIGÉS dans les paramètres de la demande (expected_owner_pid,
 *   expected_reviewer_pid, expected_tester_pid), donc couverts par l'empreinte
 *   payload_sha256 approuvée par Kevin : un changement de rôles entre le dépôt
 *   et l'approbation annule l'acte même si la révision de la tâche n'a pas
 *   bougé (revue GPT-6 #177). Un réimport d'état ou un task.handoff entre-temps
 *   annule donc l'acte sans dépendre du maintien de la révision par les autres
 *   chemins ;
 * - tâche ouverte : ni done ni verified. Une tâche blocked reste
 *   réattribuable (changer de titulaire est un moyen de la débloquer) ;
 * - D12 : trois participants enregistrés actifs, trois identités LOGIQUES
 *   distinctes (familles #126 comprises) ;
 * - la révision de la tâche prend celle du cycle après l'acte : l'épisode du
 *   contrôleur change, les réveils des nouveaux titulaires sont réarmés.
 *
 * Délégation : refusée (preuve déléguée → DELEGATED_FORBIDDEN). La politique
 * L3c liste reassign_task comme délégable un jour, mais la garde déléguée de
 * binding.ts ne couvre que install_phases ; l'étendre est une révision de
 * contrat distincte. HALT ne bloque pas un acte de Kevin lui-même (comme
 * import_state) : HALT arrête l'automatisation, pas le propriétaire.
 */
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { TASK_PID_RE, validateTaskAssignment } from '../contracts/tasks';
import { assertDistinctLogicalParticipants } from '../identity/families';
import { assertBindingPrecondition, bindingGuard, bindingKey, bindingPayload, bindingStatements, type OwnerRequestBinding } from './binding';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

export const REASSIGN_KEY_PREFIX = 'owner:reassign:';
const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FIELDS = ['cycle_id', 'task_id', 'owner_pid', 'reviewer_pid', 'tester_pid',
  'expected_revision', 'expected_owner_pid', 'expected_reviewer_pid', 'expected_tester_pid'] as const;
const EXPECTED_ROLES = ['expected_owner_pid', 'expected_reviewer_pid', 'expected_tester_pid'] as const;

export interface ReassignParams {
  cycle_id: string;
  task_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  expected_revision: number;
  /** Rôles lus au dépôt : figés dans la demande (et donc dans son empreinte). */
  expected_owner_pid: string;
  expected_reviewer_pid: string;
  expected_tester_pid: string;
}

/** Cible affichée et clé de précondition : une tâche d'un cycle. */
export function reassignTarget(cycleId: string, taskId: string): string {
  return cycleId + '/' + taskId;
}

/** Validation stricte des paramètres (champs exacts, D12 sur les identifiants). Lève Error lisible. */
export function parseReassignParams(params: Record<string, unknown>): ReassignParams {
  const extra = Object.keys(params).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (extra.length) throw new Error('params : champs inconnus ' + extra.join(', ') + '.');
  const cycleId = params.cycle_id;
  if (typeof cycleId !== 'string' || !CYCLE_RE.test(cycleId)) throw new Error('params.cycle_id invalide.');
  const revision = params.expected_revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('params.expected_revision : entier >= 0 (révision de la tâche au dépôt).');
  for (const field of EXPECTED_ROLES) {
    const value = params[field];
    if (typeof value !== 'string' || !TASK_PID_RE.test(value)) {
      throw new Error('params.' + field + ' : identifiant du titulaire actuel requis (rôles lus au dépôt).');
    }
  }
  let assignment;
  try {
    assignment = validateTaskAssignment({ task_id: String(params.task_id ?? ''), cycle_id: cycleId,
      owner_pid: params.owner_pid as string, reviewer_pid: params.reviewer_pid as string, tester_pid: params.tester_pid as string });
  } catch (error) {
    throw new Error('params : ' + (error instanceof Error ? error.message : 'affectation invalide') + '.');
  }
  return { cycle_id: cycleId, task_id: assignment.task_id, owner_pid: assignment.owner_pid,
    reviewer_pid: assignment.reviewer_pid, tester_pid: assignment.tester_pid, expected_revision: revision as number,
    expected_owner_pid: params.expected_owner_pid as string, expected_reviewer_pid: params.expected_reviewer_pid as string,
    expected_tester_pid: params.expected_tester_pid as string };
}

function prefixOf(cycleId: string, taskId: string): string {
  return REASSIGN_KEY_PREFIX + cycleId + ':' + taskId;
}

/** seq de la dernière réattribution de la tâche (précondition des demandes), null s'il n'y en a pas. */
export async function latestReassignActSeq(db: D1Database, target: string): Promise<number | null> {
  await ensureSchema(db);
  const slash = target.indexOf('/');
  if (slash <= 0) return null;
  const cycleId = target.slice(0, slash);
  const row = await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND substr(idempotency_key, 1, length(?2)) = ?2")
    .bind(cycleId, prefixOf(cycleId, target.slice(slash + 1)) + ':').first<{ seq: number | null }>();
  return row?.seq ?? null;
}

export interface ReassignResult extends OwnerWriteResult {
  from: { owner_pid: string; reviewer_pid: string; tester_pid: string };
  to: { owner_pid: string; reviewer_pid: string; tester_pid: string };
}

interface TaskRow { owner_pid: string; reviewer_pid: string; tester_pid: string; status: string; revision: number }

export async function reassignTask(db: D1Database, input: {
  params: Record<string, unknown>;
  proof: OwnerProof;
  binding: OwnerRequestBinding;
  now?: () => Date;
}): Promise<ReassignResult> {
  await ensureSchema(db);
  if (input.proof.kind === 'delegated') {
    throw new CollabStoreError('DELEGATED_FORBIDDEN', 'reassign_task n’est pas délégable dans ce contrat : approbation de Kevin requise.');
  }
  let params: ReassignParams;
  try {
    params = parseReassignParams(input.params);
  } catch (error) {
    throw new CollabStoreError('INVALID_REASSIGNMENT', error instanceof Error ? error.message : 'paramètres invalides.');
  }
  const task = await db.prepare('SELECT owner_pid, reviewer_pid, tester_pid, status, revision FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
    .bind(params.cycle_id, params.task_id).first<TaskRow>();
  if (!task) throw new CollabStoreError('TASK_UNKNOWN', 'Tâche inconnue dans ce cycle : ' + params.task_id + '.');
  if (task.status === 'done' || task.status === 'verified') {
    throw new CollabStoreError('TASK_CLOSED', 'Tâche terminée (' + task.status + ') : réattribution refusée.');
  }
  if (task.revision !== params.expected_revision) {
    throw new CollabStoreError('OWNER_PRECONDITION_FAILED', 'La tâche est à la révision ' + task.revision + ', la demande attendait '
      + params.expected_revision + ' : l’état a changé depuis le dépôt, rien n’est exécuté.');
  }
  const from = { owner_pid: params.expected_owner_pid, reviewer_pid: params.expected_reviewer_pid, tester_pid: params.expected_tester_pid };
  if (task.owner_pid !== from.owner_pid || task.reviewer_pid !== from.reviewer_pid || task.tester_pid !== from.tester_pid) {
    throw new CollabStoreError('OWNER_PRECONDITION_FAILED', 'Les rôles de la tâche ont changé depuis le dépôt (actuels : '
      + task.owner_pid + ' / ' + task.reviewer_pid + ' / ' + task.tester_pid + ') : rien n’est exécuté.');
  }
  for (const pid of [params.owner_pid, params.reviewer_pid, params.tester_pid]) {
    const row = await db.prepare('SELECT status FROM participants WHERE participant_id = ?1').bind(pid).first<{ status: string }>();
    if (!row || row.status !== 'active') throw new CollabStoreError('UNREGISTERED_PARTICIPANT', 'Participant non enregistré (actif) : ' + pid + '.');
  }
  await assertDistinctLogicalParticipants(db, [params.owner_pid, params.reviewer_pid, params.tester_pid]);
  const prefix = prefixOf(params.cycle_id, params.task_id);
  const previous = await latestReassignActSeq(db, reassignTarget(params.cycle_id, params.task_id));
  assertBindingPrecondition(input.binding, previous);
  const bound = bindingGuard(input.binding, prefix + ':');
  const to = { owner_pid: params.owner_pid, reviewer_pid: params.reviewer_pid, tester_pid: params.tester_pid };
  const logical = (n: number) => 'COALESCE((SELECT family_id FROM participant_identity_families WHERE participant_id = ?' + n + '), ?' + n + ')';
  // ?4..?6 : bindingGuard ; ?7 tâche, ?8 révision attendue, ?9..?11 nouveaux rôles, ?12..?14 rôles figés dans la demande.
  const guard = [
    '(' + bound.sql + ')',
    "AND EXISTS (SELECT 1 FROM tasks WHERE cycle_id = ?2 AND task_id = ?7 AND revision = ?8 AND status NOT IN ('done', 'verified')",
    '  AND owner_pid = ?12 AND reviewer_pid = ?13 AND tester_pid = ?14)',
    "AND (SELECT COUNT(*) FROM participants WHERE participant_id IN (?9, ?10, ?11) AND status = 'active') = 3",
    'AND ' + logical(9) + ' != ' + logical(10),
    'AND ' + logical(9) + ' != ' + logical(11),
    'AND ' + logical(10) + ' != ' + logical(11),
  ].join(' ');
  const result = await ownerAppend(db, {
    cycleId: params.cycle_id,
    key: bindingKey(prefix, input.binding),
    payload: { action: 'reassign_task', cycle_id: params.cycle_id, task_id: params.task_id, expected_revision: params.expected_revision,
      from, to, ...bindingPayload(input.binding) },
    proof: input.proof,
    extraGuard: { sql: guard, binds: [...bound.binds, params.task_id, params.expected_revision,
      to.owner_pid, to.reviewer_pid, to.tester_pid, from.owner_pid, from.reviewer_pid, from.tester_pid] },
    sideEffects: eventKey => [
      ...bindingStatements(db, input.binding, input.proof, eventKey, input.now),
      // Après la mise à jour de cycles.revision dans ownerAppend : la tâche prend la nouvelle révision du cycle.
      db.prepare([
        'UPDATE tasks SET owner_pid = ?3, reviewer_pid = ?4, tester_pid = ?5,',
        '  revision = (SELECT revision FROM cycles WHERE cycle_id = ?1)',
        'WHERE cycle_id = ?1 AND task_id = ?2',
      ].join(' ')).bind(params.cycle_id, params.task_id, to.owner_pid, to.reviewer_pid, to.tester_pid),
    ],
    now: input.now,
  });
  return { ...result, from, to };
}

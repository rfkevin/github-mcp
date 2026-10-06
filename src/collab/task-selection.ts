import { StateContractError } from './contracts';
import type { StateSnapshot, TaskRecord } from './contracts';
import { roleRecords, taskRecords } from './state';

/** Statuts pour lesquels une tâche porte encore une action ; done/verified/blocked sont historiques ou en attente owner. */
export const ACTIONABLE_STATUSES = ['proposed', 'accepted', 'in_progress', 'review'];

/** Comment le participant est lié à la tâche retenue. */
export type TaskParticipation = 'owner' | 'reviewer' | 'tester';

/** Pourquoi cette tâche a été retenue ; aucune valeur ne résulte d'un choix arbitraire. */
export type TaskSelectionReason =
  | 'task_id'
  | 'single_candidate'
  | 'roles_pending_evidence'
  | 'state_next_action'
  | 'only_actionable';

export type SelectedTask = { record: TaskRecord; participation: TaskParticipation | null; selectedBy: TaskSelectionReason };

type Candidate = { record: TaskRecord; participation: TaskParticipation };

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Vrai si `name` apparaît comme nom entier dans une cellule libre (notes entre parenthèses ignorées). */
function cellNames(cell: string | undefined, name: string): boolean {
  if (!cell) return false;
  const bare = cell.replace(/\([^)]*\)/g, ' ');
  return new RegExp('(^|[^\\w.-])' + escape(name) + '($|[^\\w.-])').test(bare);
}

/** Vrai si un identifiant de tâche est cité comme jeton entier (G5 ne correspond pas à G5-F8). */
function mentionsTask(text: string, id: string): boolean {
  return new RegExp('(^|[^\\w-])' + escape(id) + '($|[^\\w-])').test(text);
}

/** Colonnes reviewer/tester optionnelles du tableau Tasks, lues sans modifier le contrat L1. */
function responsibilityColumns(snapshot: StateSnapshot): Map<string, { reviewer?: string; tester?: string }> {
  const table = (snapshot.sections['Tasks'] ?? []).find(candidate => candidate.headers.includes('id') && candidate.headers.includes('status'));
  const columns = new Map<string, { reviewer?: string; tester?: string }>();
  if (!table) return columns;
  const at = (row: string[], name: string): string | undefined => {
    const position = table.headers.indexOf(name);
    return position >= 0 ? row[position] : undefined;
  };
  for (const row of table.rows) columns.set(at(row, 'id') ?? '', { reviewer: at(row, 'reviewer'), tester: at(row, 'tester') });
  return columns;
}

/** Tâches actionnables où le participant est owner (égalité exacte, comme avant), reviewer ou tester déclaré. */
function participantCandidates(snapshot: StateSnapshot, participant: string): Candidate[] {
  const columns = responsibilityColumns(snapshot);
  const candidates: Candidate[] = [];
  for (const record of taskRecords(snapshot)) {
    if (!ACTIONABLE_STATUSES.includes(record.status)) continue;
    const extra = columns.get(record.id) ?? {};
    if (record.owner === participant) candidates.push({ record, participation: 'owner' });
    else if (cellNames(extra.tester, participant)) candidates.push({ record, participation: 'tester' });
    else if (cellNames(extra.reviewer, participant)) candidates.push({ record, participation: 'reviewer' });
  }
  return candidates;
}

/** Pointeurs canoniques, dans l'ordre : la ligne Roles du participant, puis le next_action d'en-tête s'il le nomme. */
function canonicalPointers(snapshot: StateSnapshot, participant: string): Array<{ reason: TaskSelectionReason; text: string }> {
  const pointers: Array<{ reason: TaskSelectionReason; text: string }> = [];
  const role = roleRecords(snapshot).find(record => record.actor === participant);
  if (role) pointers.push({ reason: 'roles_pending_evidence', text: role.pendingEvidence });
  const headerNext = snapshot.headers.next_action ?? '';
  if (cellNames(headerNext, participant)) pointers.push({ reason: 'state_next_action', text: headerNext });
  return pointers;
}

const describe = (candidates: Candidate[]): string => candidates.map(candidate => candidate.record.id + ' (' + candidate.participation + ')').join(', ');

/**
 * Sélection déterministe de la mission d'un participant.
 * Une seule candidate : retenue. Plusieurs : la première source canonique (Roles, puis next_action d'en-tête)
 * qui en cite exactement une la désigne. Sinon échec fermé AMBIGUOUS_TASK : aucun choix arbitraire.
 */
export function selectTask(snapshot: StateSnapshot, request: { participant?: string; taskId?: string }): SelectedTask | null {
  const records = taskRecords(snapshot);
  if (request.taskId) {
    const found = records.find(record => record.id === request.taskId);
    if (!found) {
      throw new StateContractError('TASK_NOT_FOUND', 'No task matches id ' + request.taskId + ' in the canonical state');
    }
    const participation = request.participant
      ? participantCandidates(snapshot, request.participant).find(candidate => candidate.record.id === found.id)?.participation ?? null
      : null;
    return { record: found, participation, selectedBy: 'task_id' };
  }
  if (request.participant) {
    const candidates = participantCandidates(snapshot, request.participant);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return { ...candidates[0], selectedBy: 'single_candidate' };
    for (const pointer of canonicalPointers(snapshot, request.participant)) {
      const cited = candidates.filter(candidate => mentionsTask(pointer.text, candidate.record.id));
      if (cited.length === 1) return { ...cited[0], selectedBy: pointer.reason };
    }
    throw new StateContractError('AMBIGUOUS_TASK', 'Several actionable tasks fit participant ' + request.participant + ' (' + describe(candidates) + ') and no canonical pointer (Roles pending evidence, state next_action) names exactly one: specify taskId.');
  }
  const actionable = records.filter(record => ACTIONABLE_STATUSES.includes(record.status));
  if (actionable.length === 0) return null;
  if (actionable.length > 1) {
    throw new StateContractError('AMBIGUOUS_TASK', 'Several actionable tasks fit the instruction (' + actionable.map(record => record.id).join(', ') + '): specify taskId or participant.');
  }
  return { record: actionable[0], participation: null, selectedBy: 'only_actionable' };
}

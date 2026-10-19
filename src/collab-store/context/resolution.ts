import { CollabStoreError } from '../store/collab-store';
import { equivalentParticipantIds } from '../identity/families';
import { ensureContextSchema, normalizeIssueRef } from './schema';

export type Participation = 'owner' | 'reviewer' | 'tester';

export interface ResolvedTask {
  task_id: string;
  cycle_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  status: string;
  owned_paths: string;
  target_ref: string;
  next_action: string;
  revision: number;
  participation: Participation;
}

export interface ResolveContextInput {
  issue?: string;
  cycle?: string;
  repository?: string;
  participant_id: string;
  role?: Participation;
  task?: string;
}

async function resolveCycleId(db: D1Database, input: ResolveContextInput): Promise<string> {
  if (input.cycle) return input.cycle;
  if (!input.issue) {
    // CC-4 A0 (point 3) — découverte du cycle pour une reprise générique
    // (« Collaboration 3, reprends », défaut vu au trial C7) : sans issue ni
    // cycle explicites, le participant doit tenir un rôle dans exactement UN
    // cycle ouvert (ou dans la tâche nommée). Sinon l'échec est explicite —
    // jamais un choix implicite.
    await ensureContextSchema(db);
    const equivalents = await equivalentParticipantIds(db, input.participant_id);
    const placeholders = equivalents.map((_, index) => '?' + (index + 1)).join(',');
    const lines = [
      'SELECT DISTINCT t.cycle_id FROM tasks t JOIN cycles c ON c.cycle_id = t.cycle_id',
      "WHERE c.status = 'open'",
      'AND (t.owner_pid IN (' + placeholders + ') OR t.reviewer_pid IN (' + placeholders + ') OR t.tester_pid IN (' + placeholders + '))',
    ];
    const params: unknown[] = [...equivalents];
    if (input.task) {
      lines.push('AND t.task_id = ?' + (equivalents.length + 1));
      params.push(input.task);
    }
    lines.push('ORDER BY t.cycle_id');
    const { results } = await db.prepare(lines.join(' ')).bind(...params).all<{ cycle_id: string }>();
    if (results.length === 0) {
      throw new CollabStoreError(
        'NO_ACTIVE_CYCLE',
        'Aucun cycle ouvert où « ' + input.participant_id + ' » tient un rôle' + (input.task ? ' sur la tâche « ' + input.task + ' »' : '') + '. Fournissez issue ou cycle.',
      );
    }
    if (results.length > 1) {
      throw new CollabStoreError(
        'AMBIGUOUS_CYCLE',
        'Cycles ouverts ambigus pour « ' + input.participant_id + ' » : ' + results.map(row => row.cycle_id).join(', ') + '. Fournissez issue ou cycle.',
      );
    }
    return results[0].cycle_id;
  }
  await ensureContextSchema(db);
  const issueRef = normalizeIssueRef(input.issue);
  const repository = issueRef.repository ?? input.repository;
  if (repository) {
    const row = await db.prepare(
      'SELECT cycle_id FROM cycle_issue_refs_v2 WHERE repository = ?1 AND issue_number = ?2'
    ).bind(repository, issueRef.issue_number).first<{ cycle_id: string }>();
    if (!row) {
      throw new CollabStoreError('UNKNOWN_ISSUE', 'Aucun cycle pour ' + repository + '#' + issueRef.issue_number + '.');
    }
    return row.cycle_id;
  }

  const { results } = await db.prepare(
    'SELECT repository, cycle_id FROM cycle_issue_refs_v2 WHERE issue_number = ?1 ORDER BY repository'
  ).bind(issueRef.issue_number).all<{ repository: string; cycle_id: string }>();
  if (results.length === 0) {
    throw new CollabStoreError('UNKNOWN_ISSUE', 'Aucun cycle pour issue #' + issueRef.issue_number + '.');
  }
  if (results.length > 1) {
    throw new CollabStoreError(
      'AMBIGUOUS_ISSUE',
      'Issue #' + issueRef.issue_number + ' existe dans plusieurs dépôts : ' +
        results.map(row => row.repository).join(', ') + '. Fournissez repository ou repo#issue.',
    );
  }
  return results[0].cycle_id;
}

// CC-5 L2 : Pick partiel — réutilisable sur un SELECT restreint (task fournie inconnue/non tenue).
function participationOf(row: Pick<ResolvedTask, 'owner_pid' | 'reviewer_pid' | 'tester_pid'>, participantIds: ReadonlySet<string>): Participation | null {
  if (participantIds.has(row.owner_pid)) return 'owner';
  if (participantIds.has(row.reviewer_pid)) return 'reviewer';
  if (participantIds.has(row.tester_pid)) return 'tester';
  return null;
}

export async function resolveContextTarget(db: D1Database, input: ResolveContextInput): Promise<{
  cycle_id: string;
  task: ResolvedTask | null;
}> {
  const cycleId = await resolveCycleId(db, input);
  await ensureContextSchema(db);
  const cycle = await db.prepare('SELECT cycle_id FROM cycles WHERE cycle_id = ?1').bind(cycleId).first();
  if (!cycle) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);

  const equivalents = await equivalentParticipantIds(db, input.participant_id);
  const equivalentSet = new Set(equivalents);
  const placeholders = equivalents.map((_, index) => '?' + (index + 2)).join(',');
  const { results } = await db.prepare([
    'SELECT task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision',
    'FROM tasks WHERE cycle_id = ?1',
    'AND (owner_pid IN (' + placeholders + ') OR reviewer_pid IN (' + placeholders + ') OR tester_pid IN (' + placeholders + '))',
    'ORDER BY task_id',
  ].join(' ')).bind(cycleId, ...equivalents).all<Omit<ResolvedTask, 'participation'>>();

  let candidates = results
    .map(row => ({ ...row, participation: participationOf(row, equivalentSet)! }))
    .filter(row => !input.role || row.participation === input.role);

  if (input.task) candidates = candidates.filter(row => row.task_id === input.task);
  if (candidates.length > 1) {
    throw new CollabStoreError(
      'AMBIGUOUS_TASK',
      'Plusieurs tâches correspondent : ' + candidates.map(row => row.task_id + ' (' + row.participation + ')').join(', ') + '.' +
        ' Fournissez task: « ' + candidates[0].task_id + ' » (ou un autre identifiant listé) pour sélectionner.'
    );
  }
  if (input.task && candidates.length === 0) {
    // CC-5 L2 : un task fourni mais absent ou non tenu échoue explicitement —
    // jamais un packet sans tâche quand le participant a nommé la sienne.
    const task = await db.prepare(
      'SELECT owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2'
    ).bind(cycleId, input.task).first<Pick<ResolvedTask, 'owner_pid' | 'reviewer_pid' | 'tester_pid'>>();
    if (!task) {
      throw new CollabStoreError('TASK_UNKNOWN', 'Tâche « ' + input.task + ' » inconnue dans le cycle « ' + cycleId + ' ».');
    }
    const held = participationOf(task, equivalentSet);
    throw new CollabStoreError(
      'TASK_NOT_HELD',
      held
        ? 'Sur la tâche « ' + input.task + ' » du cycle « ' + cycleId + ' », vous êtes ' + held + (input.role ? ', pas ' + input.role : '') + '.'
        : 'Vous ne tenez aucun rôle sur la tâche « ' + input.task + ' » du cycle « ' + cycleId + ' ».',
    );
  }
  return { cycle_id: cycleId, task: candidates[0] ?? null };
}

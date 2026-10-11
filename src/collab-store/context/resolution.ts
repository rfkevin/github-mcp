import { CollabStoreError } from '../store/collab-store';
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
    const lines = [
      'SELECT DISTINCT t.cycle_id FROM tasks t JOIN cycles c ON c.cycle_id = t.cycle_id',
      "WHERE c.status = 'open'",
      'AND (t.owner_pid = ?1 OR t.reviewer_pid = ?1 OR t.tester_pid = ?1)',
    ];
    const params: unknown[] = [input.participant_id];
    if (input.task) {
      lines.push('AND t.task_id = ?2');
      params.push(input.task);
    }
    lines.push('ORDER BY t.cycle_id');
    const { results } = await db.prepare(lines.join(' ')).bind(...params).all<{ cycle_id: string }>();
    if (results.length === 0) {
      throw new CollabStoreError(
        'NO_ACTIVE_CYCLE',
        'Aucun cycle ouvert où « ' + input.participant_id + ' » tient un rôle. Fournissez issue ou cycle.',
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

function participationOf(row: Omit<ResolvedTask, 'participation'>, participantId: string): Participation | null {
  if (row.owner_pid === participantId) return 'owner';
  if (row.reviewer_pid === participantId) return 'reviewer';
  if (row.tester_pid === participantId) return 'tester';
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

  const { results } = await db.prepare([
    'SELECT task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision',
    'FROM tasks WHERE cycle_id = ?1',
    'AND (owner_pid = ?2 OR reviewer_pid = ?2 OR tester_pid = ?2)',
    'ORDER BY task_id',
  ].join(' ')).bind(cycleId, input.participant_id).all<Omit<ResolvedTask, 'participation'>>();

  let candidates = results
    .map(row => ({ ...row, participation: participationOf(row, input.participant_id)! }))
    .filter(row => !input.role || row.participation === input.role);

  if (input.task) candidates = candidates.filter(row => row.task_id === input.task);
  if (candidates.length > 1) {
    throw new CollabStoreError(
      'AMBIGUOUS_TASK',
      'Plusieurs tâches correspondent : ' + candidates.map(row => row.task_id + ' (' + row.participation + ')').join(', ') + '.'
    );
  }
  return { cycle_id: cycleId, task: candidates[0] ?? null };
}

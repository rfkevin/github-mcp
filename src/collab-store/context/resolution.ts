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
  participant_id: string;
  role?: Participation;
  task?: string;
}

async function resolveCycleId(db: D1Database, input: ResolveContextInput): Promise<string> {
  if (input.cycle) return input.cycle;
  if (!input.issue) throw new CollabStoreError('CONTEXT_TARGET_REQUIRED', 'Fournissez issue ou cycle.');
  await ensureContextSchema(db);
  const issueRef = normalizeIssueRef(input.issue);
  const row = await db.prepare('SELECT cycle_id FROM cycle_issue_refs WHERE issue_ref = ?1')
    .bind(issueRef).first<{ cycle_id: string }>();
  if (!row) throw new CollabStoreError('UNKNOWN_ISSUE', 'Aucun cycle pour ' + issueRef + '.');
  return row.cycle_id;
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

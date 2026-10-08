/**
 * CC-3 C6 — owner import of a merged CC-STATE-1 snapshot (I7).
 *
 * Importing a state file is what merging a state PR used to be: it sets the
 * cycle's phase, replaces its materialized tasks and becomes the base that
 * collab_export overlays with later store events. It is therefore an owner
 * act, recorded as one owner.decision event (action import_state) in the same
 * CAS batch as its side effects, from the /owner route only.
 *
 * The event payload carries the canonical document, so the base is replayable
 * from the journal; the document is the merged GitHub file, not a secret.
 */
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { ensureContextSchema } from '../context/schema';
import { loadLabelDirectory, DEFAULT_OWNER_LABEL } from '../export/labels';
import { planStateImport, type ExportTarget } from '../export/state-import-plan';
import { STATE_IMPORT_KEY_PREFIX } from '../export/state-export';
import { ownerAppend, type OwnerWriteResult } from './decisions';
import type { OwnerProof } from './proof';

const MAX_TASKS = 200;

export interface StateImportResult extends OwnerWriteResult {
  state_revision: number;
  content_sha256: string;
  tasks: number;
  /** Store tasks of the cycle that the imported file does not contain (replaced by the import). */
  dropped_tasks: string[];
  /** GitHub issues indexed for C3 `issue → cycle` resolution (framing_ref, plan_ref, contract_ref, acceptance_ref). */
  issue_refs: string[];
  /** Issues that were mapped to another cycle before this import (the owner import reassigns them). */
  reassigned_issues: string[];
}

export async function importStateSnapshot(db: D1Database, input: {
  cycle_id: string;
  markdown: string;
  proof: OwnerProof;
  owner_label?: string;
  target?: ExportTarget | null;
  now?: () => Date;
}): Promise<StateImportResult> {
  await ensureSchema(db);
  // C3 owns cycle_issue_refs_v2; the import indexes the state's issues there in the same batch.
  await ensureContextSchema(db);
  const ownerLabel = (input.owner_label ?? '').trim() || DEFAULT_OWNER_LABEL;
  if (ownerLabel.length > 80) throw new CollabStoreError('INVALID_LABEL', 'Libellé owner trop long.');
  const plan = await planStateImport({
    cycle_id: input.cycle_id,
    markdown: input.markdown,
    directory: await loadLabelDirectory(db, ownerLabel),
    target: input.target ?? null,
  });
  if (plan.tasks.length > MAX_TASKS) {
    throw new CollabStoreError('IMPORT_TOO_MANY_TASKS', 'Au plus ' + MAX_TASKS + ' tâches par import.');
  }
  const previous = await db.prepare(
    "SELECT * FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND idempotency_key LIKE ?2 ORDER BY seq DESC LIMIT 1"
  ).bind(plan.cycle_id, STATE_IMPORT_KEY_PREFIX + plan.cycle_id + ':%').first<StoredStoreEvent>();
  if (previous && (JSON.parse(previous.payload_json) as { content_sha256?: string }).content_sha256 === plan.content_sha256) {
    // Same file as the current base: re-importing would only reset the store's later work.
    return { status: 'duplicate', event: previous, state_revision: plan.state_revision,
      content_sha256: plan.content_sha256, tasks: plan.tasks.length, dropped_tasks: [],
      issue_refs: plan.issue_refs.map(ref => ref.repository + '#' + ref.issue_number), reassigned_issues: [] };
  }
  const reassigned: string[] = [];
  for (const ref of plan.issue_refs) {
    const mapped = await db.prepare('SELECT cycle_id FROM cycle_issue_refs_v2 WHERE repository = ?1 AND issue_number = ?2')
      .bind(ref.repository, ref.issue_number).first<{ cycle_id: string }>();
    if (mapped && mapped.cycle_id !== plan.cycle_id) reassigned.push(ref.repository + '#' + ref.issue_number + ' (' + mapped.cycle_id + ')');
  }
  const existing = (await db.prepare('SELECT task_id FROM tasks WHERE cycle_id = ?1 ORDER BY task_id')
    .bind(plan.cycle_id).all<{ task_id: string }>()).results.map(row => row.task_id);
  const imported = new Set(plan.tasks.map(task => task.task_id));

  // The previous import seq is part of the key: a double submit is a duplicate,
  // while re-importing an older file after a newer one is a new owner act.
  const key = STATE_IMPORT_KEY_PREFIX + plan.cycle_id + ':' + (previous?.seq ?? 0) + ':' + plan.content_sha256.slice(0, 32);
  const result = await ownerAppend(db, {
    cycleId: plan.cycle_id,
    key,
    payload: {
      action: 'import_state',
      cycle_id: plan.cycle_id,
      workflow_id: plan.workflow_id,
      state_revision: plan.state_revision,
      content_sha256: plan.content_sha256,
      owner_label: plan.owner_label,
      target: plan.target,
      issue_refs: plan.issue_refs,
      previous_import_seq: previous?.seq ?? null,
      content: plan.content,
    },
    proof: input.proof,
    sideEffects: () => [
      db.prepare("UPDATE cycles SET phase = ?2, project = CASE WHEN project = '' THEN ?3 ELSE project END WHERE cycle_id = ?1")
        .bind(plan.cycle_id, plan.phase, plan.target?.repository ?? ''),
      db.prepare('DELETE FROM tasks WHERE cycle_id = ?1').bind(plan.cycle_id),
      ...plan.tasks.map(task => db.prepare([
        'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status,',
        '                  owned_paths, target_ref, next_action, revision)',
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, (SELECT revision FROM cycles WHERE cycle_id = ?2))",
      ].join(' ')).bind(task.task_id, plan.cycle_id, task.owner_pid, task.reviewer_pid, task.tester_pid,
        task.status, JSON.stringify(task.owned_paths), task.next_action)),
      // Issue index (C3): the cycle's previous mappings are replaced by the imported file's references.
      db.prepare('DELETE FROM cycle_issue_refs_v2 WHERE cycle_id = ?1').bind(plan.cycle_id),
      ...plan.issue_refs.map(ref => db.prepare([
        'INSERT INTO cycle_issue_refs_v2 (repository, issue_number, cycle_id) VALUES (?1, ?2, ?3)',
        'ON CONFLICT(repository, issue_number) DO UPDATE SET cycle_id = excluded.cycle_id',
      ].join(' ')).bind(ref.repository, ref.issue_number, plan.cycle_id)),
    ],
    now: input.now,
  });
  return {
    ...result,
    state_revision: plan.state_revision,
    content_sha256: plan.content_sha256,
    tasks: plan.tasks.length,
    dropped_tasks: result.status === 'applied' ? existing.filter(id => !imported.has(id)) : [],
    issue_refs: plan.issue_refs.map(ref => ref.repository + '#' + ref.issue_number),
    reassigned_issues: result.status === 'applied' ? reassigned : [],
  };
}

export interface ImportedStateSummary {
  cycle_id: string;
  state_revision: number;
  content_sha256: string;
  seq: number;
  at: number;
}

/** Latest import per cycle, for the /owner dashboard. */
export async function listImportedStates(db: D1Database, limit = 20): Promise<ImportedStateSummary[]> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    "SELECT seq, cycle_id, at, payload_json FROM events WHERE type = 'owner.decision' AND idempotency_key LIKE ?1",
    'ORDER BY seq DESC LIMIT ?2',
  ].join(' ')).bind(STATE_IMPORT_KEY_PREFIX + '%', 200).all<Pick<StoredStoreEvent, 'seq' | 'cycle_id' | 'at' | 'payload_json'>>();
  const seen = new Set<string>();
  const summaries: ImportedStateSummary[] = [];
  for (const row of results) {
    if (seen.has(row.cycle_id)) continue;
    seen.add(row.cycle_id);
    const payload = JSON.parse(row.payload_json) as { state_revision?: number; content_sha256?: string };
    summaries.push({ cycle_id: row.cycle_id, state_revision: payload.state_revision ?? 0,
      content_sha256: payload.content_sha256 ?? '', seq: row.seq, at: row.at });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

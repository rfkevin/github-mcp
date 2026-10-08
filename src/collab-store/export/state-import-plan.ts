/**
 * CC-3 C6 — pure planning of a CC-STATE-1 import (no write here).
 *
 * The write itself is an owner act (it replaces the cycle's materialized
 * tasks and sets the snapshot base), so it lives in src/collab-store/owner/
 * (the only writer of owner.decision). This module validates the document and
 * turns its Tasks table into store rows, fail-closed on unknown labels.
 */
import { StateContractError, parseRevision } from '../../collab/contracts';
import { CollabStoreError } from '../store/collab-store';
import { MAX_STATE_BYTES, findTable, getHeader, parseStateDocument, renderStateDocument, sha256Hex, type StateDocument } from './document';
import { pathsOf, resolveCell, type LabelDirectory } from './labels';

export const TASK_COLUMNS = ['id', 'status', 'owner', 'version', 'ref', 'next_action'];
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const CYCLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ExportTarget {
  repository: string;
  path: string;
  ref: string;
}

export interface PlannedTask {
  task_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  status: string;
  owned_paths: string[];
  next_action: string;
}

export interface ImportPlan {
  cycle_id: string;
  document: StateDocument;
  /** Canonical text stored as the snapshot base. */
  content: string;
  content_sha256: string;
  state_revision: number;
  workflow_id: string;
  phase: string;
  tasks: PlannedTask[];
  target: ExportTarget | null;
  owner_label: string;
}

export function parseExportTarget(repository: string, path: string, ref: string): ExportTarget | null {
  const repo = repository.trim();
  const file = path.trim().replace(/^\/+/, '');
  const branch = ref.trim() || 'main';
  if (!repo && !file) return null;
  if (!REPOSITORY_RE.test(repo) || !file || file.length > 512 || file.includes('..') || branch.length > 240) {
    throw new CollabStoreError('INVALID_EXPORT_TARGET', 'Cible d’export invalide : dépôt owner/repo et chemin relatif requis.');
  }
  return { repository: repo, path: file, ref: branch };
}

export async function planStateImport(input: {
  cycle_id: string;
  markdown: string;
  directory: LabelDirectory;
  target: ExportTarget | null;
}): Promise<ImportPlan> {
  if (!CYCLE_RE.test(input.cycle_id)) {
    throw new StateContractError('INVALID_CYCLE_ID', 'cycle_id must match [a-z0-9][a-z0-9_-]{0,63}', 'cycle_id');
  }
  if (!input.markdown.trim()) throw new CollabStoreError('STATE_REQUIRED', 'Contenu CC-STATE-1 requis.');
  if (new TextEncoder().encode(input.markdown).byteLength > MAX_STATE_BYTES) {
    throw new StateContractError('STATE_TOO_LARGE', 'State file exceeds ' + MAX_STATE_BYTES + ' bytes');
  }
  const document = parseStateDocument(input.markdown);
  const content = renderStateDocument(document);
  const table = findTable(document, 'Tasks', TASK_COLUMNS)!;
  const column = (name: string): number => table.headers.indexOf(name);
  const cell = (row: string[], name: string): string => (column(name) >= 0 ? row[column(name)] : '');

  const unknown = new Set<string>();
  const tasks: PlannedTask[] = [];
  for (const row of table.rows) {
    const taskId = cell(row, 'id');
    if (!TASK_ID_RE.test(taskId)) {
      throw new CollabStoreError('IMPORT_INVALID_TASK', 'Identifiant de tâche non importable : ' + taskId);
    }
    const pid = (name: string): string => {
      const value = cell(row, name);
      const resolved = resolveCell(input.directory, value);
      if (resolved === null) {
        unknown.add(value);
        return '';
      }
      return resolved;
    };
    tasks.push({
      task_id: taskId,
      owner_pid: pid('owner'),
      reviewer_pid: pid('reviewer'),
      tester_pid: pid('tester'),
      status: cell(row, 'status'),
      owned_paths: pathsOf(cell(row, 'owned_paths')),
      next_action: cell(row, 'next_action'),
    });
  }
  if (unknown.size) {
    throw new CollabStoreError('IMPORT_UNKNOWN_PARTICIPANT',
      'Libellés sans participant enregistré (enregistrez-les sur /owner, K6) : ' + [...unknown].sort((a, b) => a.localeCompare(b)).join(', '));
  }
  return {
    cycle_id: input.cycle_id,
    document,
    content,
    content_sha256: await sha256Hex(content),
    state_revision: parseRevision(getHeader(document, 'revision') ?? ''),
    workflow_id: getHeader(document, 'workflow_id') ?? '',
    phase: getHeader(document, 'phase') ?? '',
    tasks,
    target: input.target,
    owner_label: input.directory.ownerLabel,
  };
}

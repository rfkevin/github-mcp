/**
 * CC-3 C6 — collab_export, format cc-state-1 (read-only, never writes GitHub).
 *
 * Base = the last CC-STATE-1 file imported by the owner for the cycle
 * (owner.decision action import_state). Overlay = what the store recorded
 * after that import:
 *   - tasks changed or created by task.claim / task.status / task.handoff;
 *   - the cycle phase (policy advances, C3);
 *   - owner decisions taken on /owner (authenticated lines, I7);
 *   - evidence.add events (Evidence table).
 * Nothing else is rendered: no proposal, objection or sealed content, so the
 * export cannot reveal what P1 sealing hides.
 *
 * Without any change since the import, the export is byte-identical to the
 * imported canonical file (same revision). With changes it is the proposal of
 * revision N+1 on base N, exactly like a state PR, ready for Kevin's merge.
 * The result is validated by the L1 parser before it is returned (R1).
 */
import { assertPhase, parseRevision, StateContractError } from '../../collab/contracts';
import { CollabStoreError, type StoredStoreEvent } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import {
  appendListItems, cloneDocument, findTable, getHeader, inlineCell, parseStateDocument,
  renderStateDocument, setHeader, sha256Hex, type TableBlock,
} from './document';
import { ACTIVE_PARTICIPANTS_SQL, buildLabelDirectory, labelOf, pathsOf, resolveCell, sameList, type LabelDirectory } from './labels';
import { TASK_COLUMNS, type ExportTarget } from './state-import-plan';

export const STATE_IMPORT_KEY_PREFIX = 'owner-state-import:';

export interface ImportedState {
  event_seq: number;
  /** Store revision of the cycle right after the import event. */
  store_revision: number;
  state_revision: number;
  content: string;
  content_sha256: string;
  owner_label: string;
  target: ExportTarget | null;
}

export interface StateExport {
  cycle_id: string;
  content: string;
  content_sha256: string;
  state_revision: number;
  base_revision: number;
  changed: boolean;
  changes: { phase: boolean; tasks: string[]; owner_decisions: number; evidence: number };
  imported: { event_seq: number; state_revision: number; content_sha256: string; target: ExportTarget | null };
  store_revision: number;
  /**
   * Safe resume cursor for collab_get_delta (F4/A04): every event of the cycle
   * with seq <= last_seq is either rendered in the document or part of the
   * imported base. It stops just before the first event recorded after the
   * import whose kind the export does not render (proposal, objection,
   * request, checkpoint, memory, manual log), so a delta read from last_seq
   * never skips an event absent from the document.
   */
  last_seq: number;
  /** Highest event seq of the cycle in the snapshot (may exceed last_seq). */
  snapshot_seq: number;
}

/** Event kinds whose effect the CC-STATE-1 export materializes (tasks, phase, owner decisions, evidence). */
export const RENDERED_EVENT_TYPES = ['task.claim', 'task.status', 'task.handoff', 'evidence.add', 'owner.decision', 'phase.advance'] as const;

interface StoreTaskRow {
  task_id: string;
  owner_pid: string;
  reviewer_pid: string;
  tester_pid: string;
  status: string;
  owned_paths: string;
  next_action: string;
  revision: number;
}

type ImportRow = { seq: number; expected_rev: number; payload_json: string };

/** Latest owner import of the cycle (?1 = cycle, ?2 = idempotency key prefix). */
const LATEST_IMPORT_SQL = [
  "SELECT seq, expected_rev, payload_json FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'",
  "AND participant_id = 'owner' AND idempotency_key LIKE ?2 ORDER BY seq DESC LIMIT 1",
].join(' ');

async function importedFromRow(row: ImportRow): Promise<ImportedState> {
  const payload = JSON.parse(row.payload_json) as {
    content?: string; content_sha256?: string; state_revision?: number; owner_label?: string; target?: ExportTarget | null;
  };
  if (typeof payload.content !== 'string' || typeof payload.content_sha256 !== 'string') {
    throw new CollabStoreError('STATE_SNAPSHOT_CORRUPT', 'Import d’état illisible (seq ' + row.seq + ').');
  }
  if (await sha256Hex(payload.content) !== payload.content_sha256) {
    throw new CollabStoreError('STATE_SNAPSHOT_CORRUPT', 'Empreinte de l’état importé incohérente (seq ' + row.seq + ').');
  }
  return {
    event_seq: row.seq,
    store_revision: row.expected_rev + 1,
    state_revision: payload.state_revision ?? 0,
    content: payload.content,
    content_sha256: payload.content_sha256,
    owner_label: payload.owner_label ?? 'Kevin',
    target: payload.target ?? null,
  };
}

export async function loadImportedState(db: D1Database, cycleId: string): Promise<ImportedState | null> {
  await ensureSchema(db);
  const row = await db.prepare(LATEST_IMPORT_SQL).bind(cycleId, STATE_IMPORT_KEY_PREFIX + cycleId + ':%').first<ImportRow>();
  return row ? importedFromRow(row) : null;
}

/** Everything one export reads, taken at a single point of the store (F4/A04). */
interface ExportSnapshot {
  imported: ImportedState | null;
  directory: LabelDirectory;
  cycle: { phase: string; revision: number } | null;
  tasks: StoreTaskRow[];
  events: StoredStoreEvent[];
  requests: Map<number, StoredStoreEvent>;
  lastSeq: number;
  /** First event after the import that the export does not render (null: none). */
  firstUnrendered: number | null;
}

/**
 * F4/A04 — the export reads base import, participant directory, cycle,
 * tasks, events, referenced requests and MAX(seq) in ONE D1 batch. A batch is
 * a single SQL transaction executed without interleaving, so every value comes
 * from the same point of the store: an append, an evidence.add, a registry
 * change or an owner import lands entirely before or entirely after the
 * snapshot, never between two of its reads. The statements that depend on the
 * import read its bounds through the same subquery instead of a prior call.
 */
async function readExportSnapshot(db: D1Database, cycleId: string): Promise<ExportSnapshot> {
  await ensureSchema(db);
  const importKey = STATE_IMPORT_KEY_PREFIX + cycleId + ':%';
  const importSeq = "(SELECT seq FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND participant_id = 'owner'"
    + ' AND idempotency_key LIKE ?2 ORDER BY seq DESC LIMIT 1)';
  const importRev = "(SELECT expected_rev + 1 FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND participant_id = 'owner'"
    + ' AND idempotency_key LIKE ?2 ORDER BY seq DESC LIMIT 1)';
  const afterImport = "SELECT * FROM events WHERE cycle_id = ?1 AND seq > COALESCE(" + importSeq + ', 0)'
    + " AND type IN ('owner.decision', 'evidence.add')";
  const rendered = RENDERED_EVENT_TYPES.map(type => "'" + type + "'").join(', ');
  const [importRows, participants, cycles, tasks, events, requests, last, unrendered] = await db.batch<Record<string, unknown>>([
    db.prepare(LATEST_IMPORT_SQL).bind(cycleId, importKey),
    db.prepare(ACTIVE_PARTICIPANTS_SQL),
    db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycleId),
    db.prepare([
      'SELECT task_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, next_action, revision',
      'FROM tasks WHERE cycle_id = ?1 AND revision > COALESCE(' + importRev + ', 0) ORDER BY task_id',
    ].join(' ')).bind(cycleId, importKey),
    db.prepare(afterImport + ' ORDER BY seq').bind(cycleId, importKey),
    db.prepare([
      'SELECT r.* FROM events r WHERE r.cycle_id = ?1 AND r.seq IN (',
      "  SELECT json_extract(d.payload_json, '$.request_seq') FROM events d WHERE d.cycle_id = ?1",
      "  AND d.seq > COALESCE(" + importSeq + ", 0) AND d.type = 'owner.decision' AND json_valid(d.payload_json))",
    ].join(' ')).bind(cycleId, importKey),
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE cycle_id = ?1').bind(cycleId),
    db.prepare('SELECT MIN(seq) AS seq FROM events WHERE cycle_id = ?1 AND seq > COALESCE(' + importSeq + ', 0)'
      + ' AND type NOT IN (' + rendered + ')').bind(cycleId, importKey),
  ]);
  const importRow = importRows.results[0] as ImportRow | undefined;
  const imported = importRow ? await importedFromRow(importRow) : null;
  return {
    imported,
    directory: buildLabelDirectory(participants.results as Array<{ participant_id: string; display_label: string }>,
      imported?.owner_label),
    cycle: (cycles.results[0] as { phase: string; revision: number } | undefined) ?? null,
    tasks: tasks.results as unknown as StoreTaskRow[],
    events: events.results as unknown as StoredStoreEvent[],
    requests: new Map((requests.results as unknown as StoredStoreEvent[]).map(request => [request.seq, request])),
    lastSeq: (last.results[0] as { seq: number } | undefined)?.seq ?? 0,
    firstUnrendered: (unrendered.results[0] as { seq: number | null } | undefined)?.seq ?? null,
  };
}

function storePaths(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => inlineCell(item, 200)) : [];
  } catch {
    return [];
  }
}

/** Overlay one store task on a table row; returns true when a cell changed. */
function overlayRow(table: TableBlock, row: string[], task: StoreTaskRow, directory: LabelDirectory): boolean {
  let changed = false;
  const set = (name: string, value: string): void => {
    const index = table.headers.indexOf(name);
    if (index >= 0 && row[index] !== value) {
      row[index] = value;
      changed = true;
    }
  };
  const get = (name: string): string | undefined => {
    const index = table.headers.indexOf(name);
    return index >= 0 ? row[index] : undefined;
  };
  set('status', task.status);
  // A cell is rewritten only when it designates another participant: annotations
  // such as "Claude (for Muse Spark)" survive while the identity is unchanged.
  for (const [column, pid] of [['owner', task.owner_pid], ['reviewer', task.reviewer_pid], ['tester', task.tester_pid]] as const) {
    const current = get(column);
    if (current !== undefined && resolveCell(directory, current) !== pid) set(column, labelOf(directory, pid));
  }
  const paths = storePaths(task.owned_paths);
  const currentPaths = get('owned_paths');
  if (currentPaths !== undefined && !sameList(pathsOf(currentPaths), paths)) set('owned_paths', paths.length ? paths.join(', ') : 'none');
  // The imported cell is kept verbatim; only a value written later by an agent replaces it.
  const nextAction = get('next_action');
  if (task.next_action.trim() && nextAction !== undefined && task.next_action !== nextAction) {
    set('next_action', inlineCell(task.next_action, 2000));
  }
  return changed;
}

function newRow(table: TableBlock, task: StoreTaskRow, directory: LabelDirectory, cycleId: string): string[] {
  const paths = storePaths(task.owned_paths);
  const values: Record<string, string> = {
    id: task.task_id,
    status: task.status,
    owner: labelOf(directory, task.owner_pid),
    role: 'author',
    reviewer: labelOf(directory, task.reviewer_pid),
    tester: labelOf(directory, task.tester_pid),
    owned_paths: paths.length ? paths.join(', ') : 'none',
    dependencies: 'none',
    blocker: 'none',
    version: 'store',
    ref: 'store:' + cycleId + '#' + task.task_id,
    next_action: task.next_action.trim() ? inlineCell(task.next_action, 2000) : 'none',
  };
  return table.headers.map(header => values[header] ?? 'none');
}

function decisionLine(event: StoredStoreEvent, ownerLabel: string, requests: Map<number, StoredStoreEvent>): string | null {
  let payload: { action?: string; request_id?: string; decision?: string; request_seq?: number; proof_kind?: string };
  try {
    payload = JSON.parse(event.payload_json) as typeof payload;
  } catch {
    return null;
  }
  if (payload.action !== 'decide' || typeof payload.request_id !== 'string' || typeof payload.decision !== 'string') return null;
  const request = typeof payload.request_seq === 'number' ? requests.get(payload.request_seq) : undefined;
  const origin = request ? ', ' + request.type + ' by ' + request.participant_id + ' (seq ' + request.seq + ')' : '';
  return '- ' + ownerLabel + ', ' + new Date(event.at * 1000).toISOString().replace('.000Z', 'Z')
    + ', owner channel (/owner, proof ' + inlineCell(payload.proof_kind ?? 'unknown', 20) + ', event seq ' + event.seq + '): '
    + inlineCell(payload.decision, 20) + ' request ' + inlineCell(payload.request_id, 64) + origin + '.';
}

function evidenceRow(table: TableBlock, event: StoredStoreEvent, directory: LabelDirectory): string[] {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(event.payload_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // Not an object: rendered from the evidence_ref only.
  }
  const text = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '');
  const source = (text('source') || event.evidence_ref || 'evidence') + ' (store seq ' + event.seq + ', ' + labelOf(directory, event.participant_id) + ')';
  const state = text('state') || text('summary') || text('text') || event.evidence_ref || 'recorded';
  const values = [inlineCell(source), inlineCell(state)];
  return table.headers.map((_, index) => values[index] ?? 'n/a');
}

export async function exportCycleState(db: D1Database, cycleId: string): Promise<StateExport> {
  const snapshot = await readExportSnapshot(db, cycleId);
  const { imported, directory, cycle } = snapshot;
  if (!imported) {
    throw new CollabStoreError('NO_STATE_SNAPSHOT',
      'Aucun état CC-STATE-1 importé pour ce cycle : le propriétaire importe d’abord l’état fusionné sur /owner.');
  }
  const base = parseStateDocument(imported.content);
  const document = cloneDocument(base);
  const changes = { phase: false, tasks: [] as string[], owner_decisions: 0, evidence: 0 };

  // Phase (store-managed: C3 policy advances).
  if (cycle && cycle.phase !== getHeader(document, 'phase')) {
    try {
      assertPhase(cycle.phase);
      setHeader(document, 'phase', cycle.phase);
      changes.phase = true;
    } catch {
      // A phase unknown to CC-STATE-1 is not exported; the base phase stays.
    }
  }

  // Tasks changed or created after the import.
  const table = findTable(document, 'Tasks', TASK_COLUMNS)!;
  const tasks = snapshot.tasks;
  const idIndex = table.headers.indexOf('id');
  for (const task of tasks) {
    const row = table.rows.find(candidate => candidate[idIndex] === task.task_id);
    if (row) {
      if (overlayRow(table, row, task, directory)) changes.tasks.push(task.task_id);
    } else {
      table.rows.push(newRow(table, task, directory, cycleId));
      changes.tasks.push(task.task_id);
    }
  }

  // Owner decisions and evidence recorded after the import.
  const { events, requests } = snapshot;
  const decisionLines = events.filter(event => event.type === 'owner.decision' && event.participant_id === 'owner')
    .map(event => decisionLine(event, imported.owner_label, requests)).filter((line): line is string => line !== null);
  appendListItems(document, 'Owner decisions', decisionLines);
  changes.owner_decisions = decisionLines.length;

  const evidenceTable = findTable(document, 'Evidence', ['source', 'state']);
  const evidence = events.filter(event => event.type === 'evidence.add');
  if (evidenceTable) {
    for (const event of evidence) evidenceTable.rows.push(evidenceRow(evidenceTable, event, directory));
    changes.evidence = evidence.length;
  }

  const changed = changes.phase || changes.tasks.length > 0 || changes.owner_decisions > 0 || changes.evidence > 0;
  const baseRevision = parseRevision(getHeader(base, 'revision') ?? '');
  if (changed) {
    setHeader(document, 'revision', String(baseRevision + 1));
    setHeader(document, 'base_revision', String(baseRevision));
  }
  const content = renderStateDocument(document);
  // R1: never hand out a snapshot the L1 parser would refuse.
  try {
    parseStateDocument(content);
  } catch (error) {
    const code = error instanceof StateContractError ? error.code : 'UNKNOWN';
    throw new CollabStoreError('EXPORT_INVALID', 'Export refusé par le parser CC-STATE-1 (' + code + ').');
  }
  return {
    cycle_id: cycleId,
    content,
    content_sha256: await sha256Hex(content),
    state_revision: changed ? baseRevision + 1 : baseRevision,
    base_revision: changed ? baseRevision : parseRevision(getHeader(base, 'base_revision') ?? '1'),
    changed,
    changes,
    imported: { event_seq: imported.event_seq, state_revision: imported.state_revision,
      content_sha256: imported.content_sha256, target: imported.target },
    store_revision: cycle?.revision ?? 0,
    // Same snapshot as the content, and never a cursor covering an event absent from the document.
    last_seq: snapshot.firstUnrendered === null ? snapshot.lastSeq : Math.min(snapshot.lastSeq, snapshot.firstUnrendered - 1),
    snapshot_seq: snapshot.lastSeq,
  };
}

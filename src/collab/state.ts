import {
  assertPhase,
  assertSchemaVersion,
  assertSha,
  assertTaskStatus,
  parseRevision,
  StateContractError,
} from './contracts';
import type { MarkdownTable, Phase, RoleRecord, StateSnapshot, TaskRecord } from './contracts';

const REQUIRED_HEADERS = [
  'workflow_id',
  'revision',
  'next_action',
  'base_revision',
  'canonical_ref',
  'based_on_sha',
  'phase',
  'framing_version',
  'framing_ref',
  'plan_version',
  'plan_ref',
  'execution_ref',
  'contract_ref',
  'acceptance_ref',
] as const;

function fail(code: string, message: string, path?: string): never {
  throw new StateContractError(code, message, path);
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  const row = splitRow(line);
  return row !== null && row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseTables(lines: string[], section: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!splitRow(lines[index]) || index + 1 >= lines.length || !isSeparator(lines[index + 1])) {
      index += 1;
      continue;
    }
    const headers = splitRow(lines[index])!;
    if (headers.length === 0 || headers.some((header) => !header)) {
      fail('INVALID_TABLE', 'Table in ' + section + ' has an empty header', section);
    }
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = splitRow(lines[index]);
      if (!row) break;
      if (row.length !== headers.length) {
        fail('RAGGED_TABLE', 'Table in ' + section + ' has a row with the wrong width', section);
      }
      rows.push(row);
      index += 1;
    }
    tables.push({ headers, rows });
  }
  return tables;
}

function parseSections(lines: string[]): Record<string, MarkdownTable[]> {
  const sections: Record<string, MarkdownTable[]> = {};
  let current: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (current) sections[current] = parseTables(body, current);
    body = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      current = line.slice(3).trim();
      if (!current) fail('INVALID_SECTION', 'Section name cannot be empty');
      if (sections[current]) fail('DUPLICATE_SECTION', 'Duplicate section: ' + current, current);
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return sections;
}

function parseHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const match = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (headers[key] !== undefined) fail('DUPLICATE_CONTROL_KEY', 'Duplicate control key: ' + key, key);
    headers[key] = match[2].trim();
  }
  return headers;
}

function tableWithHeaders(snapshot: StateSnapshot, section: string, expected: string[]): MarkdownTable {
  const tables = snapshot.sections[section] ?? [];
  const table = tables.find((candidate) => expected.every((header) => candidate.headers.includes(header)));
  if (!table) fail('MISSING_TABLE', 'Section ' + section + ' is missing the required table', section);
  return table;
}

export function parseWorkflowState(content: string): StateSnapshot {
  const raw = content.replace(/\r/g, '');
  const lines = raw.split('\n');
  const firstSection = lines.findIndex((line) => line.startsWith('## '));
  const headerLines = firstSection < 0 ? lines : lines.slice(0, firstSection);
  const headers = parseHeaders(headerLines);

  for (const key of REQUIRED_HEADERS) {
    if (!headers[key]) fail('MISSING_CONTROL_KEY', 'Missing control key: ' + key, key);
  }

  const legacySchema = headers.schema_version === undefined;
  if (!legacySchema) assertSchemaVersion(headers.schema_version);
  const revision = parseRevision(headers.revision);
  const baseRevision = parseRevision(headers.base_revision, 'base_revision');
  if (baseRevision >= revision) fail('INVALID_REVISION_ORDER', 'base_revision must be lower than revision');
  assertPhase(headers.phase);
  assertSha(headers.based_on_sha, 'based_on_sha');

  const sections = parseSections(lines);
  if (!sections['Owner decisions']) fail('MISSING_SECTION', 'Owner decisions section is required', 'Owner decisions');
  const roles = tableWithHeaders({ schemaVersion: legacySchema ? 'legacy-v1' : headers.schema_version, legacySchema, headers, sections, raw }, 'Roles', ['Actor', 'Scoped acceptance/assignment', 'Pending evidence']);
  const tasks = tableWithHeaders({ schemaVersion: legacySchema ? 'legacy-v1' : headers.schema_version, legacySchema, headers, sections, raw }, 'Tasks', ['id', 'status', 'owner', 'version', 'ref', 'next_action']);

  for (const row of roles.rows) {
    if (row.some((cell) => !cell)) fail('INVALID_ROLE_ROW', 'Roles cannot contain empty cells');
  }
  for (const row of tasks.rows) {
    if (row.some((cell) => !cell)) fail('INVALID_TASK_ROW', 'Tasks cannot contain empty cells');
    assertTaskStatus(row[tasks.headers.indexOf('status')]);
  }

  void roles;
  return {
    schemaVersion: legacySchema ? 'legacy-v1' : headers.schema_version,
    legacySchema,
    headers,
    sections,
    raw,
  };
}

export function taskRecords(snapshot: StateSnapshot): TaskRecord[] {
  const table = tableWithHeaders(snapshot, 'Tasks', ['id', 'status', 'owner', 'version', 'ref', 'next_action']);
  const index = (name: string): number => table.headers.indexOf(name);
  return table.rows.map((row) => ({
    id: row[index('id')],
    status: assertTaskStatus(row[index('status')]),
    owner: row[index('owner')],
    version: row[index('version')],
    ref: row[index('ref')],
    nextAction: row[index('next_action')],
  }));
}

export function roleRecords(snapshot: StateSnapshot): RoleRecord[] {
  const table = tableWithHeaders(snapshot, 'Roles', ['Actor', 'Scoped acceptance/assignment', 'Pending evidence']);
  const index = (name: string): number => table.headers.indexOf(name);
  return table.rows.map((row) => ({
    actor: row[index('Actor')],
    assignment: row[index('Scoped acceptance/assignment')],
    pendingEvidence: row[index('Pending evidence')],
  }));
}

export interface TaskContext {
  phase: Phase;
  task: TaskRecord;
  snapshot: StateSnapshot;
}

export function deriveTaskContext(snapshot: StateSnapshot, taskId?: string): TaskContext {
  const records = taskRecords(snapshot);
  const task = taskId
    ? records.find((candidate) => candidate.id === taskId)
    : records.find((candidate) => ['accepted', 'in_progress', 'review', 'proposed'].includes(candidate.status));
  if (!task) {
    throw new StateContractError(taskId ? 'TASK_NOT_FOUND' : 'NO_ACTIONABLE_TASK', 'No actionable task was found');
  }
  return { phase: assertPhase(snapshot.headers.phase), task, snapshot };
}

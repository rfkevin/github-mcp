/**
 * CC-3 C6 — collab_export, format memory-md (read-only).
 *
 * Active memory entries rendered as deterministic Markdown for a GitHub
 * snapshot (plan §3.3). Isolation (C5 R5, §4): shared scopes (common,
 * project, role, task) plus the CALLER's own participant scope only; another
 * participant's personal memory is never exported. Facts about a participant
 * live in the evidence ledger, which this export does not read.
 */
import { ensureSchema } from '../store/schema';
import { inlineCell, sha256Hex } from './document';

export const MEMORY_FORMAT = 'CC-MEMORY-MD-1';

interface MemoryRow {
  id: string;
  version: number;
  scope: string;
  kind: string;
  text: string;
  evidence_refs: string;
  confidence: string;
  author_pid: string;
  reviewer_pid: string;
}

export interface MemoryExport {
  content: string;
  content_sha256: string;
  entries: number;
  scopes: string[];
}

function scopeRank(scope: string): number {
  if (scope === 'common') return 0;
  if (scope === 'project' || scope.startsWith('project:')) return 1;
  if (scope.startsWith('role:')) return 2;
  if (scope.startsWith('participant:')) return 3;
  if (scope.startsWith('task:')) return 4;
  return 5;
}

function visible(scope: string, participantId: string | null): boolean {
  if (scope.startsWith('participant:')) return participantId !== null && scope === 'participant:' + participantId;
  return true;
}

function refs(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** participantId = the caller's server-derived id, or null for an unregistered client. */
export async function exportMemoryMarkdown(db: D1Database, participantId: string | null): Promise<MemoryExport> {
  await ensureSchema(db);
  const { results } = await db.prepare([
    'SELECT id, version, scope, kind, text, evidence_refs, confidence, author_pid, reviewer_pid',
    "FROM memory_entries WHERE status = 'active'",
  ].join(' ')).all<MemoryRow>();
  const rows = results.filter(row => visible(row.scope, participantId)).sort((a, b) =>
    scopeRank(a.scope) - scopeRank(b.scope) || a.scope.localeCompare(b.scope)
    || a.id.localeCompare(b.id) || a.version - b.version);
  const lines = ['# CC-3 memory export', 'format: ' + MEMORY_FORMAT, 'entries: ' + rows.length];
  let scope = '';
  for (const row of rows) {
    if (row.scope !== scope) {
      scope = row.scope;
      lines.push('', '## ' + inlineCell(scope, 160));
    }
    const evidence = refs(row.evidence_refs);
    lines.push('- [' + inlineCell(row.kind, 40) + ' · ' + inlineCell(row.confidence, 40) + '] ' + inlineCell(row.text, 600)
      + ' — ' + inlineCell(row.id, 80) + ' v' + row.version
      + '; author ' + inlineCell(row.author_pid, 128) + (row.reviewer_pid ? ', reviewer ' + inlineCell(row.reviewer_pid, 128) : '')
      + (evidence.length ? '; evidence ' + evidence.map(ref => inlineCell(ref, 200)).join(', ') : ''));
  }
  const content = lines.join('\n') + '\n';
  return {
    content,
    content_sha256: await sha256Hex(content),
    entries: rows.length,
    scopes: [...new Set(rows.map(row => row.scope))],
  };
}

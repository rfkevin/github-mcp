/**
 * CC-3 C6 — mapping between the display labels of a state file and the
 * server-derived participant ids of the store (I8: labels are display only).
 *
 * A state cell such as "Claude (for Muse Spark)" resolves through its leading
 * label ("Claude"); the annotation is kept verbatim in the document and never
 * becomes an identity. "none" (or "-") means no participant. The owner label
 * (Kevin by default) resolves to the reserved id `owner`.
 */
import { ensureSchema } from '../store/schema';

export const OWNER_PID = 'owner';
export const DEFAULT_OWNER_LABEL = 'Kevin';
const NONE = /^(none|-|—|n\/a)$/i;

export interface LabelDirectory {
  ownerLabel: string;
  byLabel: Map<string, string>;
  byPid: Map<string, string>;
  /** Labels carried by several active participants (or by a participant and the owner): never resolved (I8). */
  ambiguous: Set<string>;
}

/** Active participants, the only rows a label may resolve to (read alone or inside an export snapshot batch). */
export const ACTIVE_PARTICIPANTS_SQL =
  "SELECT participant_id, display_label FROM participants WHERE status = 'active' ORDER BY participant_id";

export async function loadLabelDirectory(db: D1Database, ownerLabel = DEFAULT_OWNER_LABEL): Promise<LabelDirectory> {
  await ensureSchema(db);
  const { results } = await db.prepare(ACTIVE_PARTICIPANTS_SQL).all<{ participant_id: string; display_label: string }>();
  return buildLabelDirectory(results, ownerLabel);
}

export function buildLabelDirectory(rows: ReadonlyArray<{ participant_id: string; display_label: string }>,
  ownerLabel = DEFAULT_OWNER_LABEL): LabelDirectory {
  const byLabel = new Map<string, string>();
  const byPid = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    byPid.set(row.participant_id, row.display_label);
    if (byLabel.has(row.display_label) || row.display_label === ownerLabel) ambiguous.add(row.display_label);
    else byLabel.set(row.display_label, row.participant_id);
  }
  for (const label of ambiguous) byLabel.delete(label);
  return { ownerLabel, byLabel, byPid, ambiguous };
}

/** Leading label of a cell, without a trailing parenthesised annotation. */
export function leadingLabel(cell: string): string {
  const value = cell.trim();
  if (value.endsWith(')')) {
    const open = value.lastIndexOf('(');
    if (open > 0) return value.slice(0, open).trim();
  }
  return value;
}

/** '' = no participant; null = label unknown to the registry or ambiguous. */
export function resolveCell(directory: LabelDirectory, cell: string): string | null {
  const label = leadingLabel(cell);
  if (!label || NONE.test(label)) return '';
  if (directory.ambiguous.has(label)) return null;
  if (label === directory.ownerLabel) return OWNER_PID;
  if (directory.byLabel.has(label)) return directory.byLabel.get(label)!;
  if (directory.byPid.has(label)) return label;
  return null;
}

export function labelOf(directory: LabelDirectory, pid: string): string {
  if (!pid) return 'none';
  if (pid === OWNER_PID) return directory.ownerLabel;
  return directory.byPid.get(pid) ?? pid;
}

export function pathsOf(cell: string): string[] {
  const value = cell.trim();
  if (!value || NONE.test(value)) return [];
  return value.split(/,\s+/).map(item => item.trim()).filter(Boolean);
}

export function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

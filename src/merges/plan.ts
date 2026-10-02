import { InputValidationError, type GitHubTreeEntry } from '../github/types';
import { SENSITIVE_FILE, MAX_FILE_BYTES } from '../github/files';
import { assertWritablePath } from '../security/policy';

export type MergeEntry = GitHubTreeEntry & { path: string; sha: string; type: string; mode: string };
export type MergeRow = { path: string; ancestor?: MergeEntry; ours?: MergeEntry; theirs?: MergeEntry; conflict: boolean; blocked: boolean };
export type MergePlan = { rows: MergeRow[]; updates: Map<string, MergeEntry | undefined> };
export const sameEntry = (a?: MergeEntry, b?: MergeEntry) => a?.sha === b?.sha && a?.mode === b?.mode && a?.type === b?.type;

export function mergeTree(tree: { truncated: boolean; tree: GitHubTreeEntry[] }): Map<string, MergeEntry> {
  if (tree.truncated !== false || tree.tree.length > 20_000) throw new InputValidationError('Arbre incomplet ou trop grand : résolution refusée.', 'MERGE_TREE_INCOMPLETE');
  const files = new Map<string, MergeEntry>();
  for (const entry of tree.tree) {
    if (!entry.path || !entry.sha || !/^[a-f0-9]{40}$/i.test(entry.sha) || !entry.type || !entry.mode || files.has(entry.path)) {
      throw new InputValidationError('Arbre Git invalide : résolution refusée.', 'MERGE_TREE_INVALID');
    }
    files.set(entry.path, entry as MergeEntry);
  }
  return files;
}

/** Conservative three-way merge of entries; divergent edits of one file need an explicit choice. */
export function planMerge(ancestor: Map<string, MergeEntry>, ours: Map<string, MergeEntry>, theirs: Map<string, MergeEntry>): MergePlan {
  const updates = new Map<string, MergeEntry | undefined>(), rows: MergeRow[] = [];
  const paths = new Set([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of [...paths].sort((left, right) => left.localeCompare(right, 'en'))) {
    const a = ancestor.get(path), o = ours.get(path), t = theirs.get(path);
    // Directory hashes change with their children: merge only leaves. Type changes require human handling.
    if ([a, o, t].some(entry => entry?.type === 'tree')) {
      if ([a, o, t].some(entry => entry && entry.type !== 'tree')) {
        rows.push({ path, ancestor: a, ours: o, theirs: t, conflict: true, blocked: true });
      }
      continue;
    }
    if (sameEntry(o, t) || sameEntry(a, t)) continue;
    const conflict = !sameEntry(a, o);
    let blocked = false;
    try { assertWritablePath(path); } catch { blocked = true; }
    if (SENSITIVE_FILE.test(path) || [a, o, t].some(entry => entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)))) blocked = true;
    rows.push({ path, ancestor: a, ours: o, theirs: t, conflict, blocked });
    if (!conflict) updates.set(path, t);
  }
  if (rows.length > 50) throw new InputValidationError('Plus de 50 fichiers concernés : résolution humaine requise.', 'MERGE_TOO_LARGE');
  return { rows, updates };
}

export function assertMergeEntrySize(entry?: MergeEntry): void {
  if (entry && (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > MAX_FILE_BYTES)) {
    throw new InputValidationError('Fichier trop grand ou taille inconnue : résolution refusée.', 'MERGE_FILE_TOO_LARGE');
  }
}

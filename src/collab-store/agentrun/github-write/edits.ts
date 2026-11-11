import { ToolRefused } from '../engine';

/** Literal, exactly-once replacement. No regex or shell supplied by the model. */
export function replaceOnce(content: string, oldText: unknown, newText: unknown): string {
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string'
    || oldText.length > 100_000 || newText.length > 100_000) throw new ToolRefused('api_edit_invalid');
  const index = content.indexOf(oldText);
  if (index < 0 || content.indexOf(oldText, index + 1) >= 0) throw new ToolRefused('api_edit_not_unique');
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

/** CC8 U2a (C1) : plafond d'éditions littérales regroupées dans UN seul commit. */
export const MAX_EDITS = 5;
export interface EditSpec { path: string; expected_sha: string; old_text: string; new_text: string }

/**
 * Une édition (champs historiques path, expected_sha, old_text, new_text) ou un tableau `edits`,
 * jamais les deux. Plusieurs éditions = un seul commit : reserveCommit n'autorise un 2e commit qu'après
 * une CI rouge, donc des éditions successives avant la CI sont refusées ; on les regroupe.
 * Refus typés, aucun effet externe. Les chemins sont ensuite contrôlés par assertPaths.
 */
export function normalizeEdits(args: Record<string, unknown>): EditSpec[] {
  const legacy = ['path', 'expected_sha', 'old_text', 'new_text'].some(key => args[key] !== undefined);
  if (args.edits !== undefined && legacy) throw new ToolRefused('api_edit_ambiguous');
  if (args.edits === undefined && typeof args.path !== 'string') throw new ToolRefused('api_edit_unavailable');
  const list: unknown = args.edits === undefined
    ? [{ path: args.path, expected_sha: args.expected_sha, old_text: args.old_text, new_text: args.new_text }] : args.edits;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_EDITS) throw new ToolRefused('api_edit_count_invalid');
  const seen = new Set<string>();
  return list.map((item: unknown) => {
    const edit = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof edit.path !== 'string' || typeof edit.expected_sha !== 'string'
      || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') throw new ToolRefused('api_edit_invalid');
    if (seen.has(edit.path)) throw new ToolRefused('api_edit_duplicate_path');
    seen.add(edit.path);
    return { path: edit.path, expected_sha: edit.expected_sha, old_text: edit.old_text, new_text: edit.new_text };
  });
}

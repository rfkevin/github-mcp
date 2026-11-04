import { ToolRefused } from '../engine';

/** Literal, exactly-once replacement. No regex or shell supplied by the model. */
export function replaceOnce(content: string, oldText: unknown, newText: unknown): string {
  if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string'
    || oldText.length > 100_000 || newText.length > 100_000) throw new ToolRefused('api_edit_invalid');
  const index = content.indexOf(oldText);
  if (index < 0 || content.indexOf(oldText, index + 1) >= 0) throw new ToolRefused('api_edit_not_unique');
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

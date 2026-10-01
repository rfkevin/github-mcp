import { InputValidationError } from './github/types';
import { MAX_FILE_BYTES } from './github/files';

export const AGENT_MEMORY_PATH = 'AGENT_MEMORY.md';
export const TOOL_IMPROVEMENTS_PATH = 'TOOL_IMPROVEMENTS.md';
export const APPEND_ONLY_PATHS = [AGENT_MEMORY_PATH, TOOL_IMPROVEMENTS_PATH] as const;

/** Compare les octets du blob immuable, sans normaliser Unicode, BOM ou fins de ligne. */
export function assertMemoryAppend(blob: { content: string; encoding: string; size: number }, content: string, path: string = AGENT_MEMORY_PATH): void {
  const code = path === TOOL_IMPROVEMENTS_PATH ? 'FEEDBACK' : 'MEMORY';
  if (blob.encoding !== 'base64' || !Number.isSafeInteger(blob.size) || blob.size < 0 ||
    blob.size > MAX_FILE_BYTES || blob.content.length > Math.ceil(MAX_FILE_BYTES * 1.4)) {
    throw new InputValidationError('Journal illisible : ajout refusé.', `${code}_UNREADABLE`);
  }
  let previous: string;
  try { previous = atob(blob.content.replace(/\s/g, '')); }
  catch { throw new InputValidationError('Journal illisible : ajout refusé.', `${code}_UNREADABLE`); }
  if (previous.length !== blob.size) {
    throw new InputValidationError('Journal incomplet : ajout refusé.', `${code}_UNREADABLE`);
  }
  const next = new TextEncoder().encode(content);
  if (next.length < previous.length) rejectMemoryRewrite(path);
  for (let i = 0; i < previous.length; i++) {
    if (next[i] !== previous.charCodeAt(i)) rejectMemoryRewrite(path);
  }
}

export function rejectMemoryRewrite(path: string = AGENT_MEMORY_PATH): never {
  throw new InputValidationError(`${path} est un journal en ajout seul : conserver le contenu existant et ajouter une note à la fin.`,
    path === TOOL_IMPROVEMENTS_PATH ? 'FEEDBACK_APPEND_ONLY' : 'MEMORY_APPEND_ONLY');
}

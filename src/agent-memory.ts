import { InputValidationError } from './github/types';
import { MAX_FILE_BYTES } from './github/files';

export const AGENT_MEMORY_PATH = 'AGENT_MEMORY.md';

/** Compare les octets du blob immuable, sans normaliser Unicode, BOM ou fins de ligne. */
export function assertMemoryAppend(blob: { content: string; encoding: string; size: number }, content: string): void {
  if (blob.encoding !== 'base64' || !Number.isSafeInteger(blob.size) || blob.size < 0 ||
    blob.size > MAX_FILE_BYTES || blob.content.length > Math.ceil(MAX_FILE_BYTES * 1.4)) {
    throw new InputValidationError('Mémoire illisible : ajout refusé.', 'MEMORY_UNREADABLE');
  }
  let previous: string;
  try { previous = atob(blob.content.replace(/\s/g, '')); }
  catch { throw new InputValidationError('Mémoire illisible : ajout refusé.', 'MEMORY_UNREADABLE'); }
  if (previous.length !== blob.size) {
    throw new InputValidationError('Mémoire incomplète : ajout refusé.', 'MEMORY_UNREADABLE');
  }
  const next = new TextEncoder().encode(content);
  if (next.length < previous.length) rejectMemoryRewrite();
  for (let i = 0; i < previous.length; i++) {
    if (next[i] !== previous.charCodeAt(i)) rejectMemoryRewrite();
  }
}

export function rejectMemoryRewrite(): never {
  throw new InputValidationError('AGENT_MEMORY.md est un journal en ajout seul : conserver le contenu existant et ajouter une note à la fin.', 'MEMORY_APPEND_ONLY');
}

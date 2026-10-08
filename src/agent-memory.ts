import { InputValidationError } from './github/types';
import { MAX_FILE_BYTES } from './github/files';

export const AGENT_MEMORY_PATH = 'AGENT_MEMORY.md';
export const TOOL_IMPROVEMENTS_PATH = 'TOOL_IMPROVEMENTS.md';
export const APPEND_ONLY_PATHS = [AGENT_MEMORY_PATH, TOOL_IMPROVEMENTS_PATH] as const;

export type JournalBlob = { content: string; encoding: string; size: number };

/** Octets exacts du blob immuable, sans normaliser Unicode, BOM ou fins de ligne. */
function journalBytes(blob: JournalBlob, path: string): Uint8Array {
  const code = path === TOOL_IMPROVEMENTS_PATH ? 'FEEDBACK' : 'MEMORY';
  if (blob.encoding !== 'base64' || !Number.isSafeInteger(blob.size) || blob.size < 0 ||
    blob.size > MAX_FILE_BYTES || blob.content.length > Math.ceil(MAX_FILE_BYTES * 1.4)) {
    throw new InputValidationError('Journal illisible : ajout refusé.', `${code}_UNREADABLE`);
  }
  let binary: string;
  try { binary = atob(blob.content.replace(/\s/g, '')); }
  catch { throw new InputValidationError('Journal illisible : ajout refusé.', `${code}_UNREADABLE`); }
  if (binary.length !== blob.size) {
    throw new InputValidationError('Journal incomplet : ajout refusé.', `${code}_UNREADABLE`);
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function startsWithAt(bytes: Uint8Array, prefix: Uint8Array, offset = 0): boolean {
  if (bytes.length - offset < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[offset + i] !== prefix[i]) return false;
  }
  return true;
}

const LINE_BREAK = new Set([0x0a, 0x0d]);
function skipLineBreaks(bytes: Uint8Array, offset: number): number {
  while (offset < bytes.length && LINE_BREAK.has(bytes[offset])) offset += 1;
  return offset;
}

/** Compare les octets du blob immuable, sans normaliser Unicode, BOM ou fins de ligne. */
export function assertMemoryAppend(blob: JournalBlob, content: string, path: string = AGENT_MEMORY_PATH): void {
  const previous = journalBytes(blob, path);
  if (!startsWithAt(new TextEncoder().encode(content), previous)) rejectMemoryRewrite(path);
}

/**
 * Journal résolu lors d'une fusion (github_resolve_conflicts), comparé octet par octet.
 * Accepté si ours et theirs sont tous deux des préfixes du résultat (cas d'un seul côté modifié),
 * ou si les deux côtés ont chacun ajouté une note depuis l'ancêtre et que :
 * - theirs (la base reprise) reste un préfixe exact du résultat ;
 * - l'ajout de la branche (ours privé de l'ancêtre, sauts de ligne de tête ignorés) suit, au plus
 *   précédé de sauts de ligne ; d'autres notes peuvent ensuite être ajoutées à la fin.
 * Aucune ligne existante ne peut donc disparaître, et la fusion ultérieure de la branche vers sa base
 * reste un ajout pur, comme l'exige l'intégration.
 */
export function assertMergedJournal(path: string, content: string,
  sides: { ancestor?: JournalBlob; ours?: JournalBlob; theirs?: JournalBlob }): void {
  const next = new TextEncoder().encode(content);
  const ours = sides.ours ? journalBytes(sides.ours, path) : undefined;
  const theirs = sides.theirs ? journalBytes(sides.theirs, path) : undefined;
  if ((!ours || startsWithAt(next, ours)) && (!theirs || startsWithAt(next, theirs))) return;
  if (!ours || !theirs || !sides.ancestor || !startsWithAt(next, theirs)) rejectMergedJournal(path);
  const ancestor = journalBytes(sides.ancestor, path);
  if (!startsWithAt(ours, ancestor) || !startsWithAt(theirs, ancestor)) rejectMergedJournal(path);
  const added = ours.subarray(skipLineBreaks(ours, ancestor.length));
  if (added.length === 0 || !startsWithAt(next, added, skipLineBreaks(next, theirs.length))) rejectMergedJournal(path);
}

export function rejectMemoryRewrite(path: string = AGENT_MEMORY_PATH): never {
  throw new InputValidationError(`${path} est un journal en ajout seul : conserver le contenu existant et ajouter une note à la fin.`,
    path === TOOL_IMPROVEMENTS_PATH ? 'FEEDBACK_APPEND_ONLY' : 'MEMORY_APPEND_ONLY');
}

function rejectMergedJournal(path: string): never {
  throw new InputValidationError(`${path} est un journal en ajout seul : pour une fusion, garder la version de la base (theirs) intacte au début, ` +
    'puis recopier à la suite l’ajout de la branche (ours moins l’ancêtre), puis éventuellement une nouvelle note.',
  path === TOOL_IMPROVEMENTS_PATH ? 'FEEDBACK_APPEND_ONLY' : 'MEMORY_APPEND_ONLY');
}

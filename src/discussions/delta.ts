/**
 * Moteur de delta des discussions GitHub : éléments nouveaux, modifiés et supprimés depuis une
 * lecture précédente, sans état côté serveur. L'état tient dans un curseur opaque.
 *
 * Module pur : aucun accès réseau, aucun import du projet. Il ne dépend d'aucune garantie de GitHub
 * (ni `updated_at`, ni paramètre `since`, ni ordre des identifiants) : un élément est « modifié »
 * quand l'empreinte de son contenu masqué change, « nouveau » quand son identifiant est inconnu,
 * « supprimé » quand il manque dans deux énumérations consécutives.
 */

export const DELTA_CURSOR_VERSION = 1;
/** Nombre maximal d'éléments suivis par un curseur : les plus récents par (date de création, id). */
export const MAX_TRACKED_ITEMS = 300;

const MAGIC = 0xd4;
const FINGERPRINT_CHARS = 8; // 8 caractères base64url = 6 octets exactement, sans remplissage
const MAX_CURSOR_CHARS = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export type DeltaErrorCode = 'INVALID_CURSOR' | 'FOREIGN_CURSOR' | 'CURSOR_STALE';

export class DeltaError extends Error {
  constructor(readonly code: DeltaErrorCode, message: string) {
    super(message);
    this.name = 'DeltaError';
  }
}

/** Ce à quoi un curseur est lié : un curseur ne s'applique jamais à une autre cible. */
export type DeltaScope = {
  repository: string;
  kind: string;
  /** Numéro d'issue ou de PR, ou référence de commit, selon le `kind`. */
  target: string;
  /** Version du masquage : des empreintes de versions différentes ne sont pas comparables. */
  maskingVersion: string;
};

/**
 * Entrée de l'énumération complète d'une discussion. `revision` est une empreinte base64url du
 * contenu masqué complet (au moins 8 caractères : seuls les 8 premiers sont conservés).
 */
export type SnapshotItem = { id: number; createdAt: string; revision: string };

export type DeltaResult<T extends SnapshotItem> = {
  added: T[];
  modified: T[];
  /** Identifiants confirmés absents de deux énumérations consécutives. */
  deleted: number[];
  /** Éléments suivis dont le contenu masqué est inchangé. */
  unchanged: number;
  /** Éléments plus anciens que la fenêtre suivie : ni modifications ni suppressions visibles. */
  olderUntracked: number;
  /** Doublons d'identifiant ignorés dans les énumérations (pagination GitHub qui bouge). */
  duplicatesIgnored: number;
  /** Une seconde énumération a été nécessaire pour confirmer une suppression. */
  reenumerated: boolean;
  /** Changements non rapportés faute de place : ils reviendront avec `nextCursor`, rien n'est perdu. */
  deferred: number;
  hasMore: boolean;
  nextCursor: string;
};

export type DeltaOptions = {
  /** Nombre maximal de nouveaux + modifiés rapportés par appel (au moins 1). */
  maxReported?: number;
};

type Key = { seconds: number; id: number };
type Prepared<T extends SnapshotItem> = Key & { item: T; fingerprint: string };
type State = { start: Key; tracked: Map<number, string> };

const compareKey = (a: Key, b: Key): number => a.seconds - b.seconds || a.id - b.id;

function checkScope(scope: DeltaScope): void {
  const valid = scope.repository.length >= 3 && scope.repository.length <= 200
    && /^[a-z][a-z0-9_]{0,39}$/.test(scope.kind)
    && scope.target.length >= 1 && scope.target.length <= 100
    && /^[A-Za-z0-9._-]{1,40}$/.test(scope.maskingVersion);
  if (!valid) throw new TypeError('Portée de curseur invalide.');
}

function prepare<T extends SnapshotItem>(snapshot: readonly T[]): { items: Map<number, Prepared<T>>; duplicatesIgnored: number } {
  const items = new Map<number, Prepared<T>>();
  let duplicatesIgnored = 0;
  for (const item of snapshot) {
    const seconds = Math.floor(Date.parse(item.createdAt) / 1000);
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(seconds) || seconds < 0
      || !/^[A-Za-z0-9_-]{8,}$/.test(item.revision)) {
      throw new TypeError('Élément d’énumération invalide.');
    }
    if (items.has(item.id)) duplicatesIgnored += 1;
    // Le dernier exemplaire lu est le plus récent : il remplace le précédent.
    items.set(item.id, { item, id: item.id, seconds, fingerprint: item.revision.slice(0, FINGERPRINT_CHARS) });
  }
  return { items, duplicatesIgnored };
}

/** Empreinte de 6 octets (8 caractères base64url) tirée des 12 premiers caractères d'un SHA-256 en hexadécimal. */
export function fingerprintFromHex(hex: string): string {
  if (!/^[0-9a-f]{12,}$/.test(hex)) throw new TypeError('Empreinte hexadécimale invalide.');
  const bytes: number[] = [];
  for (let index = 0; index < 6; index += 1) bytes.push(Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  return toBase64Url(bytes);
}

// --- Encodage binaire ------------------------------------------------------------------------

function writeVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 128) {
    out.push((rest % 128) | 128);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

function writeString(out: number[], value: string): void {
  const bytes = encoder.encode(value);
  writeVarint(out, bytes.length);
  for (const byte of bytes) out.push(byte);
}

const invalid = (): DeltaError => new DeltaError('INVALID_CURSOR',
  'Curseur corrompu ou tronqué. Relire l’index pour en obtenir un nouveau.');

class Reader {
  position = 0;
  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.position >= this.bytes.length) throw invalid();
    return this.bytes[this.position++];
  }

  varint(): number {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 127) * multiplier;
      if (byte < 128) {
        if (!Number.isSafeInteger(value)) throw invalid();
        return value;
      }
      multiplier *= 128;
    }
    throw invalid();
  }

  string(): string {
    const length = this.varint();
    if (length > 200 || this.position + length > this.bytes.length) throw invalid();
    const slice = this.bytes.slice(this.position, this.position + length);
    this.position += length;
    try { return decoder.decode(slice); } catch { throw invalid(); }
  }

  fingerprint(): string {
    if (this.position + 6 > this.bytes.length) throw invalid();
    const slice = this.bytes.slice(this.position, this.position + 6);
    this.position += 6;
    return toBase64Url(slice);
  }
}

function toBase64Url(bytes: ArrayLike<number>): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (text.length === 0 || text.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw invalid();
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try { binary = atob(padded); } catch { throw invalid(); }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** FNV-1a 32 bits : détecte une copie défectueuse du curseur, ce n'est pas une signature. */
function checksum(bytes: ArrayLike<number>, length: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function encodePrepared<T extends SnapshotItem>(scope: DeltaScope, items: Iterable<Prepared<T>>): string {
  checkScope(scope);
  const tracked = [...items].sort(compareKey).slice(-MAX_TRACKED_ITEMS);
  const start: Key = tracked.length > 0 ? { seconds: tracked[0].seconds, id: tracked[0].id } : { seconds: 0, id: 0 };
  const out: number[] = [MAGIC, DELTA_CURSOR_VERSION];
  writeString(out, scope.repository.toLowerCase());
  writeString(out, scope.kind);
  writeString(out, scope.target);
  writeString(out, scope.maskingVersion);
  writeVarint(out, start.seconds);
  writeVarint(out, start.id);
  writeVarint(out, tracked.length);
  let previous = 0;
  for (const entry of [...tracked].sort((a, b) => a.id - b.id)) {
    writeVarint(out, entry.id - previous);
    previous = entry.id;
    for (const byte of fromBase64Url(entry.fingerprint)) out.push(byte);
  }
  const sum = checksum(out, out.length);
  out.push((sum >>> 24) & 255, (sum >>> 16) & 255, (sum >>> 8) & 255, sum & 255);
  return toBase64Url(out);
}

/** Curseur de départ : à émettre avec la lecture complète de l'index. */
export function encodeCursor<T extends SnapshotItem>(scope: DeltaScope, snapshot: readonly T[]): string {
  return encodePrepared(scope, prepare(snapshot).items.values());
}

function decodeCursor(cursor: string, scope: DeltaScope): State {
  checkScope(scope);
  const bytes = fromBase64Url(cursor);
  if (bytes.length < 10) throw invalid();
  const body = bytes.length - 4;
  const expected = ((bytes[body] << 24) | (bytes[body + 1] << 16) | (bytes[body + 2] << 8) | bytes[body + 3]) >>> 0;
  if (checksum(bytes, body) !== expected) throw invalid();
  const reader = new Reader(bytes.slice(0, body));
  if (reader.byte() !== MAGIC) throw invalid();
  if (reader.byte() !== DELTA_CURSOR_VERSION) {
    throw new DeltaError('CURSOR_STALE', 'Ce curseur vient d’une autre version du service. Relire l’index pour en obtenir un nouveau.');
  }
  const repository = reader.string();
  const kind = reader.string();
  const target = reader.string();
  if (repository !== scope.repository.toLowerCase() || kind !== scope.kind || target !== scope.target) {
    throw new DeltaError('FOREIGN_CURSOR', 'Ce curseur appartient à une autre discussion.');
  }
  if (reader.string() !== scope.maskingVersion) {
    throw new DeltaError('CURSOR_STALE', 'Les règles de masquage ont changé depuis ce curseur. Relire l’index pour en obtenir un nouveau.');
  }
  const start: Key = { seconds: reader.varint(), id: reader.varint() };
  const count = reader.varint();
  if (count > MAX_TRACKED_ITEMS) throw invalid();
  const tracked = new Map<number, string>();
  let id = 0;
  for (let index = 0; index < count; index += 1) {
    const delta = reader.varint();
    if (index > 0 && delta === 0) throw invalid();
    id += delta;
    if (id <= 0 || !Number.isSafeInteger(id)) throw invalid();
    tracked.set(id, reader.fingerprint());
  }
  if (reader.position !== body) throw invalid();
  return { start, tracked };
}

// --- Calcul du delta -------------------------------------------------------------------------

function diff<T extends SnapshotItem>(state: State, items: Map<number, Prepared<T>>) {
  const added: Prepared<T>[] = [];
  const modified: Prepared<T>[] = [];
  let unchanged = 0;
  let olderUntracked = 0;
  for (const entry of items.values()) {
    const known = state.tracked.get(entry.id);
    if (known !== undefined) {
      if (known === entry.fingerprint) unchanged += 1; else modified.push(entry);
    } else if (compareKey(entry, state.start) >= 0) added.push(entry);
    else olderUntracked += 1;
  }
  const missing = [...state.tracked.keys()].filter(id => !items.has(id)).sort((a, b) => a - b);
  return { added: added.sort(compareKey), modified: modified.sort(compareKey), unchanged, olderUntracked, missing };
}

/**
 * Compare l'énumération complète courante au curseur. Une suppression n'est rapportée que si
 * `reenumerate` (une seconde lecture complète, appelée seulement quand un élément manque) ne le
 * retrouve pas non plus : un élément raté par une pagination qui bouge n'est donc jamais déclaré
 * supprimé. Le curseur suivant est construit sur l'union des deux lectures : un élément vu dans
 * l'une des deux reste suivi, et sa disparition éventuelle est rapportée au delta suivant.
 *
 * Quand il y a plus de changements que `maxReported`, les modifications des éléments déjà suivis
 * passent en premier, puis les nouveaux dans l'ordre chronologique. Le curseur suivant n'acquitte
 * pas le reste : un nouvel élément non rapporté est absent du curseur, un élément modifié non
 * rapporté garde son ancienne empreinte, donc les deux reviennent au prochain appel.
 */
export async function computeDelta<T extends SnapshotItem>(
  cursor: string,
  scope: DeltaScope,
  snapshot: readonly T[],
  reenumerate: () => Promise<readonly T[]>,
  options: DeltaOptions = {},
): Promise<DeltaResult<T>> {
  const maxReported = options.maxReported ?? Number.POSITIVE_INFINITY;
  if (!(maxReported >= 1)) throw new TypeError('maxReported doit valoir au moins 1.');
  const state = decodeCursor(cursor, scope);
  const first = prepare(snapshot);
  let items = first.items;
  let duplicatesIgnored = first.duplicatesIgnored;
  let reenumerated = false;
  if (state.tracked.size > 0 && [...state.tracked.keys()].some(id => !items.has(id))) {
    const second = prepare(await reenumerate());
    reenumerated = true;
    duplicatesIgnored += second.duplicatesIgnored;
    items = new Map(first.items);
    for (const [id, entry] of second.items) items.set(id, entry);
  }
  const result = diff(state, items);
  const modified = result.modified.slice(0, maxReported);
  const added = result.added.slice(0, Math.max(0, maxReported - modified.length));
  const deferredModified = result.modified.slice(modified.length);
  const deferredAdded = result.added.slice(added.length);
  const acknowledged = new Map(items);
  for (const entry of deferredAdded) acknowledged.delete(entry.id);
  for (const entry of deferredModified) {
    acknowledged.set(entry.id, { ...entry, fingerprint: state.tracked.get(entry.id) as string });
  }
  const deferred = deferredAdded.length + deferredModified.length;
  return {
    added: added.map(entry => entry.item),
    modified: modified.map(entry => entry.item),
    deleted: result.missing,
    unchanged: result.unchanged,
    olderUntracked: result.olderUntracked,
    duplicatesIgnored,
    reenumerated,
    deferred,
    hasMore: deferred > 0,
    nextCursor: encodePrepared(scope, acknowledged.values()),
  };
}

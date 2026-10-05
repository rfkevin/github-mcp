import { StateContractError } from './contracts';

export const CHECKPOINT_VERSION = 1;

/** Bornes du checkpoint portable : compact, transmissible entre chats. */
export const MAX_TRACKED_SOURCES = 200;
export const MAX_CHECKPOINT_CHARS = 16_384;

/** Limite contractuelle jamais effacée : les suppressions ne sont visibles que dans la fenêtre suivie. */
export const DELETION_TRACKING_LIMITATION =
  'Deletions are only detectable inside the tracked enumeration window: a tracked source absent from the current enumeration requires an explicit rescan before its absence is treated as fact.';

export type CheckpointScope = {
  repository: string;
  ref: string;
  /** SHA immuable résolu une seule fois par lecture cohérente. */
  sha: string;
  /** Version du masquage : des empreintes de versions différentes ne sont pas comparables. */
  maskingVersion: string;
};

export type SourceCoverage = {
  location: string;
  /** Empreinte du contenu observé ; jamais un simple lastSeen{id, updatedAt}. */
  fingerprint: string;
  /** true uniquement si le corps a été lu intégralement à cette empreinte. */
  readComplete: boolean;
  /** updatedAt observé lors de la lecture : informatif, jamais une preuve de non-changement. */
  observedAt: string;
  /** Suite de lecture pour une source partielle : offset et revision de continuation. */
  continuation?: { offset: number; revision: string };
  /** Source marquée proposition de pair : exclue en P1 jusqu'à la phase permise. */
  peerProposal?: boolean;
};

export type ReadingCheckpoint = {
  v: typeof CHECKPOINT_VERSION;
  scope: CheckpointScope;
  stateRevision: number;
  sources: SourceCoverage[];
  createdAt: string;
};

export type SourceObservation = { id: number; fingerprint: string };

export type CoverageDiff = {
  changed: number[];
  missing: number[];
  rescanRequired: boolean;
  unchanged: number;
};

const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const encoder = new TextEncoder();

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Empreinte FNV-1a 48 bits du contenu tel que lu : détection de changement, pas une preuve d'identité cryptographique. */
export function fingerprintContent(content: string): string {
  const bytes = encoder.encode(content);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const six = new Uint8Array(6);
  let value = hash;
  for (let index = 5; index >= 0; index -= 1) {
    six[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return base64urlFromBytes(six);
}

function checkScopeShape(scope: CheckpointScope): void {
  if (!scope.repository.trim() || !scope.ref.trim() || !/^[0-9a-f]{7,64}$/i.test(scope.sha.trim())
    || !scope.maskingVersion.trim()) {
    throw new StateContractError('INVALID_CHECKPOINT_SCOPE', 'A checkpoint scope needs repository, ref, a Git SHA and a masking version');
  }
}

function checkSource(source: SourceCoverage): void {
  if (!source.location.trim() || !FINGERPRINT_PATTERN.test(source.fingerprint) || !source.observedAt.trim()) {
    throw new StateContractError('INVALID_CHECKPOINT_SOURCE', 'A tracked source needs a location, a fingerprint and an observation date');
  }
  if (source.continuation !== undefined && (!Number.isSafeInteger(source.continuation.offset) || source.continuation.offset < 0)) {
    throw new StateContractError('INVALID_CHECKPOINT_SOURCE', 'A partial source needs a continuation offset');
  }
}

export function encodeCheckpoint(checkpoint: ReadingCheckpoint): string {
  if (checkpoint.v !== CHECKPOINT_VERSION) {
    throw new StateContractError('UNSUPPORTED_CHECKPOINT', 'Unsupported checkpoint version: rebuild from a fresh index');
  }
  checkScopeShape(checkpoint.scope);
  if (!Number.isSafeInteger(checkpoint.stateRevision) || checkpoint.stateRevision < 1) {
    throw new StateContractError('INVALID_CHECKPOINT', 'A checkpoint needs a positive state revision');
  }
  if (checkpoint.sources.length > MAX_TRACKED_SOURCES) {
    throw new StateContractError('CHECKPOINT_TOO_LARGE', 'A checkpoint tracks at most ' + MAX_TRACKED_SOURCES + ' sources');
  }
  checkpoint.sources.forEach(checkSource);
  const json = JSON.stringify(checkpoint);
  if (json.length > MAX_CHECKPOINT_CHARS) {
    throw new StateContractError('CHECKPOINT_TOO_LARGE', 'The checkpoint exceeds its portable budget of ' + MAX_CHECKPOINT_CHARS + ' characters');
  }
  const bytes = encoder.encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeCheckpoint(raw: string): ReadingCheckpoint {
  let json: string;
  try {
    json = new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0)));
  } catch {
    throw new StateContractError('INVALID_CHECKPOINT', 'The checkpoint is not a portable encoded payload');
  }
  let parsed: ReadingCheckpoint;
  try {
    parsed = JSON.parse(json) as ReadingCheckpoint;
  } catch {
    throw new StateContractError('INVALID_CHECKPOINT', 'The checkpoint is not valid JSON');
  }
  if (parsed?.v !== CHECKPOINT_VERSION) {
    throw new StateContractError('UNSUPPORTED_CHECKPOINT', 'Unsupported checkpoint version: rebuild from a fresh index');
  }
  if (!Array.isArray(parsed.sources) || typeof parsed.createdAt !== 'string') {
    throw new StateContractError('INVALID_CHECKPOINT', 'A checkpoint needs a source list and a creation date');
  }
  checkScopeShape(parsed.scope);
  parsed.sources.forEach(checkSource);
  const locations = new Set(parsed.sources.map(source => source.location));
  if (locations.size !== parsed.sources.length) {
    throw new StateContractError('INVALID_CHECKPOINT', 'A checkpoint cannot track a location twice');
  }
  return parsed;
}

/** Un curseur ne s'applique jamais à une autre cible ; le SHA peut bouger, le masquage doit coïncider. */
export function scopeMatches(left: CheckpointScope, right: CheckpointScope): boolean {
  return left.repository === right.repository && left.ref === right.ref && left.maskingVersion === right.maskingVersion;
}

/**
 * Compare la couverture enregistrée à l'énumération courante. Un identifiant ancien
 * dont l'empreinte change est « modifié » (édition tardive), jamais considéré à jour
 * parce qu'il est vieux. Un suivi absent de l'énumération demande un rescan explicite.
 */
export function diffSources(previous: SourceCoverage[], current: SourceObservation[], scopesMatch: boolean): CoverageDiff {
  if (!scopesMatch) return { changed: [], missing: [], rescanRequired: true, unchanged: 0 };
  const fingerprints = new Map(current.map(observation => [observation.id, observation.fingerprint]));
  const changed: number[] = [];
  const missing: number[] = [];
  let unchanged = 0;
  for (const source of previous) {
    const identifier = sourceLocationId(source.location);
    if (identifier === null) continue;
    const observed = fingerprints.get(identifier);
    if (observed === undefined) { missing.push(identifier); continue; }
    if (observed === source.fingerprint) unchanged += 1; else changed.push(identifier);
  }
  return { changed, missing, rescanRequired: missing.length > 0, unchanged };
}

/** Location 'owner/repository#12' cible une discussion ; 'owner/repository#12/5994414388' un commentaire. */
function sourceLocationId(location: string): number | null {
  const match = /#(\d+)(?:\/(\d+))?$/.exec(location);
  if (!match) return null;
  return Number(match[2] ?? match[1]);
}

/** Fusionne la couverture : la source fraîche remplace la précédente par location, sans jamais réécrire l'historique. */
export function mergeCoverage(previous: SourceCoverage[], fresh: SourceCoverage[]): SourceCoverage[] {
  const merged = new Map(previous.map(source => [source.location, source]));
  for (const source of fresh) {
    checkSource(source);
    merged.set(source.location, source);
  }
  const all = [...merged.values()];
  if (all.length > MAX_TRACKED_SOURCES) {
    throw new StateContractError('CHECKPOINT_TOO_LARGE', 'A checkpoint tracks at most ' + MAX_TRACKED_SOURCES + ' sources');
  }
  return all;
}

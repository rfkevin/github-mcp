/**
 * CC-5 L5 (révision 5, vague 2) — politique d'hygiène mémoire D3, PURE.
 *
 * Aucune dépendance D1 : ce module définit la politique ; l'accès aux données
 * vit dans research/snapshot.ts (lectures bornées) et le cycle de vie réel
 * passe par le lifecycle C4 (memory.propose/review/consolidate/retire) —
 * jamais de réécriture directe d'une entrée existante.
 *
 * D3-c : plafond d'entrées par famille de scope — participant privé plus bas
 * que les scopes partagés (idée Vibe acceptée) ; les kinds critiques
 * (invariant, decision) ne comptent JAMAIS dans un plafond et ne sont JAMAIS
 * archivés (exception contrôlée pour les faits critiques).
 * D3-e : utilité mesurée — les entrées jamais servies sont archivées en
 * premier (archive-first), puis par last_used_rev croissant.
 * D3 (GPT-6) : un résumé de consolidation porte source_seq_range,
 * source_hash, version et review_at, encodé dans un evidence_ref.
 */
import { StateContractError } from '../../collab/contracts';
import { scopeFamily } from '../contracts/memory';
import { PROTECTED_KINDS } from './memory-store';

/** Plafonds d'entrées actives (hors kinds critiques) par famille de scope. */
export interface ScopeEntryCaps {
  participant: number;
  shared: number;
}

/** Défauts incrément 1 : participant privé 25, scopes partagés 50 (surcharge pour tests). */
export const DEFAULT_SCOPE_ENTRY_CAPS: ScopeEntryCaps = { participant: 25, shared: 50 };

/** Plafond d'entrées pour une famille (participant = privé, tout le reste = partagé). */
export function scopeEntryCap(family: string, caps: ScopeEntryCaps = DEFAULT_SCOPE_ENTRY_CAPS): number {
  return family === 'participant' ? caps.participant : caps.shared;
}

export interface ScopeClassification {
  family: string;
  private: boolean;
}

/** Classe un scope mémoire : famille + confidentialité participant (X2/CRB-R1). */
export function classifyScope(scope: string): ScopeClassification {
  const family = scopeFamily(scope);
  return { family, private: family === 'participant' };
}

/** Kind critique (exception contrôlée D3-c) : jamais compté, jamais archivé. */
export function isCriticalKind(kind: string): boolean {
  return PROTECTED_KINDS.has(kind);
}

/** Une entrée compte-t-elle dans le plafond de son scope ? */
export function countsTowardCap(kind: string): boolean {
  return !isCriticalKind(kind);
}

export interface ArchiveCandidateShape {
  kind: string;
  status: string;
}

/** Candidate à l'archivage : active ET non critique (une candidate peut encore s'activer). */
export function isArchivableCandidate(entry: ArchiveCandidateShape): boolean {
  return entry.status === 'active' && !isCriticalKind(entry.kind);
}

export interface ArchiveRankView {
  uses: number;
  last_used_rev: number | null;
}

export interface ArchiveFirstKey {
  neverServed: 0 | 1;
  lastUsedRev: number;
}

/** Clé de tri archive-first (D3-e) : jamais servie (uses=0) d'abord, puis last_used_rev croissant. */
export function archiveFirstSortKey(entry: ArchiveRankView): ArchiveFirstKey {
  return { neverServed: entry.uses === 0 ? 1 : 0, lastUsedRev: entry.last_used_rev ?? 0 };
}

/** Comparateur archive-first : jamais servies d'abord, puis usage le plus ancien. */
export function archiveFirstCompare(a: ArchiveRankView, b: ArchiveRankView): number {
  const ka = archiveFirstSortKey(a);
  const kb = archiveFirstSortKey(b);
  if (ka.neverServed !== kb.neverServed) return kb.neverServed - ka.neverServed;
  return ka.lastUsedRev - kb.lastUsedRev;
}

/** Liste SQL des kinds critiques, DÉRIVÉE de PROTECTED_KINDS (jamais dupliquée à la main). */
export const CRITICAL_KINDS_SQL: string = [...PROTECTED_KINDS].map(kind => "'" + kind + "'").join(', ');

/** Liaison d'un résumé de consolidation à sa source (D3, GPT-6). */
export interface ConsolidationBinding {
  source_seq_from: number;
  source_seq_to: number;
  source_hash: string;
  version: number;
  review_at: number;
}

const CONSOLIDATION_TAG = 'consolidation';
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function assertConsolidationInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new StateContractError('INVALID_CONSOLIDATION_BINDING', field + ' must be a safe integer >= 0', field);
  }
  return value;
}

/** Encode la liaison source d'un résumé en evidence_ref (chaîne JSON, consommable par C4). */
export function consolidationBinding(binding: ConsolidationBinding): string {
  const from = assertConsolidationInt(binding.source_seq_from, 'source_seq_from');
  const to = assertConsolidationInt(binding.source_seq_to, 'source_seq_to');
  const version = assertConsolidationInt(binding.version, 'version');
  const reviewAt = assertConsolidationInt(binding.review_at, 'review_at');
  if (to < from) {
    throw new StateContractError('INVALID_CONSOLIDATION_BINDING', 'source_seq_to must be >= source_seq_from', 'source_seq_to');
  }
  if (version < 1) {
    throw new StateContractError('INVALID_CONSOLIDATION_BINDING', 'version must be >= 1', 'version');
  }
  if (typeof binding.source_hash !== 'string' || !SHA256_HEX_RE.test(binding.source_hash)) {
    throw new StateContractError('INVALID_CONSOLIDATION_BINDING', 'source_hash must be sha256 hex (64 chars)', 'source_hash');
  }
  return JSON.stringify({
    [CONSOLIDATION_TAG]: 1,
    source_seq_from: from,
    source_seq_to: to,
    source_hash: binding.source_hash,
    version,
    review_at: reviewAt,
  });
}

/** Décode et valide une liaison de résumé ; null si absente ou malformée (jamais d'exception). */
export function parseConsolidationBinding(ref: string): ConsolidationBinding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ref);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value[CONSOLIDATION_TAG] !== 1) return null;
  if (typeof value.source_seq_from !== 'number' || typeof value.source_seq_to !== 'number'
    || typeof value.source_hash !== 'string' || typeof value.version !== 'number' || typeof value.review_at !== 'number') {
    return null;
  }
  const candidate: ConsolidationBinding = {
    source_seq_from: value.source_seq_from,
    source_seq_to: value.source_seq_to,
    source_hash: value.source_hash,
    version: value.version,
    review_at: value.review_at,
  };
  try {
    consolidationBinding(candidate);
  } catch {
    return null;
  }
  return candidate;
}

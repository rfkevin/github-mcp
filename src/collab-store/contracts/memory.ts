/**
 * CC-3 C1 — memory + evidence-ledger contracts (plan §4 / Sol A2).
 * Self-memory is lifecycle-governed; the ledger is append-only and
 * `producer = subject` is rejected unless producer is `system`.
 */
import { StateContractError } from '../../collab/contracts';

export const MEMORY_SCOPES = ['common', 'project', 'role', 'participant', 'task'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = [
  'fact',
  'lesson',
  'procedure',
  'decision',
  'invariant',
  'observation',
  'open_question',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_CONFIDENCE = ['hypothesis', 'observed', 'verified', 'owner_validated'] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCE)[number];

export const MEMORY_STATUS = ['candidate', 'active', 'superseded', 'retired'] as const;
export type MemoryStatus = (typeof MEMORY_STATUS)[number];

/**
 * Canonical token metric for memory budgets: UTF-16 units / 4, rounded up.
 * One shared definition for INSERT-time costs, the transactional guard and
 * the schema backfill, so every measure is exact, non-BMP included.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Scoped id: `common`, `project:<p>`, `role:<r>`, `participant:<id>`, `task:<t>`. */
const SCOPE_RE = /^(common|project:[A-Za-z0-9_-]{1,64}|role:[A-Za-z0-9_-]{1,64}|participant:[A-Za-z0-9:_-]{1,128}|task:[A-Za-z0-9_-]{1,64})$/;

export function validateMemoryScope(value: string): string {
  if (!SCOPE_RE.test(value ?? '')) {
    throw new StateContractError('INVALID_MEMORY_SCOPE', `Invalid memory scope: ${value}`, 'scope');
  }
  return value;
}

export interface MemoryEntry {
  scope: string;
  kind: MemoryKind;
  text: string;
  evidence_refs: string[];
  confidence: MemoryConfidence;
  status: MemoryStatus;
  author_pid: string;
}

function oneOf<T extends string>(value: string, values: readonly T[], code: string, field: string): T {
  if (!values.includes(value as T)) {
    throw new StateContractError(code, `${field} has unsupported value: ${value}`, field);
  }
  return value as T;
}

export function validateMemoryEntry(entry: MemoryEntry): MemoryEntry {
  validateMemoryScope(entry.scope);
  oneOf(entry.kind, MEMORY_KINDS, 'INVALID_MEMORY_KIND', 'kind');
  oneOf(entry.confidence, MEMORY_CONFIDENCE, 'INVALID_MEMORY_CONFIDENCE', 'confidence');
  oneOf(entry.status, MEMORY_STATUS, 'INVALID_MEMORY_STATUS', 'status');
  if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 600) {
    throw new StateContractError('INVALID_MEMORY_TEXT', 'memory text must be 1-600 chars, one fact per entry', 'text');
  }
  if (!Array.isArray(entry.evidence_refs)) {
    throw new StateContractError('INVALID_MEMORY_EVIDENCE', 'evidence_refs must be an array', 'evidence_refs');
  }
  if (entry.status !== 'candidate' && entry.evidence_refs.length === 0) {
    throw new StateContractError(
      'MEMORY_EVIDENCE_REQUIRED',
      'non-candidate entries require at least one evidence_ref',
      'evidence_refs',
    );
  }
  if (!entry.author_pid || typeof entry.author_pid !== 'string') {
    throw new StateContractError('INVALID_MEMORY_AUTHOR', 'author_pid is required', 'author_pid');
  }
  return entry;
}

/** A reviewer distinct from the author activates candidate → active. */
export function validateMemoryActivation(authorPid: string, reviewerPid: string): void {
  if (!authorPid || !reviewerPid || authorPid === reviewerPid) {
    throw new StateContractError(
      'MEMORY_SELF_ACTIVATION',
      'Memory activation requires a reviewer distinct from the author',
      'reviewer_pid',
    );
  }
}

export interface LedgerEntry {
  subject_pid: string;
  producer: string;
  kind: string;
  payload_json: string;
  evidence_ref?: string;
}

/**
 * Evidence ledger (Sol A2, invariant I11): objective, append-only.
 * A participant cannot write its own record unless producer is `system`.
 */
export function validateLedgerEntry(entry: LedgerEntry): LedgerEntry {
  if (!entry.subject_pid || typeof entry.subject_pid !== 'string') {
    throw new StateContractError('INVALID_LEDGER_SUBJECT', 'subject_pid is required', 'subject_pid');
  }
  if (!entry.producer || typeof entry.producer !== 'string') {
    throw new StateContractError('INVALID_LEDGER_PRODUCER', 'producer is required', 'producer');
  }
  if (entry.producer === entry.subject_pid && entry.producer !== 'system') {
    throw new StateContractError(
      'LEDGER_SELF_WRITE',
      'A participant cannot produce its own ledger record (producer = subject)',
      'producer',
    );
  }
  if (typeof entry.payload_json !== 'string' || !entry.payload_json.trim()) {
    throw new StateContractError('INVALID_LEDGER_PAYLOAD', 'payload_json must be non-empty JSON', 'payload_json');
  }
  try {
    JSON.parse(entry.payload_json);
  } catch {
    throw new StateContractError('INVALID_LEDGER_PAYLOAD', 'payload_json must be valid JSON', 'payload_json');
  }
  return entry;
}

/**
 * CC-3 C1 — phases, sealing + op_id policy (plan §3.2, Vibe R2).
 * `op_id` is deterministic per client+op so retries share the key
 * (F1) and duplicates are detectable (DUPLICATE_IDEMPOTENCY_KEY).
 */
import { StateContractError, assertPhase, type Phase } from '../../collab/contracts';

export interface PhaseDefinition {
  cycle_id: string;
  phase: Phase;
  entry_conditions: string[];
  expected_outputs: Array<{ role: string; kind: string; count: number }>;
  exit_conditions: string[];
  auto_advance: 'none' | string;
}

export function validatePhaseDefinition(def: PhaseDefinition): PhaseDefinition {
  assertPhase(def.phase);
  for (const list of [def.entry_conditions, def.exit_conditions]) {
    if (!Array.isArray(list)) {
      throw new StateContractError('INVALID_PHASE_CONDITIONS', 'phase conditions must be arrays', 'phase');
    }
  }
  if (!Array.isArray(def.expected_outputs)) {
    throw new StateContractError('INVALID_PHASE_OUTPUTS', 'expected_outputs must be an array', 'phase');
  }
  for (const out of def.expected_outputs) {
    if (!out.role || !out.kind || !Number.isSafeInteger(out.count) || out.count < 1) {
      throw new StateContractError(
        'INVALID_PHASE_OUTPUT',
        'each expected output needs role, kind and count >= 1',
        'expected_outputs',
      );
    }
  }
  if (typeof def.auto_advance !== 'string' || !def.auto_advance.trim()) {
    throw new StateContractError('INVALID_AUTO_ADVANCE', 'auto_advance must be "none" or a policy id', 'auto_advance');
  }
  return def;
}

export interface SealedProposal {
  cycle_id: string;
  phase: Phase;
  participant_id: string;
  content_hash: string;
}

export function validateSealedProposal(item: SealedProposal): SealedProposal {
  assertPhase(item.phase);
  if (!/^[0-9a-f]{64}$/i.test(item.content_hash ?? '')) {
    throw new StateContractError('INVALID_CONTENT_HASH', 'content_hash must be hex sha256', 'content_hash');
  }
  return item;
}

/**
 * op_id policy (§3.2): `{client}:{cycle}:{op}:{n}` — client = oauth client id
 * (short), op = short op name (no dots; e.g. `task-claim` for `task.claim`),
 * n = client-side monotonic counter.
 * Deterministic: a retry reuses the same key; a new op bumps n.
 */
const OP_ID_RE = /^[A-Za-z0-9:_-]{1,64}:[A-Za-z0-9:_-]{1,64}:[A-Za-z0-9_-]{1,64}:[0-9]{1,10}$/;

export function validateOpId(opId: string): string {
  if (!OP_ID_RE.test(opId ?? '')) {
    throw new StateContractError(
      'INVALID_OP_ID',
      'op_id must match {client}:{cycle}:{op}:{n} (deterministic per client+op)',
      'op_id',
    );
  }
  return opId;
}

/** Derive the idempotency key from an op_id (1:1, stable). */
export function opIdToIdempotencyKey(opId: string): string {
  return `op:${validateOpId(opId)}`.slice(0, 256);
}

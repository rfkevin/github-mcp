/**
 * CC-3 C1 — phases, sealing + op_id policy (plan §3.2, Vibe R2).
 * `op_id` is deterministic per client+op so retries share the key
 * (F1) and duplicates are detectable (DUPLICATE_IDEMPOTENCY_KEY).
 */
import { StateContractError, assertPhase, type Phase } from '../../collab/contracts';

/** CC-4 A0 (point 5) : task_id d'une sortie attendue. */
const TASK_OUTPUT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PhaseDefinition {
  cycle_id: string;
  phase: Phase;
  entry_conditions: string[];
  // CC-4 A0 (point 5) : task_id optionnel lie la sortie attendue à SA tâche.
  expected_outputs: Array<{ role: string; kind: string; count: number; task_id?: string }>;
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
    // CC-4 A0 (point 5) : task_id optionnel, validé quand présent.
    if (out.task_id !== undefined && !TASK_OUTPUT_ID_RE.test(out.task_id)) {
      throw new StateContractError(
        'INVALID_PHASE_OUTPUT_TASK',
        'expected_outputs task_id must match [a-z0-9][a-z0-9_-]{0,63}',
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
 * op_id policy (§3.2, durcie CC-4 A0 point 1): `{client}:{cycle}:{op}:{n}` —
 * EXACTLY four segments, no ':' inside any segment. client = the server
 * participant id, cycle = the targeted cycle id, op = short op name (no dots;
 * e.g. `task-claim` for `task.claim`), n = client-side monotonic counter.
 * Deterministic: a retry reuses the same key; a new op bumps n. The loose
 * grammar accepted real-world ids like `op:op:vibe:cc4-design:p2-review:1`
 * (seq 103/104 du cycle cc4-design) and `op:vibe:…` — now a hard INVALID_OP_ID.
 */
const OP_ID_RE = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64}):([0-9]{1,10})$/;

export interface ParsedOpId {
  client: string;
  cycle: string;
  op: string;
  n: string;
}

/** Parse a strictly valid op_id; throws StateContractError('INVALID_OP_ID') otherwise. */
export function parseOpId(opId: string): ParsedOpId {
  const match = OP_ID_RE.exec(opId ?? '');
  if (!match) {
    throw new StateContractError(
      'INVALID_OP_ID',
      'op_id must match {client}:{cycle}:{op}:{n} — exactly four segments, no extra ":"',
      'op_id',
    );
  }
  return { client: match[1], cycle: match[2], op: match[3], n: match[4] };
}

export function validateOpId(opId: string): string {
  parseOpId(opId);
  return opId;
}

/** Derive the idempotency key from an op_id (1:1, stable). */
export function opIdToIdempotencyKey(opId: string): string {
  return `op:${validateOpId(opId)}`.slice(0, 256);
}

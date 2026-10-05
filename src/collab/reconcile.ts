import type { DurableReceipt } from './receipts';
import { parseReceiptMarker, payloadFingerprint } from './receipts';

export type ObservedPublication = {
  target: DurableReceipt['target'];
  content?: string;
  payload?: unknown;
};

export type Reconciliation = {
  status: 'confirmed' | 'missing' | 'conflict' | 'unknown';
  receipt?: DurableReceipt;
  reason: string;
  safeToRetry: boolean;
};

export function reconcilePublication(expectedOperationId: string, expectedPayload: unknown, observed?: ObservedPublication): Reconciliation {
  return reconcileFingerprint(expectedOperationId, payloadFingerprint(expectedPayload), observed);
}

export function reconcileFingerprint(expectedOperationId: string, expectedFingerprint: string, observed?: ObservedPublication): Reconciliation {
  if (!observed) return { status: 'unknown', reason: 'No readback evidence was supplied.', safeToRetry: false };
  const receipt = observed.content ? parseReceiptMarker(observed.content) : undefined;
  if (!receipt) return { status: 'missing', reason: 'Target exists but carries no valid CC-2 receipt.', safeToRetry: false };
  if (receipt.operationId !== expectedOperationId) {
    return { status: 'conflict', receipt, reason: 'The target belongs to a different operation id.', safeToRetry: false };
  }
  if (receipt.payloadFingerprint !== expectedFingerprint) {
    return { status: 'conflict', receipt, reason: 'The operation id matches but the payload fingerprint differs.', safeToRetry: false };
  }
  if (observed.payload !== undefined && payloadFingerprint(observed.payload) !== expectedFingerprint) {
    return { status: 'conflict', receipt, reason: 'Readback payload differs from the expected payload.', safeToRetry: false };
  }
  return { status: 'confirmed', receipt, reason: 'Operation id and payload fingerprint match readback evidence.', safeToRetry: false };
}

export function recoverUnknownWrite(expectedOperationId: string, expectedPayload: unknown, candidates: readonly ObservedPublication[]): Reconciliation {
  const matches = candidates.map(candidate => reconcilePublication(expectedOperationId, expectedPayload, candidate))
    .filter(result => result.status === 'confirmed');
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { status: 'conflict', reason: 'Multiple targets claim the same operation id and payload.', safeToRetry: false };
  const conflicting = candidates.map(candidate => reconcilePublication(expectedOperationId, expectedPayload, candidate))
    .find(result => result.status === 'conflict');
  if (conflicting) return conflicting;
  return { status: 'missing', reason: 'No matching durable receipt was found; absence is not proof the write never happened.', safeToRetry: false };
}

import type { OperationRecord, PublicationState } from './contracts';
import { buildReceipt, operationId, payloadFingerprint, receiptMarker, type DurableReceipt, type ReceiptTarget } from './receipts';
import { reconcileFingerprint, type ObservedPublication, type Reconciliation } from './reconcile';

export type PublicationStep<T> = {
  stepId: string;
  run: () => Promise<T>;
  refOf: (value: T) => string;
};

export type PublicationResult<T> = {
  value?: T;
  operation: OperationRecord;
  receipt: DurableReceipt;
  reconciliation?: Reconciliation;
};

export function preparePublication(target: ReceiptTarget, payload: unknown, nonce: string): DurableReceipt {
  const fingerprint = payloadFingerprint(payload);
  return buildReceipt({ operationId: operationId(target.kind, fingerprint, nonce), payloadFingerprint: fingerprint,
    ref: target.ref, outcome: 'pending', reconcileRequired: true, target, steps: [] });
}

export function embedReceipt(body: string, receipt: DurableReceipt): string {
  return `${receiptMarker(receipt)}\n${body}`;
}

export async function executePublication<T>(receipt: DurableReceipt, step: PublicationStep<T>, readback?: (value: T) => Promise<ObservedPublication>): Promise<PublicationResult<T>> {
  const steps: OperationRecord['steps'] = [];
  try {
    const value = await step.run();
    steps.push({ stepId: step.stepId, outcome: 'success' });
    const published = buildReceipt({ ...receipt, ref: step.refOf(value), outcome: readback ? 'pending' : 'effective',
      reconcileRequired: Boolean(readback), steps });
    if (!readback) return { value, operation: record(published), receipt: published };
    try {
      const observed = await readback(value);
      const reconciliation = reconcileFingerprint(published.operationId, published.payloadFingerprint, observed);
      const confirmed = reconciliation.status === 'confirmed';
      const finalReceipt = buildReceipt({ ...published, outcome: confirmed ? 'effective' : 'unknown', reconcileRequired: !confirmed, steps });
      return { value, operation: record(finalReceipt), receipt: finalReceipt, reconciliation };
    } catch {
      const unknown = buildReceipt({ ...published, outcome: 'unknown', reconcileRequired: true, steps });
      return { value, operation: record(unknown), receipt: unknown,
        reconciliation: { status: 'unknown', reason: 'Readback failed after the write; reconcile before retry.', safeToRetry: false } };
    }
  } catch {
    steps.push({ stepId: step.stepId, outcome: 'unknown' });
    const unknown = buildReceipt({ ...receipt, outcome: 'unknown', reconcileRequired: true, steps });
    return { operation: record(unknown), receipt: unknown,
      reconciliation: { status: 'unknown', reason: 'Write outcome is uncertain; reconcile before retry.', safeToRetry: false } };
  }
}

export function withOutcome(receipt: DurableReceipt, outcome: PublicationState): DurableReceipt {
  return buildReceipt({ ...receipt, outcome, reconcileRequired: outcome !== 'effective' });
}

function record(receipt: DurableReceipt): OperationRecord {
  return { operationId: receipt.operationId, payloadFingerprint: receipt.payloadFingerprint, steps: receipt.steps };
}

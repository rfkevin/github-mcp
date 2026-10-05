import { describe, expect, it } from 'vitest';
import { buildReceipt, operationId, parseReceiptMarker, payloadFingerprint, receiptMarker } from '../../src/collab/receipts';
import { recoverUnknownWrite, reconcilePublication } from '../../src/collab/reconcile';

const payload = { body: 'hello', number: 16 };
const fingerprint = payloadFingerprint(payload);
const id = operationId('issue_comment', fingerprint, 'nonce-1');
const receipt = buildReceipt({ operationId: id, payloadFingerprint: fingerprint, ref: 'comment:7', outcome: 'effective', reconcileRequired: false,
  target: { kind: 'issue_comment', repository: 'o/r', ref: 'issue:16' }, steps: [{ stepId: 'publish', outcome: 'success' }] });

describe('CC-2 durable publication receipts', () => {
  it('is deterministic for object key order and round-trips a durable marker', () => {
    expect(payloadFingerprint({ number: 16, body: 'hello' })).toBe(fingerprint);
    expect(parseReceiptMarker(receiptMarker(receipt))).toEqual(receipt);
  });

  it('confirms only matching operation id and payload fingerprint', () => {
    const observed = { target: receipt.target, content: receiptMarker(receipt) };
    expect(reconcilePublication(id, payload, observed).status).toBe('confirmed');
    expect(reconcilePublication('other', payload, observed).status).toBe('conflict');
    expect(reconcilePublication(id, { body: 'changed', number: 16 }, observed).status).toBe('conflict');
  });

  it('does not treat absence as proof that an uncertain write is safe to retry', () => {
    expect(recoverUnknownWrite(id, payload, [])).toMatchObject({ status: 'missing', safeToRetry: false });
  });

  it('flags duplicate claims for the same operation', () => {
    const observed = { target: receipt.target, content: receiptMarker(receipt) };
    expect(recoverUnknownWrite(id, payload, [observed, observed])).toMatchObject({ status: 'conflict', safeToRetry: false });
  });
});

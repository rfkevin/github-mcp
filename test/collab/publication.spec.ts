import { describe, expect, it, vi } from 'vitest';
import { embedReceipt, executePublication, preparePublication } from '../../src/collab/publication';
import { buildReceipt, receiptMarker } from '../../src/collab/receipts';

const target = { kind: 'issue_comment' as const, repository: 'o/r', ref: 'issue:16' };
const payload = { body: 'proposal' };

describe('CC-2 publication recovery', () => {
  it('records a successful step and confirms readback', async () => {
    const pending = preparePublication(target, payload, 'nonce');
    const effective = buildReceipt({ ...pending, ref: 'comment:7', outcome: 'effective', reconcileRequired: false,
      steps: [{ stepId: 'publish', outcome: 'success' }] });
    const run = vi.fn(async () => ({ id: 7 }));
    const result = await executePublication(pending, { stepId: 'publish', run, refOf: value => `comment:${value.id}` },
      async () => ({ target, content: receiptMarker(effective) }));
    expect(run).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({ outcome: 'effective', reconcileRequired: false });
    expect(result.operation.steps).toEqual([{ stepId: 'publish', outcome: 'success' }]);
  });

  it('stops on uncertain write and requires reconciliation instead of retrying', async () => {
    const pending = preparePublication(target, payload, 'nonce');
    const result = await executePublication(pending, { stepId: 'publish', run: async () => { throw new Error('network'); }, refOf: () => 'never' });
    expect(result.receipt).toMatchObject({ outcome: 'unknown', reconcileRequired: true });
    expect(result.reconciliation).toMatchObject({ status: 'unknown', safeToRetry: false });
  });

  it('embeds the receipt before user content so a published artifact carries recovery evidence', () => {
    const pending = preparePublication(target, payload, 'nonce');
    expect(embedReceipt('proposal', pending)).toContain('MCP-Collab-Receipt:');
  });
});

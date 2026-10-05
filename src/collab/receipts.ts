import { StateContractError, validateOperationRecord, validatePublicationReceipt } from './contracts';
import type { OperationRecord, PublicationReceipt, PublicationState } from './contracts';
import { fingerprintContent } from './reading-checkpoint';

export type ReceiptTarget = {
  kind: 'issue_comment' | 'commit';
  repository: string;
  ref: string;
  revision?: string;
};

export type DurableReceipt = PublicationReceipt & {
  version: 1;
  payloadFingerprint: string;
  target: ReceiptTarget;
  steps: OperationRecord['steps'];
};

const MARKER = 'MCP-Collab-Receipt:';

export function payloadFingerprint(payload: unknown): string {
  return `fnv48:${fingerprintContent(stableJson(payload))}`;
}

export function operationId(kind: ReceiptTarget['kind'], fingerprint: string, nonce: string): string {
  const clean = nonce.trim();
  if (!clean || clean.length > 120) throw new StateContractError('INVALID_OPERATION_ID', 'Operation nonce is invalid');
  return `cc2:${kind}:${fingerprint.replace(':', '-')}:${fingerprintContent(clean)}`;
}

export function buildReceipt(input: Omit<DurableReceipt, 'version'>): DurableReceipt {
  const receipt: DurableReceipt = { version: 1, ...input };
  validatePublicationReceipt(receipt);
  validateOperationRecord({ operationId: receipt.operationId, payloadFingerprint: receipt.payloadFingerprint, steps: receipt.steps });
  if (!receipt.target.repository.trim() || !receipt.target.ref.trim()) {
    throw new StateContractError('INVALID_RECEIPT_TARGET', 'A receipt target needs repository and ref');
  }
  return receipt;
}

export function receiptMarker(receipt: DurableReceipt): string {
  return `<!-- ${MARKER} ${toBase64Url(JSON.stringify(receipt))} -->`;
}

export function parseReceiptMarker(content: string): DurableReceipt | undefined {
  const match = new RegExp(`<!--\\s*${MARKER.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s+([A-Za-z0-9_-]+)\\s*-->`).exec(content);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(fromBase64Url(match[1])) as DurableReceipt;
    if (parsed.version !== 1) return undefined;
    return buildReceipt(parsed);
  } catch {
    return undefined;
  }
}

export function receiptOutcome(state: PublicationState, reconcileRequired: boolean): Pick<PublicationReceipt, 'outcome' | 'reconcileRequired'> {
  return { outcome: state, reconcileRequired };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

import { createHash } from 'node:crypto';
import { InputValidationError } from '../../../github/types';
import { redactDiagnostic } from './reports';

export const MASKING_VERSION = 'known-secrets-v1';
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function maskedRevision(content: string): string {
  return createHash('sha256').update(MASKING_VERSION).update('\0').update(content).digest('hex');
}

function isContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export function pageMaskedContent(
  value: string,
  offset: number,
  limit: number,
  expectedRevision?: string,
): { content: string; offset: number; nextOffset: number | null; totalBytes: number; revision: string; truncated: boolean } {
  const masked = redactDiagnostic(value);
  const bytes = encoder.encode(masked);
  const revision = maskedRevision(masked);
  if (expectedRevision && expectedRevision !== revision) {
    throw new InputValidationError('Le commentaire a changé depuis la page précédente. Reprenez la lecture à zéro.', 'DISCUSSION_ITEM_CHANGED');
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
    throw new InputValidationError('Offset de commentaire invalide.', 'INVALID_COMMENT_OFFSET');
  }
  if (offset < bytes.length && isContinuationByte(bytes[offset])) {
    throw new InputValidationError('L’offset doit pointer sur une frontière UTF-8 valide.', 'INVALID_COMMENT_OFFSET');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InputValidationError('Limite de commentaire invalide.', 'INVALID_COMMENT_LIMIT');
  }
  if (offset === bytes.length) {
    return { content: '', offset, nextOffset: null, totalBytes: bytes.length, revision, truncated: false };
  }

  let end = Math.min(offset + limit, bytes.length);
  if (end < bytes.length) {
    while (end < bytes.length && isContinuationByte(bytes[end])) end += 1;
  }
  const content = fatalDecoder.decode(bytes.slice(offset, end));
  return { content, offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length,
    revision, truncated: end < bytes.length };
}

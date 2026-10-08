export interface SealedEnvelope {
  nonce: string;
  content: string;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export async function createSealedEnvelope(content: string): Promise<{
  serialized: string;
  nonce: string;
  content_hash: string;
}> {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = hex(nonceBytes);
  const content_hash = await sha256(nonce + ':' + content);
  return {
    serialized: JSON.stringify({ nonce, content } satisfies SealedEnvelope),
    nonce,
    content_hash,
  };
}

export function parseSealedEnvelope(serialized: string): SealedEnvelope {
  const value = JSON.parse(serialized) as Partial<SealedEnvelope>;
  if (typeof value.nonce !== 'string' || !value.nonce || typeof value.content !== 'string') {
    throw new Error('INVALID_SEALED_ENVELOPE');
  }
  return { nonce: value.nonce, content: value.content };
}

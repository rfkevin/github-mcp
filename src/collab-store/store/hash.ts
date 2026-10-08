/**
 * CC-3 F1 (A01/A05) — shared SHA-256 helper for the store. Legacy sealed ids
 * ('sealed-' + key.slice(0, 48)) collided for long op_ids sharing a prefix;
 * hashing the full key + cycle makes sealed ids collision-resistant, and
 * intent fingerprints compare appended content without exposing it.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

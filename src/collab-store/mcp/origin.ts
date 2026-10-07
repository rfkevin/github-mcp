/**
 * CC-3 C2 — duplicate local (documenté) de la vérification d'origine de
 * src/mcp/origin.ts. Le garde-fou d'architecture C1 interdit tout import
 * depuis src/mcp/** à l'intérieur de src/collab-store/** ; la sémantique des
 * deux fichiers doit donc rester synchronisée manuellement (même logique).
 * Comme l'original : jamais un substitut du jeton bearer, jamais fail-open.
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export async function acceptsCollabOrigin(
  origin: string | null,
  serverOrigin: string,
  clientId: string | undefined,
  provider: Pick<OAuthHelpers, 'lookupClient'>,
): Promise<boolean> {
  // Native and server-to-server clients normally omit this header.
  if (origin === null) return true;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  // Exact serialized origin: no path, credentials, opaque origin, or origin list.
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
  if (origin === serverOrigin) return true;
  if (!clientId) return false;
  // Only use the client identity from the VERIFIED token, never from the request.
  const client = await provider.lookupClient(clientId);
  return client?.redirectUris.some(uri => {
    try { return new URL(uri).origin === origin; } catch { return false; }
  }) ?? false;
}

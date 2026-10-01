import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

/** Origin is a CSRF/DNS-rebinding check, never a substitute for a bearer token. */
export async function acceptsMcpOrigin(
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
  // lookupClient supports both registered clients and validated CIMD documents.
  const client = await provider.lookupClient(clientId);
  return client?.redirectUris.some(uri => {
    try { return new URL(uri).origin === origin; } catch { return false; }
  }) ?? false;
}

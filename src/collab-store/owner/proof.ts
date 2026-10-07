/**
 * CC-3 C5 — owner proof verification. Returns the proof recorded with a
 * decision (kind + subject), never the secret or the token itself.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { OwnerChannelConfig } from './config';

export type OwnerProof = { kind: 'access' | 'secret'; subject: string };

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';
const JWKS_CACHE = new Map<string, JWTVerifyGetKey>();

/** Injection point for tests; production uses the team's published Access certs. */
export type JwksResolver = (teamDomain: string) => JWTVerifyGetKey;

export const defaultJwksResolver: JwksResolver = teamDomain => {
  let keys = JWKS_CACHE.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    JWKS_CACHE.set(teamDomain, keys);
  }
  return keys;
};

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison of SHA-256 digests (lengths are always equal). */
export async function secretMatches(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(candidate), digest(expected)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/**
 * Verify the owner proof of a request. `submittedSecret` comes from the POSTed
 * form only (secret mode). Any failure returns null: the caller answers 403.
 */
export async function verifyOwnerProof(
  request: Request,
  config: OwnerChannelConfig,
  submittedSecret: string | null,
  jwks: JwksResolver = defaultJwksResolver,
): Promise<OwnerProof | null> {
  if (config.mode === 'secret') {
    if (!submittedSecret) return null;
    return await secretMatches(submittedSecret, config.secret) ? { kind: 'secret', subject: 'owner-secret' } : null;
  }
  const token = request.headers.get(ACCESS_HEADER);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
    });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    return email === config.email ? { kind: 'access', subject: email } : null;
  } catch {
    return null;
  }
}

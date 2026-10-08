/**
 * CC-3 C5 — owner channel configuration (I7). Fail-closed: without an explicit,
 * complete configuration the /owner route is not mounted at all.
 *
 * Modes (plan §3.4, C0 report):
 * - access: Cloudflare Access protects /owner; the Worker verifies the Access
 *   JWT (team domain, audience) and the owner's e-mail.
 * - secret: fallback; OWNER_SECRET is a Worker secret typed by Kevin on /owner
 *   only. It is never displayed, logged, stored or sent to an agent. Rotating
 *   the Worker secret invalidates the previous value immediately.
 */
export interface OwnerChannelEnv {
  OWNER_AUTH_MODE?: string;
  OWNER_SECRET?: string;
  OWNER_ACCESS_TEAM_DOMAIN?: string;
  OWNER_ACCESS_AUD?: string;
  OWNER_ACCESS_EMAIL?: string;
}

export const MIN_OWNER_SECRET_LENGTH = 32;

export type OwnerChannelConfig =
  | { mode: 'secret'; secret: string }
  | { mode: 'access'; teamDomain: string; audience: string; email: string };

const TEAM_DOMAIN_RE = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

/** null = channel disabled (absent or incomplete configuration, never fail-open). */
export function ownerChannelConfig(env: OwnerChannelEnv): OwnerChannelConfig | null {
  if (env.OWNER_AUTH_MODE === 'secret') {
    const secret = env.OWNER_SECRET ?? '';
    return secret.length >= MIN_OWNER_SECRET_LENGTH ? { mode: 'secret', secret } : null;
  }
  if (env.OWNER_AUTH_MODE === 'access') {
    const teamDomain = (env.OWNER_ACCESS_TEAM_DOMAIN ?? '').trim().toLowerCase();
    const audience = (env.OWNER_ACCESS_AUD ?? '').trim();
    const email = (env.OWNER_ACCESS_EMAIL ?? '').trim().toLowerCase();
    if (!TEAM_DOMAIN_RE.test(teamDomain) || !audience || !email.includes('@')) return null;
    return { mode: 'access', teamDomain, audience, email };
  }
  return null;
}

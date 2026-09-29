import { publicOrigin, type AppEnv } from '../config';

export async function codeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function githubSignInUrl(env: AppEnv, state: string, verifier: string): Promise<string> {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID, redirect_uri: `${publicOrigin(env)}/callback`,
    state, code_challenge: await codeChallenge(verifier), code_challenge_method: 'S256',
    scope: '', // Identity only; repository access uses the installation token.
  }).toString();
  return url.href;
}

export async function githubIdentity(
  env: AppEnv, code: string, verifier: string, fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const response = await fetcher('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code, code_verifier: verifier, redirect_uri: `${publicOrigin(env)}/callback`,
    }),
  });
  if (!response.ok) throw new Error('Connexion GitHub indisponible.');
  const token = await response.json() as { access_token?: string };
  if (!token.access_token) throw new Error('Connexion GitHub refusée.');
  const identity = await fetcher('https://api.github.com/user', {
    redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'github-mcp-worker', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!identity.ok) throw new Error('Identité GitHub indisponible.');
  const user = await identity.json() as { id?: number };
  if (!Number.isSafeInteger(user.id) || user.id! <= 0) throw new Error('Identité GitHub invalide.');
  return String(user.id);
}

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { isAllowedUser, type AuthEnv } from '../config';
import { consentPage, consentPagePolicy } from './consent';
import { navigationPage } from './navigation';
import { GitHubIdentityError, githubIdentity, githubSignInUrl } from './github';

type PhaseReporter = (phase: string) => void;

type RedirectCategory = 'github_authorize' | 'http_loopback' | 'https_client' | 'custom_scheme' | 'invalid';

function clientRedirectCategory(value: string): RedirectCategory {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
      return 'http_loopback';
    }
    if (url.protocol === 'https:') return 'https_client';
    return url.protocol ? 'custom_scheme' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function reportRedirect(env: AuthEnv, phase: string, location: string | null, destination: RedirectCategory, status = 302): void {
  console.info(JSON.stringify({
    event: 'oauth_redirect_handoff',
    phase,
    status,
    locationPresent: location !== null,
    destination,
    buildSha: env.BUILD_SHA ?? null,
  }));
}

// Messages publics par catégorie : jamais d'URL, de code, d'identifiant ni de corps
// de réponse GitHub. Le détail exploitable reste dans le journal structuré.
const IDENTITY_FAILURE_MESSAGES: Record<string, string> = {
  github_token_network_error: 'GitHub est injoignable depuis ce serveur. Réessayez dans un instant.',
  github_user_network_error: 'GitHub est injoignable depuis ce serveur. Réessayez dans un instant.',
  github_token_redirect_rejected:
    'Une redirection GitHub inattendue a été refusée par sécurité. Aucun identifiant n’a été transmis.',
  github_user_redirect_rejected:
    'Une redirection GitHub inattendue a été refusée par sécurité. Aucun identifiant n’a été transmis.',
  github_token_http_error: 'GitHub a refusé la demande de connexion.',
  github_user_http_error: 'GitHub a refusé la vérification de l’identité.',
  github_token_redirect_uri_mismatch: 'Le callback GitHub configuré ne correspond pas à cette adresse.',
  github_token_incorrect_client_credentials: 'Les identifiants OAuth GitHub du serveur sont invalides.',
  github_token_bad_verification_code: 'Le code de connexion GitHub a expiré ou a déjà été utilisé. Recommencez.',
  github_token_response_invalid: 'GitHub a renvoyé une réponse de connexion illisible.',
  github_user_response_invalid: 'GitHub a renvoyé une identité illisible.',
  github_user_id_invalid: 'GitHub a renvoyé une identité inutilisable.',
  github_token_rejected: 'La connexion GitHub a été refusée. Recommencez depuis votre client.',
};

const FALLBACK_FAILURE_MESSAGE = 'Connexion temporairement indisponible.';

// Page d'erreur autonome : sans script, sans lien et sans ressource distante, pour
// ne jamais introduire d'open redirect ni exposer de détail sensible au navigateur.
const ERROR_STYLE = [
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f7f6;color:#10201f;font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}',
  '@media (prefers-color-scheme:dark){body{background:#081210;color:#edf7f4}}',
  'main{width:min(100%,440px);padding:26px 28px;background:rgba(255,255,255,.94);border:1px solid #d8e2df;border-radius:18px;box-shadow:0 24px 70px rgba(15,45,41,.13)}',
  '@media (prefers-color-scheme:dark){main{background:rgba(15,27,24,.96);border-color:#28403b}}',
  'h1{margin:0 0 10px;font-size:1.3rem;line-height:1.25;letter-spacing:-.02em}',
  'p{margin:0 0 10px;color:#5a6b68}',
  '.hint{font-size:.85rem}',
].join('');

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
}

function htmlErrorPage(title: string, message: string, status: number): Response {
  const html = [
    '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(title) + '</title><style>' + ERROR_STYLE + '</style></head><body><main>',
    '<h1>' + escapeHtml(title) + '</h1>',
    '<p>' + escapeHtml(message) + '</p>',
    '<p class="hint">Recommencez la connexion depuis votre client, sans recharger cette page : chaque demande de connexion ne sert qu’une fois.</p>',
    '</main></body></html>',
  ].join('');
  return new Response(html, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'",
    'X-Frame-Options': 'DENY',
  } });
}

function failureMessage(error: unknown): string {
  return error instanceof GitHubIdentityError
    ? IDENTITY_FAILURE_MESSAGES[error.reason] ?? FALLBACK_FAILURE_MESSAGE
    : FALLBACK_FAILURE_MESSAGE;
}

async function handleAuthorizeGet(
  request: Request,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('authorize.parse_request');
  const auth = await oauth.parseAuthRequest(request);
  reportPhase('authorize.describe_consent');
  const details = await oauth.describeConsent(auth);
  reportPhase('authorize.begin_consent');
  const consent = await oauth.beginConsent(auth);
  const nonce = crypto.randomUUID();
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  consent.headers.set('Content-Security-Policy', consentPagePolicy(details.redirectUri, nonce));
  return new Response(consentPage(details, consent.handle, nonce), { headers: consent.headers });
}

async function handleAuthorizePost(
  request: Request,
  env: AuthEnv,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('authorize.read_form');
  const form = await request.formData();
  const formHandle = form.get('handle');
  const handle = typeof formHandle === 'string' ? formHandle : '';

  if (form.get('decision') !== 'approve') {
    reportPhase('authorize.deny_consent');
    const denied = await oauth.denyConsent(request, handle);
    return navigationPage(denied.redirectTo, denied.headers);
  }

  reportPhase('authorize.approve_consent');
  const approved = await oauth.approveConsent(request, handle);
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  reportPhase('authorize.begin_upstream');
  const upstream = await oauth.beginUpstream(approved.request, {
    data: { verifier },
    headers: approved.headers,
  });
  reportPhase('authorize.build_github_redirect');
  const target = await githubSignInUrl(env, upstream.state, verifier);
  reportRedirect(env, 'authorize.navigate_to_github', null, 'github_authorize', 200);
  return navigationPage(target, upstream.headers);
}

async function handleCallback(
  request: Request,
  env: AuthEnv,
  oauth: AuthEnv['OAUTH_PROVIDER'],
  reportPhase: PhaseReporter,
): Promise<Response> {
  reportPhase('callback.finish_upstream');
  const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code || url.searchParams.has('error')) {
    const redirectTo = authorizationErrorRedirect(upstream.request, 'access_denied');
    upstream.headers.set('Location', redirectTo);
    reportRedirect(env, 'callback.redirect_client_error', upstream.headers.get('Location'), clientRedirectCategory(redirectTo));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  reportPhase('callback.github_identity');
  const userId = await githubIdentity(env, code, upstream.data.verifier, undefined, reportPhase);
  reportPhase('callback.check_user');
  if (!isAllowedUser(env, userId)) {
    const redirectTo = authorizationErrorRedirect(upstream.request, 'access_denied');
    upstream.headers.set('Location', redirectTo);
    reportRedirect(env, 'callback.redirect_client_denied', upstream.headers.get('Location'), clientRedirectCategory(redirectTo));
    return new Response(null, { status: 302, headers: upstream.headers });
  }

  reportPhase('callback.complete_authorization');
  const result = await oauth.completeAuthorization({
    request: upstream.request,
    userId,
    metadata: {},
    scope: upstream.request.scope,
    props: { userId },
  });
  upstream.headers.set('Location', result.redirectTo);
  reportRedirect(env, 'callback.redirect_client_success', upstream.headers.get('Location'), clientRedirectCategory(result.redirectTo));
  return new Response(null, { status: 302, headers: upstream.headers });
}

function diagnosticReason(error: unknown): string {
  if (error instanceof AuthorizationError) {
    if (error.description === 'Missing transaction handle') return 'consent_handle_missing';
    if (error.description === 'This authorization was not started in this browser; start again') {
      return 'browser_binding_missing';
    }
    if (error.description === 'This authorization belongs to a different browser session; start again') {
      return 'browser_binding_mismatch';
    }
    if (error.description === 'This authorization expired or was already used; start again') {
      return 'consent_transaction_expired_or_used';
    }
    if (error.code === 'invalid_scope') return 'consent_scope_invalid';
    return 'authorization_rejected';
  }

  if (error instanceof GitHubIdentityError) return error.reason;
  if (error instanceof CimdFetchError) return 'client_metadata_unavailable';
  return 'unexpected_error';
}

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    let phase = 'route.dispatch';
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        return await handleAuthorizeGet(request, oauth, value => { phase = value; });
      }
      if (url.pathname === '/authorize' && request.method === 'POST') {
        return await handleAuthorizePost(request, env, oauth, value => { phase = value; });
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        return await handleCallback(request, env, oauth, value => { phase = value; });
      }
      return htmlErrorPage('Page introuvable', 'Cette adresse ne fait pas partie du flux de connexion GitHub MCP.', 404);
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'oauth_flow_failure',
        phase,
        reason: diagnosticReason(error),
        ...(error instanceof GitHubIdentityError && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
        ...(error instanceof GitHubIdentityError && error.fetchFailure
          ? { fetchFailure: error.fetchFailure }
          : {}),
      }));
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return htmlErrorPage('Connexion impossible à terminer',
          'Demande de connexion invalide ou expirée. Recommencez depuis votre client.', 400);
      }
      return htmlErrorPage('Connexion temporairement indisponible', failureMessage(error), 503);
    }
  },
};

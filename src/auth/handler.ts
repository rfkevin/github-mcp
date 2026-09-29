import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { isAllowedUser, type AuthEnv } from '../config';
import { consentPage } from './consent';
import { githubIdentity, githubSignInUrl } from './github';

export const authHandler = {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === '/authorize' && request.method === 'GET') {
        const auth = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(auth);
        const consent = await oauth.beginConsent(auth);
        consent.headers.set('Content-Type', 'text/html; charset=utf-8');
        consent.headers.set('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }
      if (url.pathname === '/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const handle = String(form.get('handle') ?? '');
        if (form.get('decision') !== 'approve') {
          const denied = await oauth.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(request, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const upstream = await oauth.beginUpstream(approved.request, {
          data: { verifier }, headers: approved.headers,
        });
        upstream.headers.set('Location', await githubSignInUrl(env, upstream.state, verifier));
        return new Response(null, { status: 302, headers: upstream.headers });
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
        const code = url.searchParams.get('code');
        if (!code || url.searchParams.has('error')) {
          upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
          return new Response(null, { status: 302, headers: upstream.headers });
        }
        const userId = await githubIdentity(env, code, upstream.data.verifier);
        if (!isAllowedUser(env, userId)) {
          upstream.headers.set('Location', authorizationErrorRedirect(upstream.request, 'access_denied'));
          return new Response(null, { status: 302, headers: upstream.headers });
        }
        const result = await oauth.completeAuthorization({
          request: upstream.request, userId, metadata: {}, scope: upstream.request.scope, props: { userId },
        });
        upstream.headers.set('Location', result.redirectTo);
        return new Response(null, { status: 302, headers: upstream.headers });
      }
      return new Response('Introuvable', { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        return new Response('Demande de connexion invalide ou expirée. Recommencez depuis votre client.', {
          status: 400, headers: { 'Cache-Control': 'no-store' },
        });
      }
      return new Response('Connexion temporairement indisponible.', {
        status: 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
  },
};

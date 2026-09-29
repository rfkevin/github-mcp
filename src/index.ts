import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { assertConfigured, publicOrigin, type AppEnv, type AuthEnv } from './config';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    try { assertConfigured(env); } catch {
      return new Response('Serveur non configuré.',
        { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const origin = publicOrigin(env);
    if (new URL(request.url).origin !== origin) {
      return new Response('Origine refusée.',
        { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const provider = new OAuthProvider<AuthEnv>({
      apiRoute: '/mcp', apiHandler: mcpHandler, defaultHandler: authHandler,
      authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: ['mcp:read', 'offline_access'], requiredScopes: ['mcp:read'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
    });
    return provider.fetch(request, env as AuthEnv, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

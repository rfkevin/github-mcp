import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { assertConfigured, publicOrigin, type AppEnv, type AuthEnv } from './config';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { checksConfig } from './checks/config';
import { writesEnabled } from './writes/config';
import { automationEnabled } from './automation/config';
import { collabStoreEnabled, type CollabStoreEnv } from './collab-store/store/config';
import { collabMcpHandler } from './collab-store/mcp/handler';

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
    if (new URL(request.url).pathname === '/ready' && request.method === 'GET') {
      return Response.json({ status: 'ready', sha: env.BUILD_SHA ?? null },
        { headers: { 'Cache-Control': 'no-store' } });
    }
    const writes = writesEnabled(env.GITHUB_WRITES_ENABLED);
    const scopes = [
      'mcp:read',
      'offline_access',
      ...(checksConfig(env.GITHUB_CHECKS_CONFIG).length ? ['mcp:checks'] : []),
      ...(writes ? ['mcp:write'] : []),
      ...(writes ? ['mcp:integration'] : []),
      ...(automationEnabled(env.GITHUB_AUTOMATION_ENABLED) ? ['mcp:automation'] : []),
      // CC-3 C2 : 'collab:' n'est proposé que si le store est réellement monté.
      ...(collabStoreEnabled((env as CollabStoreEnv).COLLAB_STORE_ENABLED) && (env as CollabStoreEnv).COLLAB_DB ? ['collab:'] : []),
    ];
    const provider = new OAuthProvider<AuthEnv>({
      apiRoute: '/mcp', apiHandler: mcpHandler, defaultHandler: authHandler,
      authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: scopes,
      requiredScopes: writes ? ['mcp:read', 'mcp:write'] : ['mcp:read'],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      clientIdMetadataDocumentEnabled: true,
    });
    // CC-3 C2 : second OAuthProvider, même Worker. Endpoints authorize/token/register
    // partagés (jamais atteints via ce provider, le routage passe par le pathname) ;
    // le même KV valide les jetons. Un jeton /collab/mcp doit porter 'mcp:read'
    // (requiredScopes du provider principal) ET le scope dédié 'collab:'.
    if (collabStoreEnabled((env as CollabStoreEnv).COLLAB_STORE_ENABLED) && new URL(request.url).pathname === '/collab/mcp') {
      if (!(env as CollabStoreEnv).COLLAB_DB) {
        return new Response('Store de collaboration non configuré.',
          { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      const collabProvider = new OAuthProvider<AuthEnv>({
        apiRoute: '/collab/mcp', apiHandler: collabMcpHandler, defaultHandler: authHandler,
        authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: ['collab:'], requiredScopes: ['collab:'],
        resourceMetadata: { resource: `${origin}/collab/mcp`, authorization_servers: [origin] },
        clientIdMetadataDocumentEnabled: true,
      });
      return collabProvider.fetch(request, env as AuthEnv, ctx);
    }
    return provider.fetch(request, env as AuthEnv, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

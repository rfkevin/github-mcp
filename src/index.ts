import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { assertConfigured, publicOrigin, type AppEnv, type AuthEnv } from './config';
import { authHandler } from './auth/handler';
import { mcpHandler } from './mcp/handler';
import { checksConfig } from './checks/config';
import { writesEnabled } from './writes/config';
import { automationEnabled } from './automation/config';

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
        const scopes = [
      'mcp:read',
      'offline_access',
      ...(checksConfig(env.GITHUB_CHECKS_CONFIG).length ? ['mcp:checks'] : []),
      ...(writesEnabled(env.GITHUB_WRITES_ENABLED) ? ['mcp:write'] : []),
      ...(automationEnabled(env.GITHUB_AUTOMATION_ENABLED) ? ['mcp:automation'] : []),
    ];
    const provider = new OAuthProvider<AuthEnv>({
      apiRoute: '/mcp', apiHandler: mcpHandler, defaultHandler: authHandler,
      authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: scopes,
      requiredScopes: ['mcp:read'],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: scopes,
      },
      clientIdMetadataDocumentEnabled: true,
    });
    return provider.fetch(request, env as AuthEnv, ctx);
  },
} satisfies ExportedHandler<AppEnv>;

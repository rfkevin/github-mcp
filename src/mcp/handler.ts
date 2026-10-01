import { insufficientScope, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { isAllowedUser, publicOrigin, type AuthEnv } from '../config';
import { createToolContext } from './context';
import { createServer } from './tools';
import { acceptsMcpOrigin } from './origin';

// Called only by OAuthProvider after validating the token.
export const mcpHandler = {
  async fetch(request: Request, env: AuthEnv, context: ExecutionContext): Promise<Response> {
    const ctx = context as OAuthResourceContext<{ userId?: string }>;
    const userId = ctx.auth?.userId;
    if (!isAllowedUser(env, userId) || ctx.props?.userId !== userId) {
      return new Response('Accès refusé.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!ctx.auth.scope.includes('mcp:read')) return insufficientScope(ctx.auth, ['mcp:read']);
    const origin = request.headers.get('Origin');
    try {
      if (!await acceptsMcpOrigin(origin, publicOrigin(env), ctx.auth.clientId, env.OAUTH_PROVIDER)) {
        console.warn(JSON.stringify({ service: 'mcp', outcome: 'rejected', reason: 'origin_not_allowed' }));
        return new Response('Origine MCP refusée.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
      }
    } catch {
      // Metadata may be temporarily unavailable. Never fail open or log tokens/URLs.
      console.warn(JSON.stringify({ service: 'mcp', outcome: 'error', reason: 'client_metadata_unavailable' }));
      return new Response('Métadonnées du client indisponibles.', { status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '15' } });
    }
    const tools = createToolContext(env, userId, ctx.auth.scope);
    return createMcpHandler(() => createServer(tools), {
      allowedHostnames: [new URL(publicOrigin(env)).hostname],
      // The SDK compares hostnames only; the exact scheme/host/port was checked above.
      allowedOriginHostnames: origin === null ? [] : [new URL(origin).hostname],
    })(request, env, ctx);
  },
};

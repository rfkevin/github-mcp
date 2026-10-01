import { describe, expect, it, vi } from 'vitest';
import { acceptsMcpOrigin } from '../src/mcp/origin';
import { mcpHandler } from '../src/mcp/handler';
import type { AuthEnv } from '../src/config';

const server = 'https://mcp.example';
const provider = () => ({ lookupClient: vi.fn(async (clientId: string) => clientId === 'authorized-client'
  ? { clientId, tokenEndpointAuthMethod: 'none' as const,
    redirectUris: ['https://client.example/callback', 'http://localhost:4321/callback'] }
  : null) });

describe('MCP Origin policy independent of client brands', () => {
  it.each([null, server])('accepts %s without looking up a client', async origin => {
    const oauth = provider();
    expect(await acceptsMcpOrigin(origin, server, undefined, oauth)).toBe(true);
    expect(oauth.lookupClient).not.toHaveBeenCalled();
  });
  it.each(['https://client.example', 'http://localhost:4321'])('accepts a registered exact origin: %s', async origin => {
    const oauth = provider();
    expect(await acceptsMcpOrigin(origin, server, 'authorized-client', oauth)).toBe(true);
    expect(oauth.lookupClient).toHaveBeenCalledExactlyOnceWith('authorized-client');
  });
  it.each(['null', '', '*', 'https://client.example/path', 'https://user@client.example',
    'https://client.example?query', 'https://client.example#fragment',
    'https://client.example https://other.example', 'data:text/plain,test',
    'http://client.example', 'https://client.example:444', 'http://localhost:4322',
    'https://client.example.evil.test', 'https://other.example'])('rejects %s', async origin => {
    expect(await acceptsMcpOrigin(origin, server, 'authorized-client', provider())).toBe(false);
  });
  it('does not borrow another client’s redirect URIs', async () => {
    expect(await acceptsMcpOrigin('https://client.example', server, 'other-client', provider())).toBe(false);
    expect(await acceptsMcpOrigin('https://client.example', server, undefined, provider())).toBe(false);
  });
  it('does not swallow a metadata lookup failure', async () => {
    const lookupClient = vi.fn().mockRejectedValue(new Error('private diagnostic'));
    await expect(acceptsMcpOrigin('https://client.example', server, 'authorized-client', { lookupClient }))
      .rejects.toThrow('private diagnostic');
  });
  it('returns a safe 503 when client metadata is unavailable, never permitting the request', async () => {
    const lookupClient = vi.fn().mockRejectedValue(new Error('private diagnostic with token'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bindings = { PUBLIC_ORIGIN: server, ALLOWED_GITHUB_USER_IDS: '123',
        OAUTH_PROVIDER: { lookupClient } } as unknown as AuthEnv;
      const context = { auth: { userId: '123', scope: ['mcp:read'], clientId: 'client' },
        props: { userId: '123' } } as unknown as ExecutionContext;
      const response = await mcpHandler.fetch(new Request(`${server}/mcp`, {
        method: 'POST', headers: { Origin: 'https://client.example' },
      }), bindings, context);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('15');
      expect(await response.text()).not.toContain('private diagnostic');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private diagnostic');
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ service: 'mcp', outcome: 'error', reason: 'client_metadata_unavailable' }));
    } finally { warn.mockRestore(); }
  });
});

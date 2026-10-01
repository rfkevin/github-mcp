/** OAuth scopes are declarations for clients; authorization stays enforced by the server. */
type CapabilityScope = 'mcp:write' | 'mcp:checks' | 'mcp:automation' | 'mcp:integration';

export function oauthMetadata(...capabilities: CapabilityScope[]) {
  // The MCP v2 SDK preserves _meta in tools/list. OpenAI documents this field
  // for clients reading security schemes through the compatibility metadata.
  return { securitySchemes: [{ type: 'oauth2', scopes: ['mcp:read', ...capabilities] }] };
}

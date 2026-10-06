import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from './helpers';

const { send, mcpSession, rpcResult } = createOAuthFixture();

type JsonSchema = { type?: string | string[]; additionalProperties?: unknown; anyOf?: JsonSchema[]; items?: JsonSchema; properties?: Record<string, JsonSchema> };

/** Objets imbriqués d'un schéma JSON (y compris via anyOf/items), pour vérifier qu'ils restent ouverts. */
function nestedObjects(schema: JsonSchema, path: string, out: Array<{ path: string; schema: JsonSchema }>): void {
  if (schema.anyOf) schema.anyOf.forEach((option, index) => nestedObjects(option, path + '|' + index, out));
  if (schema.items) nestedObjects(schema.items, path + '[]', out);
  if (schema.properties) {
    out.push({ path, schema });
    for (const [key, child] of Object.entries(schema.properties)) nestedObjects(child, path + '.' + key, out);
  }
}

describe('compatibilité additive de github_collab_context', () => {
  it('les objets imbriqués de l enveloppe n interdisent pas les champs additionnels (clients au schéma mis en cache)', async () => {
    const { headers } = await mcpSession('mcp:read offline_access', 'https://generic-client.example/callback');
    const listed = await send('/mcp', { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = rpcResult(await listed.text()).tools as Array<{ name: string; outputSchema: JsonSchema }>;
    const tool = tools.find(candidate => candidate.name === 'github_collab_context');
    expect(tool).toBeDefined();
    const objects: Array<{ path: string; schema: JsonSchema }> = [];
    for (const [key, child] of Object.entries(tool!.outputSchema.properties ?? {})) nestedObjects(child, key, objects);
    const paths = objects.map(object => object.path);
    expect(paths).toEqual(expect.arrayContaining(['cycle', 'task|0', 'guidance', 'evidence', 'peerProposalExclusion', 'sources[]', 'coverage']));
    const closed = objects.filter(object => object.schema.additionalProperties === false).map(object => object.path);
    expect(closed).toEqual([]);
  });
});

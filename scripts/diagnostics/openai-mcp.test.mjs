import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, diagnose } from './openai-mcp.mjs';

const secrets = { apiKey: 'OPENAI_SECRET_CANARY', token: 'MCP_SECRET_CANARY' };
const response = output => Response.json({ output });
const listing = { type: 'mcp_list_tools', server_label: 'aide_codage', tools: [{ name: 'github_list_repositories' }] };
const call = { type: 'mcp_call', server_label: 'aide_codage', name: 'github_list_repositories', output: '{"repositories":["private/repo"]}' };

test('adaptation Responses MCP : authentifications distinctes, un seul outil de lecture, aucun stockage', async () => {
  const result = await diagnose({ ...secrets, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${secrets.apiKey}`);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.store, false);
    assert.equal(body.tools[0].authorization, secrets.token);
    assert.deepEqual(body.tools[0].allowed_tools, ['github_list_repositories']);
    assert.equal(body.tools[0].type, 'mcp');
    assert.equal(options.redirect, 'error');
    return response([listing, call]);
  } });
  assert.equal(result.ok, true);
  for (const value of [...Object.values(secrets), 'private/repo']) assert.equal(JSON.stringify(result).includes(value), false);
});

test('les erreurs API restent distinctes de la découverte, sans reproduire leur texte', async () => {
  const result = await diagnose({ ...secrets, fetcher: async () => Response.json({ error: { message: secrets.token } }, { status: 401 }) });
  assert.deepEqual(result, { ok: false, stage: 'api', status: 401 });
});

test('absence d’outil ou erreur de listing : échec de découverte, pas un succès HTTP', async () => {
  for (const output of [[], [{ ...listing, tools: [] }], [{ ...listing, error: secrets.token }]]) {
    const result = await diagnose({ ...secrets, fetcher: async () => response(output) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'discovery');
    assert.equal(JSON.stringify(result).includes(secrets.token), false);
  }
});

test('une découverte réussie ne prouve pas que l’appel a réussi', async () => {
  for (const output of [[listing], [listing, { ...call, output: null }], [listing, { ...call, error: secrets.token }]]) {
    const result = await diagnose({ ...secrets, fetcher: async () => response(output) });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'call');
    assert.equal(result.expectedToolImported, true);
    assert.equal(JSON.stringify(result).includes(secrets.token), false);
  }
});

test('une réponse mal formée ou excessive donne un résultat fermé', async () => {
  for (const body of ['not JSON', 'x'.repeat(2_000_001)]) {
    const result = await diagnose({ ...secrets, fetcher: async () => new Response(body) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_or_oversized_response');
  }
});

test('une erreur MCP sérialisée ou un résultat inconnu ne deviennent pas un succès', async () => {
  for (const value of [{ isError: true, structuredContent: { error: secrets.token } },
    { error: secrets.token }, { unknown: true }]) {
    const result = await diagnose({ ...secrets, fetcher: async () => response([listing, { ...call, output: JSON.stringify(value) }]) });
    assert.equal(result.callSucceeded, false);
    assert.equal(JSON.stringify(result).includes(secrets.token), false);
  }
  for (const value of [{ structuredContent: { repositories: [] } },
    { content: [{ type: 'text', text: '{"repositories":[]}' }] }]) {
    const result = await diagnose({ ...secrets, fetcher: async () => response([listing, { ...call, output: JSON.stringify(value) }]) });
    assert.equal(result.ok, true);
  }
});

test('les erreurs réseau ne recopient pas les secrets', async () => {
  const result = await diagnose({ ...secrets, fetcher: async () => { throw new Error(secrets.apiKey); } });
  assert.deepEqual(result, { ok: false, stage: 'api', reason: 'network_or_timeout' });
});

test('les identifiants et destinations invalides ne lancent aucune requête', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return response([]); };
  for (const options of [{ token: '' }, { apiKey: '' }, { token: 'bad\ntoken' },
    { serverUrl: 'http://example.com/mcp' }, { serverUrl: 'https://user:pass@example.com/mcp' },
    { serverUrl: 'https://example.com/mcp?token=secret' }]) {
    await assert.rejects(diagnose({ ...secrets, ...options, fetcher }));
  }
  assert.equal(requests, 0);
  assert.throws(() => buildRequest({ token: 'token', model: 'bad\nmodel' }));
});

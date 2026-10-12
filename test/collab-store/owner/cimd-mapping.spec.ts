import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { codeChallenge } from '../../../src/auth/github';
import { unregisteredParticipantId } from '../../../src/collab-store/identity';
import { resolveClientReference } from '../../../src/collab-store/owner/handler';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { navigationTarget } from '../../oauth/navigation-helpers';
import { e2eScenario, toolCode as code } from '../mcp/e2e-harness';

// CC-3 — association owner des clients OAuth CIMD par pseudonyme (constat Claude, 2026-10-11 :
// UNKNOWN_CLIENT pour https://claude.ai/oauth/mcp-oauth-client-metadata). Un client CIMD est lu
// à la demande par la bibliothèque OAuth et n'apparaît jamais dans listClients(). Chemin réel :
// /authorize → /callback → /oauth/token (resource /collab/mcp) → /collab/mcp → /owner (secret).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

type Scenario = ReturnType<typeof e2eScenario>;

/** Réseau simulé : métadonnées CIMD publiques + échange GitHub amont. */
function network(clients: Record<string, string>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (clients[url]) {
      return Response.json({ client_id: url, client_name: 'Client CIMD de test', redirect_uris: [clients[url]],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'upstream-test-token' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 123 });
    throw new Error('Unexpected network request: ' + url);
  });
}

function authorizeQuery(scenario: Scenario, clientId: string, redirectUri: string, challenge: string): string {
  return new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: 'mcp:read collab: offline_access', state: 'client-state', code_challenge: challenge, code_challenge_method: 'S256',
    resource: scenario.fixture.ORIGIN + '/collab/mcp' }).toString();
}

/** Parcours OAuth complet d'un client CIMD vers /collab/mcp ; renvoie les en-têtes MCP. */
async function cimdSession(scenario: Scenario, clientId: string, redirectUri: string): Promise<Record<string, string>> {
  const { fixture } = scenario;
  const verifier = 'cimd-verifier-'.repeat(5);
  const page = await fixture.send('/authorize?' + authorizeQuery(scenario, clientId, redirectUri, await codeChallenge(verifier)));
  expect(page.status).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
  expect(handle).toBeTruthy();
  const approved = await fixture.send('/authorize', { method: 'POST', headers: { Cookie: fixture.cookie(page) },
    body: new URLSearchParams({ handle: handle!, decision: 'approve' }) });
  const state = new URL(await navigationTarget(approved)).searchParams.get('state')!;
  const callback = await fixture.send(`/callback?code=upstream-code&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: fixture.cookie(approved) } });
  expect(callback.status).toBe(302);
  const token = await fixture.send('/oauth/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier,
    code: new URL(callback.headers.get('Location')!).searchParams.get('code')!, resource: fixture.ORIGIN + '/collab/mcp',
  }) });
  expect(token.status).toBe(200);
  const { access_token } = await token.json() as { access_token: string };
  return { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' };
}

async function mappedClient(clientId: string): Promise<string | undefined> {
  return (await db.prepare('SELECT participant_id FROM participant_clients WHERE oauth_client_id = ?1').bind(clientId)
    .first<{ participant_id: string }>())?.participant_id;
}

async function sightings(clientId: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM oauth_client_sightings WHERE oauth_client_id = ?1').bind(clientId)
    .first<{ n: number }>())?.n ?? 0;
}

const caller = async (call: (name: string, args: Record<string, unknown>) => Promise<{ structuredContent: Record<string, unknown> }>, cycle: string) =>
  (await call('collab_get_context', { cycle })).structuredContent.caller;

async function openCycle(scenario: Scenario, cycle: string): Promise<void> {
  const opener = await scenario.agent('opener');
  expect((await opener.call('collab_append_event', { cycle, expected_rev: 0, op_id: `${opener.pid}:${cycle}:open:1`,
    type: 'checkpoint', participant_id: opener.pid, payload_json: '{}' })).structuredContent.status).toBe('applied');
}

describe('CC-3 — association owner des clients OAuth CIMD', () => {
  it('le pseudonyme d’un client CIMD authentifié sur /collab/mcp s’associe puis se désassocie sur /owner', async () => {
    const scenario = e2eScenario(db, 'cimd', 'owner-secret-CIMD-0123456789abcdefghijklmn');
    const cycle = scenario.uniq('cycle');
    await openCycle(scenario, cycle);
    const clientId = `https://${scenario.uniq('meta')}.example/oauth/client.json`;
    network({ [clientId]: new URL(clientId).origin + '/callback' });
    const cimd = await scenario.clientFor(await cimdSession(scenario, clientId, new URL(clientId).origin + '/callback'));

    expect(cimd.pseudonym).toBe(await unregisteredParticipantId(clientId));
    expect(await sightings(clientId)).toBe(1);
    expect(await caller(cimd.call, cycle)).toEqual({ participant_id: cimd.pseudonym, status: 'unregistered' });

    const pid = scenario.uniq('cimd-agent');
    expect((await scenario.owner({ action: 'register', participant_id: pid, display_label: 'Agent CIMD' })).status).toBe(200);
    const mapped = await scenario.owner({ action: 'map', oauth_client_id: cimd.pseudonym, participant_id: pid });
    expect(mapped.status).toBe(200);
    expect(await mapped.text()).toContain('Client associé');
    expect(await mappedClient(clientId)).toBe(pid);
    expect(await caller(cimd.call, cycle)).toEqual({ participant_id: pid, status: 'registered' });

    const unmapped = await scenario.owner({ action: 'unmap', oauth_client_id: cimd.pseudonym });
    expect(unmapped.status).toBe(200);
    expect(await mappedClient(clientId)).toBeUndefined();
    expect(await caller(cimd.call, cycle)).toEqual({ participant_id: cimd.pseudonym, status: 'unregistered' });
    expect(await sightings(clientId)).toBe(1);
  });

  it('refuse le pseudonyme d’un client jamais authentifié : métadonnées lues à /authorize, jeton invalide, client_id déclaré', async () => {
    const scenario = e2eScenario(db, 'cimdx', 'owner-secret-CIMDX-0123456789abcdefghijklm');
    const pid = scenario.uniq('target');
    expect((await scenario.owner({ action: 'register', participant_id: pid, display_label: 'Cible' })).status).toBe(200);
    const stranger = await scenario.client();
    const [authorizeOnly, declared] = [`https://${scenario.uniq('authz')}.example/c.json`, `https://${scenario.uniq('decl')}.example/c.json`];
    network({ [authorizeOnly]: new URL(authorizeOnly).origin + '/callback' });

    // Métadonnées CIMD lues par /authorize, sans jamais obtenir ni présenter de jeton.
    expect((await scenario.fixture.send('/authorize?' + authorizeQuery(scenario, authorizeOnly,
      new URL(authorizeOnly).origin + '/callback', await codeChallenge('v'.repeat(43))))).status).toBe(200);
    // Jeton invalide : refusé avant le handler, rien n'est observé.
    expect((await scenario.fixture.send('/collab/mcp', { method: 'POST', headers: { Authorization: 'Bearer invalide',
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status).toBe(401);
    // Un client non associé peut déclarer n'importe quel client_id dans une demande : ce n'est pas une preuve.
    const cycle = scenario.uniq('cycle');
    expect((await stranger.call('collab_append_event', { cycle, expected_rev: 0, op_id: `${stranger.pseudonym.replace(":", ".")}:${cycle}:req:1`, type: 'owner.request',
      participant_id: stranger.pseudonym, payload_json: JSON.stringify({ request_id: 'join', client_id: declared }) }))
      .structuredContent.status).toBe('applied');

    for (const clientId of [authorizeOnly, declared]) {
      const refused = await scenario.owner({ action: 'map', oauth_client_id: await unregisteredParticipantId(clientId), participant_id: pid });
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain('UNKNOWN_CLIENT');
      expect(await mappedClient(clientId)).toBeUndefined();
      expect(await sightings(clientId)).toBe(0);
    }
  });

  it('ignore une ligne observée qui ne correspond pas au pseudonyme (revérification par empreinte)', async () => {
    const scenario = e2eScenario(db, 'cimdt', 'owner-secret-CIMDT-0123456789abcdefghijklm');
    await ensureSchema(db);
    const [victim, intruder] = [`https://${scenario.uniq('victim')}.example/c.json`, `https://${scenario.uniq('intruder')}.example/c.json`];
    const pseudonym = await unregisteredParticipantId(victim);
    await db.prepare('INSERT INTO oauth_client_sightings (oauth_client_id, pseudonym, first_seen) VALUES (?1, ?2, 0)')
      .bind(intruder, pseudonym).run();
    const pid = scenario.uniq('target');
    expect((await scenario.owner({ action: 'register', participant_id: pid, display_label: 'Cible' })).status).toBe(200);
    const refused = await scenario.owner({ action: 'map', oauth_client_id: pseudonym, participant_id: pid });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('UNKNOWN_CLIENT');
    expect(await mappedClient(intruder)).toBeUndefined();
    await expect(resolveClientReference(pseudonym, async () => [], db)).rejects.toMatchObject({ code: 'UNKNOWN_CLIENT' });
  });

  it('identifiant brut conservé : un client CIMD associé avant tout appel est registered et n’est jamais observé', async () => {
    const scenario = e2eScenario(db, 'cimdr', 'owner-secret-CIMDR-0123456789abcdefghijklm');
    const cycle = scenario.uniq('cycle');
    await openCycle(scenario, cycle);
    const clientId = `https://${scenario.uniq('raw')}.example/oauth/client.json`;
    const pid = scenario.uniq('raw-agent');
    expect((await scenario.owner({ action: 'register', participant_id: pid, display_label: 'Agent brut' })).status).toBe(200);
    expect((await scenario.owner({ action: 'map', oauth_client_id: clientId, participant_id: pid })).status).toBe(200);
    network({ [clientId]: new URL(clientId).origin + '/callback' });
    const headers = await cimdSession(scenario, clientId, new URL(clientId).origin + '/callback');
    const call = async (name: string, args: Record<string, unknown>) => scenario.fixture.rpcResult(await (await scenario.fixture
      .send('/collab/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name, arguments: args } }) })).text()) as { structuredContent: Record<string, unknown> };
    expect(await caller(call, cycle)).toEqual({ participant_id: pid, status: 'registered' });
    expect(code(await call('collab_append_event', { cycle, expected_rev: 1, op_id: `${pid}:${cycle}:cp:1`, type: 'checkpoint',
      participant_id: pid, payload_json: '{}' }) as never)).toBeUndefined();
    expect(await sightings(clientId)).toBe(0);
  });

  it('client enregistré dynamiquement : le pseudonyme se résout encore par listClients, sans observation', async () => {
    await ensureSchema(db);
    const registered = 'dcr-client-' + crypto.randomUUID();
    const pseudonym = await unregisteredParticipantId(registered);
    expect(await resolveClientReference(pseudonym, async () => ['autre-client', registered], db)).toBe(registered);
    expect(await resolveClientReference('  ' + registered + ' ', async () => [], db)).toBe(registered);
    await expect(resolveClientReference(pseudonym, async () => ['autre-client'], db)).rejects.toMatchObject({ code: 'UNKNOWN_CLIENT' });
  });
});

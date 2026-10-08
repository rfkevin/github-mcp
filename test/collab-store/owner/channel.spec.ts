import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createOAuthFixture } from '../../oauth/helpers';
import { handleOwnerRequest } from '../../../src/collab-store/owner/handler';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-3 C5 — route /owner : preuve exigée (R2), secret jamais exposé et rotation (R3).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SECRET = 'owner-secret-CANARY-0123456789abcdefghij';
const ROTATED = 'owner-secret-ROTATED-9876543210zyxwvutsrq';
let n = 0;
const uniq = (label: string) => `c5h-${label}-${++n}`;

function fixtureWith(secret = SECRET) {
  return createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', OWNER_AUTH_MODE: 'secret', OWNER_SECRET: secret });
}

function post(fixture: ReturnType<typeof createOAuthFixture>, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return fixture.send('/owner', { method: 'POST', headers: { Origin: fixture.ORIGIN, ...headers },
    body: new URLSearchParams(fields) });
}

function allLogs(...spies: Array<{ mock: { calls: unknown[][] } }>): string {
  return spies.flatMap(spy => spy.mock.calls.map(call => call.map(String).join(' '))).join('\n');
}

describe('CC-3 C5 — canal owner, mode secret', () => {
  it('sans configuration complète, /owner n’est pas monté (fail-closed)', async () => {
    for (const overrides of [
      { COLLAB_DB: db },
      { COLLAB_DB: db, OWNER_AUTH_MODE: 'secret', OWNER_SECRET: 'trop-court' },
      { COLLAB_DB: db, OWNER_AUTH_MODE: 'access' },
    ]) {
      const fixture = createOAuthFixture(overrides);
      const response = await post(fixture, { action: 'view', owner_secret: 'trop-court' });
      expect(response.status).toBe(404);
    }
  });

  it('refuse toute requête sans preuve valide, y compris avec un jeton MCP (R2)', async () => {
    const fixture = fixtureWith();
    const session = await fixture.mcpSession();
    for (const [fields, headers] of [
      [{ action: 'view' }, {}],
      [{ action: 'view', owner_secret: 'mauvais-secret-0123456789abcdefghijkl' }, {}],
      [{ action: 'decide', request_id: 'x', decision: 'approve' }, session.headers],
      [{ action: 'register', participant_id: 'p-intrus', display_label: 'x' }, session.headers],
    ] as Array<[Record<string, string>, Record<string, string>]>) {
      const response = await post(fixture, fields, headers);
      expect(response.status, JSON.stringify(fields)).toBe(403);
    }
    const crossSite = await post(fixture, { action: 'view', owner_secret: SECRET }, { Origin: 'https://evil.example' });
    expect(crossSite.status).toBe(403);
    await ensureSchema(db);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM participants WHERE participant_id = 'p-intrus'").first<{ n: number }>())?.n).toBe(0);
  });

  it('le GET en mode secret ne montre qu’un formulaire, sans aucune donnée', async () => {
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    const requestId = uniq('hidden-request');
    await store.appendEvent({ cycle_id: cycleId, type: 'owner.request', participant_id: 'agent:a', expected_rev: 0,
      op_id: `t:${cycleId}:req:1`, payload_json: JSON.stringify({ request_id: requestId, summary: 's' }) });
    const response = await fixtureWith().send('/owner');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('type="password"');
    expect(body).not.toContain(requestId);
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('avec le secret : liste, tranche une demande et ne renvoie ni ne journalise jamais le secret (R3)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => { });
    const log = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const fixture = fixtureWith();
    const store = new CollabStore(db);
    const cycleId = uniq('cycle');
    const requestId = uniq('req');
    await store.appendEvent({ cycle_id: cycleId, type: 'owner.request', participant_id: 'agent:a', expected_rev: 0,
      op_id: `t:${cycleId}:req:1`, payload_json: JSON.stringify({ request_id: requestId, summary: 'valider la gate' }) });

    const view = await post(fixture, { action: 'view', owner_secret: SECRET });
    expect(view.status).toBe(200);
    const viewBody = await view.text();
    expect(viewBody).toContain(requestId);

    const decided = await post(fixture, { action: 'decide', request_id: requestId, decision: 'approve', owner_secret: SECRET });
    expect(decided.status).toBe(200);
    const decidedBody = await decided.text();
    expect(decidedBody).toContain('Décision enregistrée : approve');

    for (const body of [viewBody, decidedBody]) expect(body).not.toContain(SECRET);
    const logs = allLogs(info, log, warn);
    expect(logs).toContain('owner-channel');
    expect(logs).not.toContain(SECRET);
    const stored = await db.prepare('SELECT payload_json, evidence_ref FROM events WHERE cycle_id = ?1').bind(cycleId).all<{ payload_json: string; evidence_ref: string }>();
    expect(JSON.stringify(stored.results)).not.toContain(SECRET);
    vi.restoreAllMocks();
  });

  it('la rotation du secret invalide immédiatement l’ancien (R3)', async () => {
    expect((await post(fixtureWith(SECRET), { action: 'view', owner_secret: SECRET })).status).toBe(200);
    const rotated = fixtureWith(ROTATED);
    expect((await post(rotated, { action: 'view', owner_secret: SECRET })).status).toBe(403);
    expect((await post(rotated, { action: 'view', owner_secret: ROTATED })).status).toBe(200);
  });
});

describe('CC-3 C5 — parcours complet : nouvel agent, demande, association par le propriétaire', () => {
  it('un client OAuth réel passe de unregistered à registered via /owner, puis écrit sous son identité', async () => {
    const fixture = fixtureWith();
    const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback',
      fixture.ORIGIN + '/collab/mcp');
    const append = async (args: Record<string, unknown>) => fixture.rpcResult(await (await fixture.send('/collab/mcp', {
      method: 'POST', headers: session.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'collab_append_event', arguments: args } }),
    })).text()) as { isError?: boolean; structuredContent: Record<string, unknown> };
    const cycleId = uniq('e2e');
    const probe = await append({ cycle: cycleId, expected_rev: 0, op_id: `a:${cycleId}:probe:1`, type: 'owner.request',
      participant_id: 'agent:a', payload_json: '{}' });
    const pseudonym = (probe.structuredContent.error as { message: string }).message.match(/unregistered:[0-9a-f]{16}/)![0];
    const request = await append({ cycle: cycleId, expected_rev: 0, op_id: `a:${cycleId}:req:1`, type: 'owner.request',
      participant_id: pseudonym, payload_json: JSON.stringify({ request_id: 'join-e2e', summary: 'Associer ce client' }) });
    expect(request.structuredContent.status).toBe('applied');

    const pid = uniq('agent-e2e');
    expect((await post(fixture, { action: 'register', participant_id: pid, display_label: 'Nouvel agent', owner_secret: SECRET })).status).toBe(200);
    const mapped = await post(fixture, { action: 'map', oauth_client_id: pseudonym, participant_id: pid, owner_secret: SECRET });
    expect(mapped.status).toBe(200);
    expect(await mapped.text()).toContain('Client associé');

    const written = await append({ cycle: cycleId, expected_rev: 1, op_id: `a:${cycleId}:cp:1`, type: 'checkpoint',
      participant_id: pid, payload_json: '{}' });
    expect(written.structuredContent.status).toBe('applied');
    const unknown = await post(fixture, { action: 'map', oauth_client_id: 'unregistered:0000000000000000', participant_id: pid, owner_secret: SECRET });
    expect(unknown.status).toBe(409);
    expect(await unknown.text()).toContain('UNKNOWN_CLIENT');
  });
});

describe('CC-3 C5 — canal owner, mode Cloudflare Access', () => {
  const ORIGIN = 'https://github-mcp.example';
  const TEAM = 'kevin.cloudflareaccess.com';
  const AUD = 'aud-owner-tag';
  const EMAIL = 'owner@example.com';
  const accessEnv = { COLLAB_DB: db, OWNER_AUTH_MODE: 'access', OWNER_ACCESS_TEAM_DOMAIN: TEAM, OWNER_ACCESS_AUD: AUD, OWNER_ACCESS_EMAIL: EMAIL };

  async function keys() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'k1', alg: 'RS256' };
    return { privateKey, jwks: () => createLocalJWKSet({ keys: [jwk] }) };
  }

  async function token(privateKey: CryptoKey, claims: { email?: string; aud?: string; iss?: string }) {
    return new SignJWT({ email: claims.email ?? EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? `https://${TEAM}`).setAudience(claims.aud ?? AUD)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  }

  it('accepte un JWT Access valide pour l’e-mail du propriétaire', async () => {
    const { privateKey, jwks } = await keys();
    const request = new Request(`${ORIGIN}/owner`, { headers: { 'Cf-Access-Jwt-Assertion': await token(privateKey, {}) } });
    const response = await handleOwnerRequest(request, accessEnv, ORIGIN, jwks);
    expect(response?.status).toBe(200);
  });

  it('refuse un JWT absent, d’un autre e-mail, d’une autre audience ou d’un autre émetteur (R2)', async () => {
    const { privateKey, jwks } = await keys();
    const other = await keys();
    const cases: Array<Record<string, string>> = [
      {},
      { 'Cf-Access-Jwt-Assertion': await token(privateKey, { email: 'agent@example.com' }) },
      { 'Cf-Access-Jwt-Assertion': await token(privateKey, { aud: 'autre' }) },
      { 'Cf-Access-Jwt-Assertion': await token(privateKey, { iss: 'https://evil.cloudflareaccess.com' }) },
      { 'Cf-Access-Jwt-Assertion': await token(other.privateKey, {}) },
    ];
    for (const headers of cases) {
      const response = await handleOwnerRequest(new Request(`${ORIGIN}/owner`, { headers }), accessEnv, ORIGIN, jwks);
      expect(response?.status, JSON.stringify(Object.keys(headers))).toBe(403);
    }
  });
});

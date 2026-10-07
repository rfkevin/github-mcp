import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';

// Diagnostics des refus dès la lecture de la demande d'autorisation (phase authorize.parse_request).
// Les motifs restent des classes fermées : ni client_id, ni redirect_uri, ni description d'origine.
const { ORIGIN, send } = createOAuthFixture();
const REDIRECT = 'http://localhost:4321/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

async function registeredClient(): Promise<string> {
    const registration = await send('/oauth/register', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            client_name: 'diagnostic', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        }) });
    expect(registration.status).toBe(201);
    return (await registration.json() as { client_id: string }).client_id;
}

function authorizeQuery(overrides: Record<string, string | null>): string {
    const values: Record<string, string | null> = { client_id: 'unknown-client', redirect_uri: REDIRECT,
        response_type: 'code', scope: 'mcp:read offline_access', state: 'client-state',
        code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp`, ...overrides };
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null) query.set(key, value);
    return query.toString();
}

async function rejected(query: string): Promise<string[]> {
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
    const response = await send(`/authorize?${query}`);
    expect(response.status).toBe(400);
    return diagnostic.mock.calls.map(([entry]) => String(entry));
}

describe('Diagnostic des demandes d’autorisation refusées', () => {
    it('distingue un client inconnu, par exemple un enregistrement perdu après redéploiement', async () => {
        const entries = await rejected(authorizeQuery({ client_id: 'stale-client-CANARY' }));
        expect(entries).toContain(JSON.stringify({
            event: 'oauth_flow_failure', phase: 'authorize.parse_request', reason: 'client_unknown',
        }));
        expect(entries.join('\n')).not.toContain('CANARY');
    });
    it('distingue une adresse de retour non enregistrée sans la journaliser', async () => {
        const clientId = await registeredClient();
        const entries = await rejected(authorizeQuery({ client_id: clientId,
            redirect_uri: 'http://localhost:4321/other-CANARY' }));
        expect(entries).toContain(JSON.stringify({
            event: 'oauth_flow_failure', phase: 'authorize.parse_request', reason: 'redirect_uri_invalid',
        }));
        expect(entries.join('\n')).not.toContain('CANARY');
        expect(entries.join('\n')).not.toContain(clientId);
    });
    it('ajoute le code OAuth normalisé aux autres refus génériques', async () => {
        const clientId = await registeredClient();
        const entries = await rejected(authorizeQuery({ client_id: clientId, response_type: null }));
        expect(entries).toContain(JSON.stringify({
            event: 'oauth_flow_failure', phase: 'authorize.parse_request',
            reason: 'authorization_rejected', oauthError: 'invalid_request',
        }));
        expect(entries.join('\n')).not.toContain(clientId);
    });
});

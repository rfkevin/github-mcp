import { SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { consentPolicy } from '../../src/auth/consent';
import { createOAuthFixture } from './helpers';
const { ORIGIN, send, cookie, consent } = createOAuthFixture();
describe('Consentement et découverte OAuth', () => {
    it('autorise les destinations du formulaire sans élargir les autres protections CSP', async () => {
        const { page } = await consent();
        expect(page.headers.get('Content-Security-Policy')).toBe("default-src 'none'; form-action 'self' https://github.com http://localhost:4321; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'");
        expect(page.headers.get('X-Frame-Options')).toBe('DENY');
        expect(page.headers.get('Cache-Control')).toBe('no-store');
        expect(cookie(page)).toContain('__Host-oauth-consent-');
    });
    it('limite le retour Claude à son origine, sans chemin ni paramètres', () => {
        expect(consentPolicy('https://claude.ai/api/mcp/auth_callback?state=private')).toBe("default-src 'none'; form-action 'self' https://github.com https://claude.ai; frame-ancestors 'none'; base-uri 'none'");
    });
    it.each(['https://*.example.com/callback', 'https://example.com;unsafe/callback', 'custom-app://callback'])('ne copie pas une expression CSP ou un protocole arbitraire : %s', uri => {
        expect(consentPolicy(uri)).toBe("default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'");
    });
    it('répond au contrôle de santé avec la configuration locale', async () => {
        expect((await SELF.fetch('https://example.com/health')).status).toBe(200);
        expect((await SELF.fetch('https://example.com/mcp')).status).toBe(503);
    });
    it.each([undefined, 'Bearer fake-token'])('refuse un accès sans jeton valide (%s)', async (authorization) => {
        const response = await send('/mcp', { headers: authorization ? { Authorization: authorization } : {} });
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    });
    it('publie la découverte OAuth sans données privées', async () => {
        const response = await send('/.well-known/oauth-protected-resource/mcp');
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ resource: `${ORIGIN}/mcp` });
    });
    it('refuse une approbation sans le cookie du navigateur', async () => {
        const { handle, page } = await consent();
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const response = await send('/authorize', { method: 'POST', body: new URLSearchParams({ handle, decision: 'approve' }) });
        expect(response.status).toBe(400);
        expect(response.headers.get('Location')).toBeNull();
        const cookieValue = cookie(page);
        const entries = diagnostic.mock.calls.map(([entry]) => String(entry));
        expect(entries).toContain(JSON.stringify({
            event: 'oauth_flow_failure',
            phase: 'authorize.approve_consent',
            reason: 'browser_binding_missing',
        }));
        expect(entries.join('\n')).not.toContain(handle);
        expect(entries.join('\n')).not.toContain(cookieValue);
    });
    it('distingue un handle de consentement absent', async () => {
        const { page } = await consent();
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const response = await send('/authorize', {
            method: 'POST',
            headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ decision: 'approve' }),
        });
        expect(response.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
            event: 'oauth_flow_failure',
            phase: 'authorize.approve_consent',
            reason: 'consent_handle_missing',
        }));
    });
    it('traite un handle de type fichier comme absent', async () => {
        const { page } = await consent();
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const form = new FormData();
        form.append('handle', new File(['not-a-handle'], 'handle.txt'));
        form.append('decision', 'approve');
        const response = await send('/authorize', {
            method: 'POST',
            headers: { Cookie: cookie(page) },
            body: form,
        });
        expect(response.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
            event: 'oauth_flow_failure',
            phase: 'authorize.approve_consent',
            reason: 'consent_handle_missing',
        }));
    });
    it('distingue une transaction de consentement déjà consommée', async () => {
        const { handle, page } = await consent();
        const headers = { Cookie: cookie(page) };
        const form = new URLSearchParams({ handle, decision: 'approve' });
        const first = await send('/authorize', { method: 'POST', headers, body: form });
        expect(first.status).toBe(302);
        const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const replay = await send('/authorize', { method: 'POST', headers, body: form });
        expect(replay.status).toBe(400);
        expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({
            event: 'oauth_flow_failure',
            phase: 'authorize.approve_consent',
            reason: 'consent_transaction_expired_or_used',
        }));
    });
    it('permet de refuser le consentement', async () => {
        const { handle, page } = await consent();
        const response = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
            body: new URLSearchParams({ handle, decision: 'deny' }) });
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    });
});

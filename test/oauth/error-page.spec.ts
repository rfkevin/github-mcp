import { describe, expect, it, vi } from 'vitest';
import { createOAuthFixture } from './helpers';
const { send, cookie, consent } = createOAuthFixture();
describe('Pages d’erreur claires du flux OAuth', () => {
    it('explique en HTML une approbation déjà consommée, sans redirection ni lien', async () => {
        const { handle, page } = await consent();
        const headers = { Cookie: cookie(page) };
        const form = new URLSearchParams({ handle, decision: 'approve' });
        const first = await send('/authorize', { method: 'POST', headers, body: form });
        expect(first.status).toBe(302);
        const replay = await send('/authorize', { method: 'POST', headers, body: form });
        expect(replay.status).toBe(400);
        expect(replay.headers.get('Location')).toBeNull();
        expect(replay.headers.get('Content-Type')).toContain('text/html');
        expect(replay.headers.get('Cache-Control')).toBe('no-store');
        expect(replay.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
        const html = await replay.text();
        expect(html).toContain('<main>');
        expect(html).toContain('Recommencez');
        expect(html).not.toMatch(/<script|<a\s|https?:\/\//i);
    });
    it('refuse un callback forgé avec la même page, sans contacter GitHub', async () => {
        const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
        const response = await send('/callback?code=forged&state=forged');
        expect(response.status).toBe(400);
        expect(network).not.toHaveBeenCalled();
        expect(response.headers.get('Content-Type')).toContain('text/html');
        expect(await response.text()).toContain('Recommencez');
    });
    it('répond en HTML pour une adresse hors du flux de connexion', async () => {
        const response = await send('/connexion-inconnue');
        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toContain('text/html');
        expect(await response.text()).toContain('flux de connexion');
    });
});

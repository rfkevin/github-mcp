import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from './helpers';
const { settings, send } = createOAuthFixture();
describe('sonde de disponibilité réelle', () => {
    it('identifie le paquet configuré sans confondre health et ready', async () => {
        const sha = 'a'.repeat(40);
        const response = await send('/ready', {}, { ...settings, BUILD_SHA: sha });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'ready', sha });
        expect((await send('/ready', {}, { ...settings, GITHUB_PRIVATE_KEY: '' })).status).toBe(503);
        expect((await send('/health', {}, { ...settings, GITHUB_PRIVATE_KEY: '' })).status).toBe(200);
        expect((await send('/ready', {}, { ...settings, BUILD_SHA: 'invalid' })).status).toBe(503);
    });
});

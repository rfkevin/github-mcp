import { describe, expect, it } from 'vitest';
import { navigationPage } from '../../src/auth/navigation';
import { createOAuthFixture } from './helpers';
import { navigationTarget } from './navigation-helpers';
const { consent, send, cookie } = createOAuthFixture();

describe('Navigation après consentement', () => {
  it('termine le POST avant de naviguer et conserve les cookies du flux', async () => {
    const { handle, page } = await consent();
    const response = await send('/authorize', { method: 'POST', headers: { Cookie: cookie(page) },
      body: new URLSearchParams({ handle, decision: 'approve' }) });
    const target = new URL(await navigationTarget(response));
    expect(target.origin).toBe('https://github.com');
    expect(target.searchParams.get('state')).toBeTruthy();
    expect(cookie(response)).toContain('__Host-oauth-upstream-');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'none'");
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('http-equiv="refresh"');
  });
  it('échappe la destination validée sans modifier ses paramètres OAuth', async () => {
    const target = 'https://client.example/callback?state=a&marker="<tag>"';
    const response = navigationPage(target, new Headers({ 'Set-Cookie': 'test=value; Secure' }));
    expect(await navigationTarget(response)).toBe(target);
    const html = await response.text();
    expect(html).not.toContain('<tag>');
    expect(html).not.toContain('<script');
    expect(response.headers.get('Set-Cookie')).toContain('test=value');
  });
  it('autorise uniquement le script de clic unique avec un nonce propre à la page', async () => {
    const first = await consent(); const second = await consent();
    const nonce = /<script nonce="([^"]+)">/.exec(first.html)?.[1];
    expect(nonce).toBeTruthy();
    expect(first.page.headers.get('Content-Security-Policy')).toContain("script-src 'nonce-" + nonce + "'");
    expect(second.html).not.toContain('nonce="' + nonce + '"');
    expect(first.html).toContain('role="status"');
    expect(first.html).toContain('event.preventDefault()');
    expect(first.page.headers.get('Content-Security-Policy')).not.toContain("script-src 'unsafe-inline'");
  });
});

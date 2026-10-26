import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { postSalonMessage } from '../../../src/collab-store/salon';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SECRET = 'owner-secret-SALON-0123456789abcdefghij';

function fixture(extra: Record<string, string> = {}) {
  return createOAuthFixture({
    COLLAB_DB: db,
    COLLAB_STORE_ENABLED: 'true',
    OWNER_AUTH_MODE: 'secret',
    OWNER_SECRET: SECRET,
    SALON_ENABLED: 'true',
    ...extra,
  });
}

function post(f: ReturnType<typeof fixture>, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return f.send('/salon', {
    method: 'POST',
    headers: { Origin: f.ORIGIN, ...headers },
    body: new URLSearchParams(fields),
  });
}

describe('CC-7 L4b — route /salon', () => {
  it('GET mode secret : formulaire seul, aucun message store', async () => {
    await ensureSchema(db, true);
    await postSalonMessage(db, { SALON_ENABLED: 'true' }, {
      authorPid: 'grok', level: 'info', body: 'secret-should-not-leak', now: 1_992_000_000,
    });
    const res = await fixture().send('/salon');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('type="password"');
    expect(body).toContain('value="view"');
    expect(body).not.toContain('secret-should-not-leak');
    expect(body).not.toContain('aria-label="Messages"');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  it('GET mode access sans JWT : 403', async () => {
    const f = createOAuthFixture({
      COLLAB_DB: db,
      COLLAB_STORE_ENABLED: 'true',
      OWNER_AUTH_MODE: 'access',
      OWNER_ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      OWNER_ACCESS_AUD: 'aud-test',
      OWNER_ACCESS_EMAIL: 'kevin@example.com',
      SALON_ENABLED: 'true',
    });
    const res = await f.send('/salon');
    expect(res.status).toBe(403);
  });

  it('POST Origin étranger : 403', async () => {
    const f = fixture();
    const res = await post(f, { action: 'view', owner_secret: SECRET }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('POST secret faux : 403', async () => {
    const f = fixture();
    const res = await post(f, { action: 'view', owner_secret: 'mauvais-secret-0123456789abcdefghijkl' });
    expect(res.status).toBe(403);
  });

  it('POST salon éteint : 403, sans écriture', async () => {
    await ensureSchema(db, true);
    const f = fixture({ SALON_ENABLED: 'false' });
    const res = await post(f, {
      action: 'publish', owner_secret: SECRET, level: 'info', body: 'ne-doit-pas-exister',
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('ne-doit-pas-exister');
  });

  it('POST valide : message owner publié', async () => {
    await ensureSchema(db, true);
    const f = fixture();
    const res = await post(f, {
      action: 'publish',
      owner_secret: SECRET,
      level: 'decision',
      body: 'Kevin décide',
      incident_key: 'k-1',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Kevin décide');
    expect(body).toContain('>owner<');
    expect(body).toContain('Message publié');
  });

  it('corps script échappé à l’affichage', async () => {
    await ensureSchema(db, true);
    const f = fixture();
    const res = await post(f, {
      action: 'publish',
      owner_secret: SECRET,
      level: 'info',
      body: '<script>alert(1)</script>',
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

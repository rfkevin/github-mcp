import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createOAuthFixture } from '../../oauth/helpers';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { postSalonMessage, pendingSalonWakes, SALON_DAILY_LIMIT } from '../../../src/collab-store/salon';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const ON = { SALON_ENABLED: 'true' };
const T0 = 1_993_000_000;
const SECRET = 'owner-secret-SALON-0123456789abcdefghij';

describe('CC-7 L4c salon polish', () => {
  it('quota dans le même lot : refus sans message orphelin', async () => {
    await ensureSchema(db, true);
    for (let i = 0; i < SALON_DAILY_LIMIT; i++) {
      await postSalonMessage(db, ON, {
        authorPid: 'claude', level: 'decision', body: 'q' + i, now: T0 + i, incidentKey: 'c' + i,
      });
    }
    await expect(postSalonMessage(db, ON, {
      authorPid: 'claude', level: 'decision', body: 'orphelin?', now: T0 + 20, incidentKey: 'c-x',
    })).rejects.toMatchObject({ code: 'SALON_DAILY_LIMIT' });
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM salon_messages WHERE author_pid = 'claude' AND body = 'orphelin?'",
    ).first<{ n: number }>();
    expect(row?.n ?? -1).toBe(0);
  });

  it('owner peut réveiller un destinataire', async () => {
    await ensureSchema(db, true);
    const r = await postSalonMessage(db, ON, {
      authorPid: 'owner', level: 'info', body: 'ping grok', now: T0 + 100,
      skipAgentQuota: true, wakeParticipants: ['grok'],
    });
    const pending = await pendingSalonWakes(db, 'grok');
    expect(pending.some(w => w.msg_id === r.msg_id)).toBe(true);
  });

  it('POST /salon avec wake_to crée le réveil', async () => {
    await ensureSchema(db, true);
    const f = createOAuthFixture({
      COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true',
      OWNER_AUTH_MODE: 'secret', OWNER_SECRET: SECRET, SALON_ENABLED: 'true',
    });
    const res = await f.send('/salon', {
      method: 'POST',
      headers: { Origin: f.ORIGIN },
      body: new URLSearchParams({
        action: 'publish', owner_secret: SECRET, level: 'info',
        body: 'Kevin → vibe', wake_to: 'vibe',
      }),
    });
    expect(res.status).toBe(200);
    const pending = await pendingSalonWakes(db, 'vibe');
    expect(pending.length).toBeGreaterThan(0);
  });
});

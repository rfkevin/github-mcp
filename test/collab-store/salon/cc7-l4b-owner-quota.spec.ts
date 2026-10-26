import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { postSalonMessage, SALON_DAILY_LIMIT, listSalonMessages } from '../../../src/collab-store/salon';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T0 = 1_991_000_000;
const ON = { SALON_ENABLED: 'true' };

describe('CC-7 L4b owner + quota atomique', () => {
  it('skipAgentQuota : owner publie au-delà du plafond agent', async () => {
    await ensureSchema(db, true);
    for (let i = 0; i < SALON_DAILY_LIMIT; i++) {
      await postSalonMessage(db, ON, {
        authorPid: 'owner', level: 'decision', body: 'agent-like ' + i, now: T0 + i,
        incidentKey: 'o-' + i,
      });
    }
    await expect(postSalonMessage(db, ON, {
      authorPid: 'owner', level: 'decision', body: 'trop', now: T0 + 10, incidentKey: 'o-x',
    })).rejects.toMatchObject({ code: 'SALON_DAILY_LIMIT' });
    const r = await postSalonMessage(db, ON, {
      authorPid: 'owner', level: 'decision', body: 'owner hors quota', now: T0 + 11,
      incidentKey: 'o-owner', skipAgentQuota: true,
    });
    expect(r.msg_id).toMatch(/^sm:/);
    expect(r.over_quota).toBe(false);
  });

  it('quota conditionnel : pas de message si plafond atteint', async () => {
    await ensureSchema(db, true);
    for (let i = 0; i < SALON_DAILY_LIMIT; i++) {
      await postSalonMessage(db, ON, {
        authorPid: 'vibe', level: 'decision', body: 'd' + i, now: T0 + 100 + i,
        incidentKey: 'v-' + i,
      });
    }
    await expect(postSalonMessage(db, ON, {
      authorPid: 'vibe', level: 'decision', body: 'refuse', now: T0 + 200, incidentKey: 'v-refuse',
    })).rejects.toMatchObject({ code: 'SALON_DAILY_LIMIT' });
    const list = await listSalonMessages(db, { sinceAt: T0 + 199 });
    expect(list.some(m => m.body === 'refuse')).toBe(false);
  });
});

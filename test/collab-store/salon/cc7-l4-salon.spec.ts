import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  postSalonMessage,
  listSalonMessages,
  pendingSalonWakes,
  ackSalonWake,
  SalonError,
  SALON_DAILY_LIMIT,
  salonEnabled,
} from '../../../src/collab-store/salon';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T0 = 1_990_000_000;
const ON = { SALON_ENABLED: 'true' };
const OFF = {};

describe('CC-7 L4 salon', () => {
  it('porte éteinte par défaut', () => {
    expect(salonEnabled(undefined)).toBe(false);
    expect(salonEnabled(OFF)).toBe(false);
    expect(salonEnabled({ SALON_ENABLED: 'TRUE' })).toBe(false);
    expect(salonEnabled(ON)).toBe(true);
  });

  it('refuse si salon éteint', async () => {
    await ensureSchema(db, true);
    await expect(postSalonMessage(db, OFF, {
      authorPid: 'grok', level: 'info', body: 'hello', now: T0,
    })).rejects.toMatchObject({ code: 'SALON_DISABLED' });
  });

  it('append info + list + wakes uniques', async () => {
    await ensureSchema(db, true);
    const r = await postSalonMessage(db, ON, {
      authorPid: 'grok', level: 'info', body: 'Salon ouvert.', now: T0,
      wakeParticipants: ['vibe', 'claude', 'grok'],
    });
    expect(r.msg_id).toMatch(/^sm:grok:/);
    expect(r.over_quota).toBe(false);
    const list = await listSalonMessages(db, { sinceAt: T0 - 1 });
    expect(list.some(m => m.msg_id === r.msg_id && m.body === 'Salon ouvert.')).toBe(true);
    const wakesV = await pendingSalonWakes(db, 'vibe');
    expect(wakesV.some(w => w.msg_id === r.msg_id)).toBe(true);
    // auteur non réveillé
    expect(await pendingSalonWakes(db, 'grok')).toEqual([]);
    const ack1 = await ackSalonWake(db, r.msg_id, 'vibe', T0 + 1);
    expect(ack1).toEqual({ ok: true, already: false });
    const ack2 = await ackSalonWake(db, r.msg_id, 'vibe', T0 + 2);
    expect(ack2).toEqual({ ok: true, already: true });
    expect(await pendingSalonWakes(db, 'vibe')).toEqual([]);
  });

  it('blocking exige task ; quota journalier ; exception new_fact', async () => {
    await ensureSchema(db, true);
    await expect(postSalonMessage(db, ON, {
      authorPid: 'vibe', level: 'blocking', body: 'sans tâche', now: T0 + 10,
    })).rejects.toMatchObject({ code: 'SALON_TASK_REQUIRED' });

    for (let i = 0; i < SALON_DAILY_LIMIT; i++) {
      await postSalonMessage(db, ON, {
        authorPid: 'vibe', level: 'decision', body: 'd' + i, now: T0 + 20 + i,
        incidentKey: 'inc-' + i,
      });
    }
    await expect(postSalonMessage(db, ON, {
      authorPid: 'vibe', level: 'decision', body: 'trop', now: T0 + 30,
      incidentKey: 'inc-extra',
    })).rejects.toMatchObject({ code: 'SALON_DAILY_LIMIT' });

    // Exception S7 : blocking + new_fact accepté hors quota
    const safe = await postSalonMessage(db, ON, {
      authorPid: 'vibe', level: 'blocking', body: 'secret exposé', taskId: 'L4',
      newFact: true, incidentKey: 'sec-1', now: T0 + 40,
    });
    expect(safe.over_quota).toBe(true);
  });

  it('un seul message par incident sans fait nouveau', async () => {
    await ensureSchema(db, true);
    await postSalonMessage(db, ON, {
      authorPid: 'claude', level: 'decision', body: 'premier', now: T0 + 50,
      incidentKey: 'same-inc',
    });
    await expect(postSalonMessage(db, ON, {
      authorPid: 'claude', level: 'decision', body: 'doublon', now: T0 + 51,
      incidentKey: 'same-inc',
    })).rejects.toMatchObject({ code: 'SALON_INCIDENT_DUP' });
    // avec new_fact OK (compte encore dans le quota)
    const second = await postSalonMessage(db, ON, {
      authorPid: 'claude', level: 'decision', body: 'fait nouveau', now: T0 + 52,
      incidentKey: 'same-inc', newFact: true,
    });
    expect(second.msg_id).toBeTruthy();
  });

  it('SalonError est typé', () => {
    const e = new SalonError('SALON_DISABLED', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('SALON_DISABLED');
  });

  it('msg_id unique même auteur/seconde/corps (UUID)', async () => {
    await ensureSchema(db, true);
    const a = await postSalonMessage(db, ON, {
      authorPid: 'grok', level: 'info', body: 'même texte', now: T0 + 100,
    });
    const b = await postSalonMessage(db, ON, {
      authorPid: 'grok', level: 'info', body: 'même texte', now: T0 + 100,
    });
    expect(a.msg_id).not.toBe(b.msg_id);
    expect(a.msg_id).toMatch(/^sm:[0-9a-f-]{36}$/i);
    expect(b.msg_id).toMatch(/^sm:[0-9a-f-]{36}$/i);
  });
});

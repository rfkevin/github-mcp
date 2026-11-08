import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { failureCode, recordFailure, recentFailures, FAILURE_BUCKET_S } from '../../../../src/collab-store/controller/failures';
import { ensureSchema } from '../../../../src/collab-store/store/schema';

// CC8 S8c — contrôles D1 du moniteur, sans fournisseur, sans planification de run.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_990_000_000;

async function setHalt(value: '0' | '1') {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO owner_flags(name,value,updated_at) VALUES(\'halt\',?1,?2)',
    'ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
  ].join(' ')).bind(value, T).run();
}

describe('CC8 S8c — incidents moniteur uniquement', () => {
  it('les erreurs sont typées, aucune donnée arbitraire n’entre dans le journal', () => {
    expect(failureCode('CONTROLLER_RUN_FAILED')).toBe('CONTROLLER_RUN_FAILED');
    expect(failureCode('bad:an arbitrary stack')).toBe('UNKNOWN_ERROR');
    expect(failureCode(undefined)).toBe('UNKNOWN_ERROR');
  });

  it('même portée/code/heure D1 dédupliqués ; heure suivante distincte, lecture bornée', async () => {
    await setHalt('0');
    const scope = 's8c-cron-' + crypto.randomUUID();
    expect(await recordFailure(db, { scope, error: 'CONTROLLER_RUN_FAILED', now: T })).toBe(true);
    expect(await recordFailure(db, { scope, error: 'CONTROLLER_RUN_FAILED', now: T + 10 })).toBe(false);
    expect(await recordFailure(db, { scope, error: 'CONTROLLER_RUN_FAILED',
      now: (Math.floor(T / FAILURE_BUCKET_S) + 1) * FAILURE_BUCKET_S })).toBe(true);
    const items = (await recentFailures(db, T + 2 * FAILURE_BUCKET_S)).filter(r => r.scope === scope);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ error: 'CONTROLLER_RUN_FAILED', hours: 2 });
  });

  it('HALT refuse la persistance de nouveaux incidents et la levée la réautorise', async () => {
    const scope = 's8c-halt-' + crypto.randomUUID();
    await setHalt('1');
    try {
      expect(await recordFailure(db, { scope, error: 'RESEARCH_PASS_FAILED', now: T })).toBe(false);
    } finally {
      await setHalt('0');
    }
    expect(await recordFailure(db, { scope, error: 'RESEARCH_PASS_FAILED', now: T })).toBe(true);
  });
});

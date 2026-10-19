import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  FAILURE_BUCKET_S, RESEARCH_SCOPE, ensureFailureQueue, failureCode, failureMessage, recentFailures, recordFailure,
  relayLines, runScheduledControllers,
} from '../../../src/collab-store/controller';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 L3d (incrément 2b-2b) — file des échecs du passage programmé, visible dans « À relayer ».
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;
const uniq = (label: string) => '0000-fail-' + label + '-' + (++counter);
const T0 = Math.floor(Date.UTC(2035, 0, 10, 8, 0, 0) / 1000);

async function setHalt(on: boolean): Promise<void> {
  await ensureSchema(db);
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, 0, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(on ? '1' : '0').run();
}

/** Cycle ouvert dont l'état importé est illisible : le contrôleur passe en mode dégradé. */
async function brokenCycle(cycle: string): Promise<void> {
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertEventRow(db, { cycle, type: 'owner.decision', participant: 'owner', role: 'owner',
    payload: { content: 'pas un état' }, key: 'owner-state-import:' + cycle + ':bad' });
}

function proxyThrowing(pattern: RegExp, onPrepare?: (sql: string) => void): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          onPrepare?.(sql);
          if (pattern.test(sql)) throw new Error('boom');
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const rowsFor = async (scope: string) => (await db.prepare('SELECT scope, error, bucket FROM controller_failures WHERE scope = ?1 ORDER BY id')
  .bind(scope).all<{ scope: string; error: string; bucket: number }>()).results;

describe('CC-5 L3d 2b-2b — code d\'échec et message (purs)', () => {
  it('code borné : seul un identifiant MAJUSCULE_SOULIGNÉ passe, sinon UNKNOWN_ERROR', () => {
    expect(failureCode('UNKNOWN_CYCLE')).toBe('UNKNOWN_CYCLE');
    for (const bad of [undefined, '', 'boom message', 'x'.repeat(10), 'A'.repeat(65), 'SELECT;--']) expect(failureCode(bad)).toBe('UNKNOWN_ERROR');
  });

  it('message lisible : portée (cycle ou chercheur), code, heures, dernière heure UTC', () => {
    expect(failureMessage('cc5', 'UNKNOWN_CYCLE', 1, T0)).toBe('Kevin — vérifier le passage programmé (cycle cc5) : échec UNKNOWN_CYCLE sur 1 heure depuis 24 h, dernier à 08:00 UTC.');
    expect(failureMessage(RESEARCH_SCOPE, 'RESEARCH_PASS_FAILED', 3, T0)).toContain('(chercheur L5) : échec RESEARCH_PASS_FAILED sur 3 heures');
  });
});

describe('CC-5 L3d 2b-2b — recordFailure (D1)', () => {
  it('une ligne par heure et par portée/code ; nouvelle heure → nouvelle ligne', async () => {
    const scope = uniq('hour');
    expect(await recordFailure(db, { scope, error: 'X_ERR', now: T0 })).toBe(true);
    expect(await recordFailure(db, { scope, error: 'X_ERR', now: T0 + FAILURE_BUCKET_S - 1 })).toBe(false);
    expect(await recordFailure(db, { scope, error: 'Y_ERR', now: T0 })).toBe(true);
    expect(await recordFailure(db, { scope, error: 'X_ERR', now: T0 + FAILURE_BUCKET_S })).toBe(true);
    expect((await rowsFor(scope)).map(row => row.error)).toEqual(['X_ERR', 'Y_ERR', 'X_ERR']);
  });

  it('append-only : modification et suppression refusées', async () => {
    const scope = uniq('ao');
    await recordFailure(db, { scope, error: 'X_ERR', now: T0 });
    await expect(db.prepare("UPDATE controller_failures SET error = 'Z' WHERE scope = ?1").bind(scope).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare('DELETE FROM controller_failures WHERE scope = ?1').bind(scope).run()).rejects.toThrow(/append-only/);
    expect(await rowsFor(scope)).toHaveLength(1);
  });

  it('HALT : rien n\'est écrit', async () => {
    const scope = uniq('halt');
    await ensureFailureQueue(db);
    await setHalt(true);
    try {
      expect(await recordFailure(db, { scope, error: 'X_ERR', now: T0 })).toBe(false);
    } finally {
      await setHalt(false);
    }
    expect(await rowsFor(scope)).toEqual([]);
  });
});

describe('CC-5 L3d 2b-2b — passage programmé', () => {
  it('cycle dégradé consigné une fois par heure, avec son code', async () => {
    const cycle = uniq('degraded');
    await brokenCycle(cycle);
    const now = () => new Date(T0 * 1000 + 3600_000 * 30);
    const first = await runScheduledControllers(db, { now });
    expect(first.cycles.find(c => c.cycle_id === cycle)).toMatchObject({ mode: 'degraded' });
    expect(first.failures_recorded).toBeGreaterThanOrEqual(1);
    const rows = await rowsFor(cycle);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/^[A-Z0-9_]+$/);
    await runScheduledControllers(db, { now });
    expect(await rowsFor(cycle)).toHaveLength(1);
  });

  it('chercheur L5 en échec : consigné sous sa portée réservée', async () => {
    const at = () => new Date(T0 * 1000 + 3600_000 * 40);
    const result = await runScheduledControllers(proxyThrowing(/research_/), { now: at });
    expect(result.research.status).toBe('failed');
    expect((await rowsFor(RESEARCH_SCOPE)).some(row => row.error === 'RESEARCH_PASS_FAILED')).toBe(true);
  });

  it('file indisponible : le passage se termine quand même (fail-soft), rien de consigné', async () => {
    const cycle = uniq('queue-down');
    await brokenCycle(cycle);
    const result = await runScheduledControllers(proxyThrowing(/controller_failures/), { now: () => new Date(T0 * 1000 + 3600_000 * 50) });
    expect(result.cycles.find(c => c.cycle_id === cycle)).toMatchObject({ mode: 'degraded' });
    expect(result.failures_recorded).toBe(0);
    expect(await rowsFor(cycle)).toEqual([]);
  });
});

describe('CC-5 L3d 2b-2b — échecs dans « À relayer »', () => {
  it('lignes d\'échec en tête, regroupées sur 24 h, pour Kevin ; un échec plus ancien n\'apparaît pas', async () => {
    const scope = uniq('relay');
    const base = T0 + 3600 * 100;
    const working = uniq('working'); // un cycle sain : au moins une ligne de décision ordinaire
    await insertCycleRow(db, working, 'P6');
    await insertPhaseDefinition(db, working, 'P6', []);
    await insertTaskRow(db, { taskId: 'l0', cycle: working, owner: 'f-a', reviewer: 'f-b', tester: 'f-c' });
    await recordFailure(db, { scope, error: 'X_ERR', now: base - 3600 * 30 }); // hors fenêtre
    await recordFailure(db, { scope, error: 'X_ERR', now: base - 3600 * 2 });
    await recordFailure(db, { scope, error: 'X_ERR', now: base - 3600 });
    const lines = await relayLines(db, { now: () => new Date(base * 1000) });
    const mine = lines.filter(line => line.cycle_id === scope);
    expect(mine).toEqual([expect.objectContaining({ actor: 'owner', label: 'Kevin', action: 'check_controller', since: base - 7200 })]);
    expect(mine[0].message).toContain('échec X_ERR sur 2 heures');
    const firstOther = lines.findIndex(line => line.action !== 'check_controller');
    const lastFailure = lines.map(line => line.action).lastIndexOf('check_controller');
    expect(lines.some(line => line.cycle_id === working)).toBe(true);
    expect(firstOther).toBeGreaterThan(-1);
    expect(lastFailure).toBeLessThan(firstOther);
    expect((await recentFailures(db, base)).some(item => item.scope === scope && item.hours === 2)).toBe(true);
  });

  it('lecture seule : avec des échecs présents, relayLines n\'émet que des SELECT', async () => {
    const scope = uniq('strict');
    await recordFailure(db, { scope, error: 'X_ERR', now: T0 + 3600 * 200 });
    const statements: string[] = [];
    let recording = false;
    const spy = proxyThrowing(/^$/, sql => { if (recording) statements.push(sql); });
    await ensureSchema(spy);
    recording = true;
    const lines = await relayLines(spy, { now: () => new Date((T0 + 3600 * 200) * 1000) });
    recording = false;
    expect(lines.some(line => line.cycle_id === scope)).toBe(true);
    expect(statements.filter(sql => !/^\s*SELECT\b/i.test(sql))).toEqual([]);
  });

  it('file illisible : aucune ligne d\'échec, le reste de la section est conservé', async () => {
    const scope = uniq('unreadable');
    await recordFailure(db, { scope, error: 'X_ERR', now: T0 + 3600 * 300 });
    const lines = await relayLines(proxyThrowing(/FROM controller_failures/), { now: () => new Date((T0 + 3600 * 300) * 1000) });
    expect(lines.some(line => line.action === 'check_controller')).toBe(false);
  });
});

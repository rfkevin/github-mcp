import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  GROWTH_ALARM_MIN_MARGIN,
  GROWTH_ALARM_PERCENT,
  MEMORY_TOKEN_BUDGETS,
  MemoryStore,
  MemoryStoreError,
  growthExceededSql,
  growthExceeds,
  growthMaxActive,
} from '../../../src/collab-store/memory/memory-store';
import { MEMORY_ALARM_CYCLE } from '../../../src/collab-store/memory/pause-resume';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-7 M1a (consultation mémoire cc7 #1023 → #1057) : marge combinée de l'alarme de croissance.
// Pause si 100·(n − base) > max(GROWTH_ALARM_PERCENT·base, 100·GROWTH_ALARM_MIN_MARGIN).
// Avant M1a, une base de 1 mettait en pause dès la 2e activation et chaque reprise à petite
// taille rechutait à l'activation suivante.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let seq = 0;
const uniq = (label: string) => `m1a-${label}-${Date.now().toString(36)}-${++seq}`;

const counter = async (day: string): Promise<number> =>
  (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(day).first<{ writes: number }>())?.writes ?? 0;

async function activeCount(scope: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE status = 'active' AND scope = ?1")
    .bind(scope).first<{ n: number }>())?.n ?? 0;
}

async function growthRequests(scope: string): Promise<number> {
  return (await db.prepare([
    "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.request'",
    "AND json_extract(payload_json, '$.scope') = ?2 AND json_extract(payload_json, '$.reason') = 'growth'",
  ].join(' ')).bind(MEMORY_ALARM_CYCLE, scope).first<{ n: number }>())?.n ?? 0;
}

/**
 * État d'un scope juste après une reprise à la taille `base` : `base` entrées actives et une
 * base de croissance égale (ce que pose resumeStatements). Écrit en SQL : seul le compte
 * d'entrées actives et la base comptent pour la règle testée ici.
 */
async function seedResumedScope(scope: string, base: number): Promise<void> {
  await ensureSchema(db);
  const rows = Array.from({ length: base }, (_, i) => db.prepare([
    "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid)",
    "VALUES (?1, 1, ?2, 'fact', ?3, '[]', 'observed', 'active', 'agent:seed', 'agent:seed2')",
  ].join(' ')).bind(uniq('seed'), scope, `s${i}`));
  await db.batch([
    ...rows,
    db.prepare('INSERT OR REPLACE INTO quota_counters (day, writes) VALUES (?1, ?2)').bind('mem:base:' + scope, base),
  ]);
}

/** Propose puis active un fait observé ; chaque activation dans son propre cycle (plafond par cycle hors sujet). */
async function activateOne(mem: MemoryStore, scope: string, text = uniq('f')): Promise<{ id: string }> {
  const p = await mem.propose({ scope, kind: 'fact', text, evidence_refs: [uniq('ev')], confidence: 'observed', author_pid: 'agent:a' });
  await mem.activate(p.id, 1, 'agent:b', uniq('cycle'));
  return p;
}

describe('CC-7 M1a — règle de croissance (fonctions pures)', () => {
  it('constantes de la règle : 25 % et marge minimale de 5 entrées', () => {
    expect(GROWTH_ALARM_PERCENT).toBe(25);
    expect(GROWTH_ALARM_MIN_MARGIN).toBe(5);
  });

  // Valeurs écrites en dur : elles figent la règle, elles ne sont pas recalculées par le test.
  // De base 21 à 23, 25 % vaut 5,25 à 5,75 et l'arrondi entier ramène la frontière à base + 6 ;
  // le pourcentage ne prend strictement la main qu'à partir de base 24 (consultation #1043-#1046).
  const frontier: Array<[base: number, lastWithoutPause: number]> = [
    [1, 6], [2, 7], [3, 8], [7, 12], [20, 25], [21, 26], [22, 27], [23, 28], [24, 30], [25, 31], [40, 50], [41, 51],
  ];

  it.each(frontier)('base %i : pas de pause jusqu’à %i entrées actives, pause à la suivante', (base, last) => {
    expect(growthMaxActive(base)).toBe(last);
    for (let n = base; n <= last; n++) expect(growthExceeds(n, base)).toBe(false);
    expect(growthExceeds(last + 1, base)).toBe(true);
  });

  it('une taille inférieure ou égale à la base ne déclenche jamais', () => {
    for (const base of [1, 2, 10, 40]) {
      for (let n = 0; n <= base; n++) expect(growthExceeds(n, base)).toBe(false);
    }
  });

  it('SQL et TypeScript appliquent la même règle (écriture et lecture ne divergent pas)', async () => {
    const pairs: Array<[number, number]> = [];
    for (let base = 1; base <= 60; base++) {
      for (let n = Math.max(0, base - 2); n <= growthMaxActive(base) + 3; n++) pairs.push([n, base]);
    }
    const sql = `SELECT CASE WHEN ${growthExceededSql('?1', '?2')} THEN 1 ELSE 0 END AS hit`;
    const results = await db.batch(pairs.map(([n, base]) => db.prepare(sql).bind(n, base)));
    const mismatches = pairs.filter(([n, base], i) =>
      ((results[i].results[0] as { hit: number }).hit === 1) !== growthExceeds(n, base));
    expect(mismatches).toEqual([]);
  });
});

describe('CC-7 M1a — frontières dans le lot d’activation réel', () => {
  it('scope neuf : base 1 posée à la 1re activation, aucune pause jusqu’à 6, pause et demande owner à 7', async () => {
    const scope = 'role:' + uniq('fresh');
    const mem = new MemoryStore(db);
    for (let n = 1; n <= growthMaxActive(1); n++) {
      await activateOne(mem, scope);
      expect(await mem.isActivationPaused(scope)).toBe(false);
      expect(await growthRequests(scope)).toBe(0);
    }
    expect(await counter('mem:base:' + scope)).toBe(1);
    await activateOne(mem, scope);
    expect(await activeCount(scope)).toBe(7);
    expect(await mem.isActivationPaused(scope)).toBe(true);
    expect(await growthRequests(scope)).toBe(1);
  });

  it.each([2, 22, 24, 40])('après une reprise à la taille %i : pause exactement à growthMaxActive + 1', async (base) => {
    const scope = 'project:' + uniq('resumed');
    const mem = new MemoryStore(db);
    await seedResumedScope(scope, base);
    const last = growthMaxActive(base);
    for (let n = base + 1; n <= last; n++) {
      await activateOne(mem, scope);
      expect(await activeCount(scope)).toBe(n);
      expect(await mem.isActivationPaused(scope)).toBe(false);
    }
    expect(await growthRequests(scope)).toBe(0);
    await activateOne(mem, scope);
    expect(await activeCount(scope)).toBe(last + 1);
    expect(await mem.isActivationPaused(scope)).toBe(true);
    expect(await growthRequests(scope)).toBe(1);
  });

  it('pause posée : l’activation suivante est refusée sans aucune écriture', async () => {
    const scope = 'role:' + uniq('blocked');
    const mem = new MemoryStore(db);
    await seedResumedScope(scope, 2);
    for (let n = 3; n <= growthMaxActive(2) + 1; n++) await activateOne(mem, scope);
    expect(await mem.isActivationPaused(scope)).toBe(true);
    const p = await mem.propose({ scope, kind: 'fact', text: 'de trop', evidence_refs: ['ev:x'], confidence: 'observed', author_pid: 'agent:a' });
    const before = { active: await activeCount(scope), base: await counter('mem:base:' + scope), occ: await counter('mem:occ:' + scope), requests: await growthRequests(scope) };
    await expect(mem.activate(p.id, 1, 'agent:b', uniq('cycle'))).rejects.toMatchObject({ code: 'ACTIVATION_PAUSED' });
    expect({ active: await activeCount(scope), base: await counter('mem:base:' + scope), occ: await counter('mem:occ:' + scope), requests: await growthRequests(scope) }).toEqual(before);
    expect((await mem.get(p.id, 1))?.status).toBe('candidate');
  });

  it('le budget de jetons reste la limite de taille : refus typé avant la règle de croissance, sans pause', async () => {
    const scope = 'task:' + uniq('budget');
    const budget = MEMORY_TOKEN_BUDGETS.task;
    const mem = new MemoryStore(db);
    // Deux entrées de 140 jetons (texte borné à 600 caractères) : 280 jetons, sous le budget
    // et loin de la frontière de croissance (2 entrées actives, base 1).
    for (const letter of ['x', 'z']) {
      await activateOne(mem, scope, letter.repeat(4 * 140));
    }
    expect(budget - 280).toBeLessThan(30);
    const extra = await mem.propose({ scope, kind: 'fact', text: 'y'.repeat(4 * 30), evidence_refs: ['ev:extra'], confidence: 'observed', author_pid: 'agent:a' });
    const error = await mem.activate(extra.id, 1, 'agent:b', uniq('cycle')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect(error).toMatchObject({ code: 'MEMORY_BUDGET_EXCEEDED' });
    expect(await activeCount(scope)).toBe(2);
    expect(await mem.isActivationPaused(scope)).toBe(false);
    expect((await mem.get(extra.id, 1))?.status).toBe('candidate');
  });
});

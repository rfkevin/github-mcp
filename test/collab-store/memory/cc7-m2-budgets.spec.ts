import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  FROZEN_SCOPE_FAMILIES,
  MEMORY_ROLES,
  MEMORY_TOKEN_BUDGETS,
  MemoryStore,
  MemoryStoreError,
  PARTICIPANT_BUDGET_FLOOR,
} from '../../../src/collab-store/memory/memory-store';
import { buildRolePacket, loadVisibleActiveMemory, memoryRolesOf, memoryVisible } from '../../../src/collab-store/context';
import { runRoles } from '../../../src/collab-store/agentrun/read-tools';
import { createReadToolHost } from '../../../src/collab-store/agentrun';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow } from '../a0-helpers';
import { assessSharedP1Write } from '../../../src/collab-store/memory/p1-independence';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { opIdClientFor, type StoreEventType } from '../../../src/collab-store/contracts';

// CC-7 M2 (décisions de Kevin #1138 §4 et #1139, GO du 2026-10-31) — budgets et portées de la mémoire :
// common 1500, project 2000, role 800, participant 1500 (plancher), task 0 gelée ; role:<rôle> servi aussi
// au coordinateur du cycle, aux chercheurs et, côté API, selon le type d'exécution (parité chat/API).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let seq = 0;
const uniq = (label: string) => `m2-${label}-${Date.now().toString(36)}-${++seq}`;

async function rows(scope: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE scope = ?1').bind(scope).first<{ n: number }>())?.n ?? 0;
}

/** Entrée active écrite en SQL (seul compte ici ce qui est servi, pas le chemin d'activation). */
async function seedActive(scope: string, text: string): Promise<string> {
  await ensureSchema(db);
  const id = uniq('seed');
  await db.prepare([
    "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid)",
    "VALUES (?1, 1, ?2, 'lesson', ?3, '[]', 'observed', 'active', 'agent:seed', 'agent:seed2')",
  ].join(' ')).bind(id, scope, text).run();
  return id;
}

/** Entrée écrite en SQL avec un statut donné (données antérieures au gel). */
async function seedRow(scope: string, text: string, status: 'active' | 'candidate', author = 'agent:seed'): Promise<string> {
  await ensureSchema(db);
  const id = uniq('row');
  await db.prepare([
    "INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid)",
    "VALUES (?1, 1, ?2, 'fact', ?3, '[\"ev:seed\"]', 'observed', ?4, ?5, '')",
  ].join(' ')).bind(id, scope, text, status, author).run();
  return id;
}

const collab = () => new CollabStore(db, { now: () => new Date('2026-11-01T10:00:00.000Z'), dailyWriteLimit: 100_000 });

/** Append par le canal store (même chemin que collab_append_event) ; renvoie le statut ou le code d'erreur. */
async function append(cycle: string, type: StoreEventType, participant: string, op: string, memory: Record<string, unknown>): Promise<string> {
  const cs = collab();
  try {
    const out = await cs.appendEvent({ cycle_id: cycle, type, participant_id: participant, expected_rev: await cs.currentRevision(cycle),
      payload_json: JSON.stringify({ memory }), op_id: opIdClientFor(participant) + ':' + cycle + ':' + op + ':1' });
    return out.status;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
}

async function journalState(cycle: string): Promise<{ revision: number; events: number }> {
  const c = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>();
  const e = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  return { revision: c?.revision ?? 0, events: e?.n ?? 0 };
}

async function versions(id: string): Promise<Array<{ version: number; status: string }>> {
  const r = await db.prepare('SELECT version, status FROM memory_entries WHERE id = ?1 ORDER BY version').bind(id).all<{ version: number; status: string }>();
  return r.results ?? [];
}

/** Cycle P2 (non gardé) pour porter les appends ; cycle de travail P1 sans tâche (coordinateur hors tâche). */
async function seedCycle(cycle: string, phase: 'P1' | 'P2'): Promise<void> {
  await db.prepare('INSERT INTO cycles (cycle_id, project, phase, revision) VALUES (?1, \'\', ?2, ?3)').bind(cycle, phase, phase === 'P1' ? 1 : 0).run();
  if (phase === 'P1') await db.prepare("INSERT INTO phase_definitions (cycle_id, phase) VALUES (?1, 'P1')").bind(cycle).run();
}

/** Propose puis active (relecteur distinct), chaque activation dans son propre cycle. */
async function activateOne(mem: MemoryStore, scope: string, text: string, author = 'agent:a', reviewer = 'agent:b') {
  const p = await mem.propose({ scope, kind: 'lesson', text, evidence_refs: [uniq('ev')], confidence: 'observed', author_pid: author });
  await mem.activate(p.id, 1, reviewer, uniq('cycle'));
  return p;
}

describe('CC-7 M2 — budgets de jetons par portée', () => {
  it('enveloppe décidée : common 1500, project 2000, role 800, participant 1500, task 0 (5 800 au total)', () => {
    expect(MEMORY_TOKEN_BUDGETS).toEqual({ common: 1500, project: 2000, role: 800, participant: 1500, task: 0 });
    expect(Object.values(MEMORY_TOKEN_BUDGETS).reduce((a, b) => a + b, 0)).toBe(5800);
  });

  it('plancher participant : 1500, jamais sous le plancher (agents sans chat compris)', () => {
    expect(PARTICIPANT_BUDGET_FLOOR).toBe(1500);
    expect(MEMORY_TOKEN_BUDGETS.participant).toBeGreaterThanOrEqual(PARTICIPANT_BUDGET_FLOOR);
  });

  it('role : 800 jetons — 700 acceptés, l’entrée qui dépasse est refusée sans effet', async () => {
    const mem = new MemoryStore(db);
    const scope = 'role:' + uniq('budget');
    // Texte borné à 600 caractères (150 jetons) : 5 entrées de 140 jetons = 700, sous la marge de croissance (base 1 → 6).
    for (const letter of ['a', 'b', 'd', 'e', 'f']) await activateOne(mem, scope, letter.repeat(4 * 140));
    const extra = await mem.propose({ scope, kind: 'lesson', text: 'c'.repeat(4 * 120), evidence_refs: ['ev:x'], confidence: 'observed', author_pid: 'agent:a' });
    const error = await mem.activate(extra.id, 1, 'agent:b', uniq('cycle')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MEMORY_BUDGET_EXCEEDED' });
    expect((await mem.get(extra.id, 1))?.status).toBe('candidate');
  });
});

describe('CC-7 M2 — portée task gelée', () => {
  it('la famille task est gelée et sans budget', () => {
    expect([...FROZEN_SCOPE_FAMILIES]).toEqual(['task']);
    expect(MEMORY_TOKEN_BUDGETS.task).toBe(0);
  });

  it('memory.propose en task:<id> → MEMORY_SCOPE_FROZEN, rien n’est écrit', async () => {
    const mem = new MemoryStore(db);
    const scope = 'task:' + uniq('frozen');
    const error = await mem.propose({ scope, kind: 'lesson', text: 'reprise', evidence_refs: ['ev:x'], confidence: 'observed', author_pid: 'agent:a' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MemoryStoreError);
    expect(error).toMatchObject({ code: 'MEMORY_SCOPE_FROZEN' });
    expect(await rows(scope)).toBe(0);
  });

  it('revue GPT-6 R2 : consolider une entrée task active → MEMORY_SCOPE_FROZEN, ancienne active intacte, rien d’écrit', async () => {
    await ensureSchema(db);
    const cycle = uniq('r2');
    await seedCycle(cycle, 'P2');
    const id = await seedRow('task:' + uniq('t'), 'note de tâche active', 'active', 'agent:m2-alpha');
    const before = await journalState(cycle);
    expect(await append(cycle, 'memory.consolidate', 'agent:m2-alpha', 'sup', { id, text: 'v2', evidence_refs: ['ev:v2'] }))
      .toBe('MEMORY_SCOPE_FROZEN');
    expect(await versions(id)).toEqual([{ version: 1, status: 'active' }]);
    expect(await journalState(cycle)).toEqual(before);
    // Chemin direct du MemoryStore : même refus.
    const error = await new MemoryStore(db).supersede(id, 'agent:m2-alpha', 'v2', ['ev:v2']).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MEMORY_SCOPE_FROZEN' });
    expect(await versions(id)).toEqual([{ version: 1, status: 'active' }]);
  });

  it('une candidate task antérieure au gel n’est jamais activée (MEMORY_SCOPE_FROZEN, reste candidate)', async () => {
    const cycle = uniq('r2b');
    await seedCycle(cycle, 'P2');
    const id = await seedRow('task:' + uniq('t'), 'candidate de tâche', 'candidate', 'agent:m2-alpha');
    const before = await journalState(cycle);
    expect(await append(cycle, 'memory.review', 'agent:m2-beta', 'rev', { id, version: 1 })).toBe('MEMORY_SCOPE_FROZEN');
    expect(await versions(id)).toEqual([{ version: 1, status: 'candidate' }]);
    expect(await journalState(cycle)).toEqual(before);
  });

  it('une entrée task existante reste lisible pour la tâche (gel, pas suppression)', async () => {
    const task = uniq('t');
    const id = await seedActive('task:' + task, 'ancienne note de tâche');
    const memory = await loadVisibleActiveMemory(db, { participantId: 'p-x', taskId: task });
    expect(memory.map(m => m.id)).toContain(id);
  });
});

describe('CC-7 M2 — portée role servie à qui tient le rôle', () => {
  it('rôles conseillés : owner, reviewer, tester, coordinator, researcher', () => {
    expect([...MEMORY_ROLES]).toEqual(['owner', 'reviewer', 'tester', 'coordinator', 'researcher']);
  });

  it('memoryVisible : rôle de tâche historique OU rôle supplémentaire ; jamais un rôle non tenu', () => {
    const ctx = { participantId: 'p', role: 'reviewer', roles: new Set(['coordinator']) };
    expect(memoryVisible('role:reviewer', ctx)).toBe(true);
    expect(memoryVisible('role:coordinator', ctx)).toBe(true);
    expect(memoryVisible('role:tester', ctx)).toBe(false);
    expect(memoryVisible('role:', ctx)).toBe(false);
    expect(memoryVisible('role:coordinator', { participantId: 'p' })).toBe(false);
  });

  it('coordinator : seulement pour l’identité qui détient le mandat du cycle', async () => {
    await ensureSchema(db);
    await db.prepare('CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)').run();
    const cycle = uniq('cyc');
    await db.prepare('INSERT INTO delegated_mandates (cycle_id, participant_id, family_id, epoch, updated_at) VALUES (?1, ?2, ?2, 1, 1)').bind(cycle, 'p-coord').run();
    expect([...await memoryRolesOf(db, cycle, new Set(['p-coord']), ['tester'])].sort()).toEqual(['coordinator', 'tester']);
    expect([...await memoryRolesOf(db, cycle, new Set(['p-other']))]).toEqual([]);
    expect([...await memoryRolesOf(db, uniq('sans-mandat'), new Set(['p-coord']))]).toEqual([]);
  });

  it('paquet du chat : le coordinateur reçoit role:coordinator, un autre participant non', async () => {
    await db.prepare('CREATE TABLE IF NOT EXISTS delegated_mandates (cycle_id TEXT PRIMARY KEY, participant_id TEXT, family_id TEXT, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)').run();
    const cycle = uniq('pkt');
    await insertCycleRow(db, cycle, 'P6');
    await db.prepare('INSERT INTO delegated_mandates (cycle_id, participant_id, family_id, epoch, updated_at) VALUES (?1, ?2, ?2, 1, 1)').bind(cycle, 'p-m2-coord').run();
    const id = await seedActive('role:coordinator', 'piège du coordinateur ' + uniq('x'));
    const coord = await buildRolePacket(db, { cycle, participant_id: 'p-m2-coord' }, { c0BaselineTokens: 12_000 });
    const other = await buildRolePacket(db, { cycle, participant_id: 'p-m2-other' }, { c0BaselineTokens: 12_000 });
    expect(coord.memory.map(m => m.id)).toContain(id);
    expect(other.memory.map(m => m.id)).not.toContain(id);
  });

  it('canal API, store_memory : une exécution de relecture voit role:reviewer, une réponse non', async () => {
    await ensureAgentRunSchema(db);
    const cycle = uniq('api');
    await insertCycleRow(db, cycle, 'P6');
    const reviewerNote = await seedActive('role:reviewer', 'piège de relecture ' + uniq('r'));
    const host = createReadToolHost({ db, repository: null, github: null, continuity: true });
    const read = async (taskKind: string) => {
      const runId = uniq('run-' + taskKind);
      const created = await createRun(db, { runId, cycleId: cycle, participantId: 'p-m2-api-' + taskKind, taskId: 't-' + taskKind, taskKind,
        prompt: 'p', maxSteps: 3, maxTokens: 100, maxCostCents: 0, deadlineAt: 10_000, now: 1_000 });
      expect(created.created).toBe(true);
      const out = await host.execute({ id: '1', name: 'store_memory', args: {} }, { run_id: runId }) as { entries: Array<{ id: string }> };
      return out.entries.map(entry => entry.id);
    };
    expect(await read('review')).toContain(reviewerNote);
    expect(await read('answer')).not.toContain(reviewerNote);
  });

  it('canal API : rôle déduit du type d’exécution (parité avec le rôle de tâche du chat)', () => {
    expect(runRoles('review')).toEqual(['reviewer']);
    expect(runRoles('test')).toEqual(['tester']);
    expect(runRoles('implement')).toEqual(['owner']);
    expect(runRoles('research')).toEqual(['researcher']);
    expect(runRoles('answer')).toEqual([]);
    expect(runRoles('design')).toEqual([]);
  });
});

describe('CC-7 M2 — garde P1 (X5) alignée sur la visibilité role (revue GPT-6 R1)', () => {
  it('cycle de travail P1 sans tâche : role:coordinator et role:researcher bloqués ; owner/reviewer/tester et rôle inconnu non', async () => {
    await ensureSchema(db);
    const p1 = uniq('p1-unit');
    await seedCycle(p1, 'P1');
    try {
      for (const scope of ['role:coordinator', 'role:researcher']) expect((await assessSharedP1Write(db, scope, null)).blocked, scope).toBe(true);
      for (const scope of ['role:owner', 'role:reviewer', 'role:tester', 'role:xyz']) expect((await assessSharedP1Write(db, scope, null)).blocked, scope).toBe(false);
    } finally {
      await db.prepare("UPDATE cycles SET phase = 'P2' WHERE cycle_id = ?1").bind(p1).run();
    }
  });

  it('pendant P1 : propose, review et consolidate en role:coordinator / role:researcher refusés, rien d’écrit ; acceptés hors P1', async () => {
    await ensureSchema(db);
    const alpha = 'agent:m2-alpha';
    const beta = 'agent:m2-beta';
    const b = uniq('p2');
    await seedCycle(b, 'P2');
    // Avant P1 : une active role:coordinator et une candidate role:researcher (chemins acceptés).
    const coord = uniq('coord');
    expect(await append(b, 'memory.propose', alpha, 'p-coord', { id: coord, scope: 'role:coordinator', kind: 'fact',
      text: 'piège coordinateur', evidence_refs: ['ev:coord'], confidence: 'observed' })).toBe('applied');
    expect(await append(b, 'memory.review', beta, 'r-coord', { id: coord, version: 1 })).toBe('applied');
    const res = uniq('res');
    expect(await append(b, 'memory.propose', alpha, 'p-res', { id: res, scope: 'role:researcher', kind: 'fact',
      text: 'piège chercheur', evidence_refs: ['ev:res'], confidence: 'observed' })).toBe('applied');
    const p1 = uniq('p1');
    await seedCycle(p1, 'P1');
    try {
      const before = await journalState(b);
      for (const scope of ['role:coordinator', 'role:researcher']) {
        expect(await append(b, 'memory.propose', alpha, 'blk-' + scope.slice(5), { id: uniq('blk'), scope, kind: 'fact',
          text: 'bloqué ' + scope, evidence_refs: ['ev:blk'], confidence: 'observed' }), scope).toBe('MEMORY_P1_SHARED_MUTATION');
      }
      expect(await append(b, 'memory.review', beta, 'r-res', { id: res, version: 1 })).toBe('MEMORY_P1_SHARED_MUTATION');
      expect(await append(b, 'memory.consolidate', alpha, 'sup-coord', { id: coord, text: 'piège coordinateur v2', evidence_refs: ['ev:coord2'] }))
        .toBe('MEMORY_P1_SHARED_MUTATION');
      expect(await journalState(b)).toEqual(before);
      expect(await versions(coord)).toEqual([{ version: 1, status: 'active' }]);
      expect(await versions(res)).toEqual([{ version: 1, status: 'candidate' }]);
    } finally {
      await db.prepare("UPDATE cycles SET phase = 'P2' WHERE cycle_id = ?1").bind(p1).run();
    }
    // Hors P1, la candidate chercheur s'active normalement.
    expect(await append(b, 'memory.review', beta, 'r-res-after', { id: res, version: 1 })).toBe('applied');
  });
});

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

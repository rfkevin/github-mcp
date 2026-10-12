import { expect } from 'vitest';
import { CollabStore } from '../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../src/collab-store/store/schema';

/**
 * CC-4 A0 (github-mcp#110) — outillage partagé des specs du lot : un seul
 * exemplaire des helpers communs (store daté pour le quota, code d'erreur,
 * compteurs SQL, amorçage de lignes hors chemin agent, assertion de refus)
 * pour ne pas multiplier les blocs dupliqués que le contrôle qualité plafonne
 * à 3 % de duplication sur le nouveau code.
 */

let storeDay = 0;

/** Un jour distinct par store : les compteurs de quota ne fuient pas entre tests. */
export function makeDatedStore(db: D1Database): CollabStore {
  storeDay += 1;
  const stamp = '2026-12-' + String(storeDay).padStart(2, '0') + 'T10:00:00.000Z';
  return new CollabStore(db, { dailyWriteLimit: 100_000, now: () => new Date(stamp) });
}

/** Code de l'erreur typée (StateContractError comme CollabStoreError). */
export const codeOf = (error: unknown): string => (error as { code: string }).code;

/** Nombre d'événements du cycle, filtrable par type. */
export async function countEvents(db: D1Database, cycle: string, type?: string): Promise<number> {
  await ensureSchema(db);
  const row = type === undefined
    ? await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>()
    : await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = ?2').bind(cycle, type).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Nombre d'enveloppes scellées du cycle. */
export async function countSealed(db: D1Database, cycle: string): Promise<number> {
  await ensureSchema(db);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM sealed_items WHERE cycle_id = ?1')
    .bind(cycle).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Ligne de cycle en SQL (amorçage) : revision 1, statut open par défaut. */
export async function insertCycleRow(db: D1Database, cycle: string, phase: string, status = 'open'): Promise<void> {
  await ensureSchema(db);
  await db.prepare('INSERT INTO cycles (cycle_id, phase, revision, status) VALUES (?1, ?2, 1, ?3)')
    .bind(cycle, phase, status).run();
}

/** Définition de phase en SQL (amorçage) : conditions vides, auto_advance none. */
export async function insertPhaseDefinition(db: D1Database, cycle: string, phase: string, expectedOutputs: unknown): Promise<void> {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO phase_definitions (cycle_id, phase, entry_conditions, expected_outputs, exit_conditions, auto_advance)',
    "VALUES (?1, ?2, '[]', ?3, '[]', 'none')",
  ].join(' ')).bind(cycle, phase, JSON.stringify(expectedOutputs)).run();
}

/** Tâche en SQL (amorçage) : in_progress, aucun chemin possédé. */
export async function insertTaskRow(db: D1Database, input: { taskId: string; cycle: string; owner: string; reviewer: string; tester: string }): Promise<void> {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES (?1, ?2, ?3, ?4, ?5, 'in_progress', '[]', '', '', 1)",
  ].join(' ')).bind(input.taskId, input.cycle, input.owner, input.reviewer, input.tester).run();
}

/** Événement en SQL, hors chemin agent (amorçage de ronde CR-F01 ou d'état). */
export async function insertEventRow(db: D1Database, input: {
  cycle: string;
  type: string;
  participant: string;
  role: string;
  payload: unknown;
  key: string;
  expectedRev?: number;
}): Promise<void> {
  await ensureSchema(db);
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, 1, ?2, ?3, '', ?4, ?5, ?6, ?7, '')",
  ].join(' ')).bind(input.cycle, input.type, input.participant, input.role,
    JSON.stringify(input.payload), input.expectedRev ?? 0, input.key).run();
}

/** Le call doit être refusé avec la classe et le code d'erreur attendus. */
export async function expectRejected<T extends Error>(
  call: () => unknown,
  errorClass: new (...args: never[]) => T,
  code: string,
  label: string,
): Promise<void> {
  try {
    await call();
    expect.unreachable('accepté à tort : ' + label);
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    expect(codeOf(error)).toBe(code);
  }
}

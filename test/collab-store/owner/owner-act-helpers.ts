import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';

// CC-Owner V2 — harnais partagé des suites owner (L2 close.spec, L3 classify.spec).
// Une seule définition : la duplication comptée par SonarCloud disparaît.

export const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
export const proof = { kind: 'secret' as const, subject: 'owner-secret' };
export const delegatedProof = (cycleId: string) => ({ kind: 'delegated' as const, subject: 'reviewer', cycle_id: cycleId,
  epoch: 0, request_id: 'req', reviewer_pid: 'agent:b', reviewer_family: 'agent:b', expires_at: 0,
  params_hash: 'h', max_cost_cents: 0 });

let n = 0;
/** Compteur partagé des suffixes op_id des tests (fileRequest, appends directs). */
export const nextSerial = () => ++n;
export const uniq = (label: string) => `ccown-${label}-${++n}`;

const days = new Map<string, number>();
/** Un jour distinct par store, dans le mois dédié à la suite, sans recouvrement entre suites. */
export function makeStoreForMonth(month: string): CollabStore {
  const day = (days.get(month) ?? 0) + 1;
  days.set(month, day);
  const stamp = `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  return new CollabStore(db, { now: () => new Date(stamp) });
}

/** Préfixe du jour courant d’un mois dédié (après makeStoreForMonth), pour quota_counters. */
export function dayStamp(month: string): string {
  return `${month}-${String(days.get(month) ?? 0).padStart(2, '0')}`;
}

export function codeOf(error: unknown): string {
  return (error as { code: string }).code;
}

/** Capture le refus (code + message) ; échoue si la promesse aboutit. */
export async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('un refus était attendu');
}

/** Dépose une demande d’agent valide sur le cycle et renvoie la seq de son événement. */
export async function fileRequest(store: CollabStore, cycle: string, rev: number, requestId: string): Promise<number> {
  const outcome = await store.appendEvent({ cycle_id: cycle, type: 'owner.request', participant_id: 'agent:a',
    expected_rev: rev, op_id: `agent.a:${cycle}:req:${nextSerial()}`, payload_json: JSON.stringify({ request_id: requestId, summary: 'demande de test' }) });
  expect(outcome.status).toBe('applied');
  const row = await db.prepare(
    "SELECT seq FROM events WHERE cycle_id = ?1 AND type IN ('owner.request', 'phase.request') ORDER BY seq DESC LIMIT 1"
  ).bind(cycle).first<{ seq: number }>();
  return row!.seq;
}

export async function countEvents(cycle: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>())?.n ?? 0;
}

/** Compte les événements owner.decision d’une action, request_seq optionnel. */
export async function countOwnerActionEvents(cycle: string, action: string, requestSeq?: number): Promise<number> {
  let sql = "SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'owner.decision' AND json_valid(payload_json)"
    + " AND json_extract(payload_json, '$.action') = ?2";
  if (requestSeq !== undefined) sql += " AND json_extract(payload_json, '$.request_seq') = ?3";
  const stmt = requestSeq === undefined ? db.prepare(sql).bind(cycle, action) : db.prepare(sql).bind(cycle, action, requestSeq);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
}

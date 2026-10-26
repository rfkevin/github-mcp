import { expect } from 'vitest';
import { createRun, leaseKeyOf, type ParticipantEnvelope } from '../../../src/collab-store/agentrun';
import { ensureSchema } from '../../../src/collab-store/store/schema';

/**
 * CC-7 L2 — harnais partagé des suites d'adaptateurs payants (Z.ai PR 2.1,
 * xAI PR 2.2) : fetch scripté, exécution fraîche, lecture des registres du
 * participant et des lignes d'étape payante. La base D1 est fournie par la
 * suite appelante (COLLAB_DB_C2 de cloudflare:test) ; aucun appel réel.
 */

/** Enveloppe financée de référence (valeurs P5 Q1 de Kevin, plafonds optionnels à 0). */
export const FUNDED: ParticipantEnvelope = { dayCents: 200, cycleCents: 1_000, dayTokens: 0, dayRequests: 0 };

/** Faux fetch : la réponse scriptée suivante, ou l’erreur fournie ; enregistre chaque appel. */
export function fetchStub(script: unknown[]) {
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = script[seen.length - 1];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('fetch_stub_exhausted');
    return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Réponse compatible OpenAI avec usage explicite. */
export function reply(content: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  return { choices: [{ message: { content } }], usage };
}

let seq = 0;

/** Exécution fraîche de test : identifiants uniques par préfixe (une suite = un préfixe). */
export async function freshRun(db: D1Database, prefix: string, at: number, maxCostCents = 10_000, participantId = 'vibe') {
  await ensureSchema(db);
  const id = ++seq;
  const input = {
    runId: prefix + '-run-' + id + '-' + Date.now().toString(36), cycleId: prefix + '-cycle-' + id, participantId, taskId: prefix,
    taskKind: 'answer', prompt: 'Réponds à la question du cycle.', maxSteps: 10, maxTokens: 1_000_000,
    maxCostCents, deadlineAt: at + 86_400, now: at,
  };
  expect((await createRun(db, input)).created).toBe(true);
  return { ...input, leaseKey: leaseKeyOf(input.cycleId, input.participantId, input.taskId) };
}

/** Valeur d’un registre quota_counters (cents, jetons ou requêtes du participant). */
export async function quotaOf(db: D1Database, key: string): Promise<number> {
  return (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(key).first<{ writes: number }>())?.writes ?? 0;
}

/** Ligne d’étape payante : réservation en cours ou règlement passé. */
export async function stepRow(db: D1Database, runId: string, n: number) {
  return db.prepare('SELECT reserved_cents, actual_cents, settled FROM agent_paid_steps WHERE run_id = ?1 AND n = ?2')
    .bind(runId, n).first<{ reserved_cents: number; actual_cents: number; settled: number }>();
}

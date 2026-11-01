import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { planAgentRuns } from '../../../src/collab-store/agentrun';
import { runCapacity } from '../../../src/collab-store/agentrun/capacity';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { OWNER_PROOF } from '../coordinator-helpers';

// CC-8 S1a (CC-PLAN-8, synthèse seq 1262 validée par Kevin) — capacité et équité du planificateur.
// Constat réel du 2026-11-01 (cc8-systeme-unique) : les exécutions de Claude et Grok (aucune clé ni budget dans
// leur famille) étaient créées puis échouaient aussitôt en MODEL_BUDGET_EXHAUSTED en occupant les places du
// passage ; Gemini, dernier de la liste, n'était pas servi. On rejoue cette configuration (variables cc3-test
// lues dans wrangler.jsonc, clé Gemini posée, aucune clé Anthropic/xAI, binding Workers AI présent).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const wrangler = JSON.parse(wranglerRaw) as { env: Record<string, { vars: Record<string, string> }> };
const CC3_VARS = wrangler.env['cc3-test'].vars;
const AGENTS = ['claude', 'grok', 'vibe', 'gemini'];
const CC3_TEST = { ...CC3_VARS, AI: {}, LLM_KEY_GEMINI: 'k', AGENT_RUN_GITHUB_WRITES: 'true', AGENT_RUN_PARTICIPANTS: AGENTS.join(',') };
let n = 0;

/** Cycle P6 (ordre de tri en tête) : une tâche par agent, chacune sans soumission → réveil « implémenter » de l'auteur. */
async function seed(label: string): Promise<string> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  // Isolation : les cycles des tests précédents (base partagée) sont fermés, seul le nouveau est planifié.
  await db.prepare("UPDATE cycles SET status = 'closed' WHERE status = 'open'").run();
  const cycle = ('0000-cc8-s1a-' + label + '-' + (++n)).slice(0, 48);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  for (const pid of AGENTS) {
    await registerParticipant(db, { participant_id: pid, display_label: pid, proof: OWNER_PROOF, op: 'reg-' + pid + '-' + cycle })
      .catch(() => undefined);
  }
  for (const [i, owner] of AGENTS.entries()) {
    await insertTaskRow(db, { taskId: 't-' + owner, cycle, owner,
      reviewer: AGENTS[(i + 1) % AGENTS.length], tester: AGENTS[(i + 2) % AGENTS.length] });
  }
  return cycle;
}

async function runsOf(cycle: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT participant_id FROM agent_runs WHERE cycle_id = ?1 ORDER BY participant_id')
    .bind(cycle).all<{ participant_id: string }>();
  return (results ?? []).map(row => row.participant_id);
}

describe('CC-8 S1a — capacité réelle avant toute exécution', () => {
  it('runCapacity : Claude et Grok incapables (clé absente), Vibe (Workers AI) et Gemini (clé + attestation) capables', async () => {
    await ensureSchema(db);
    const now = new Date('2032-11-02T10:00:00Z');
    const result = Object.fromEntries(await Promise.all(AGENTS.map(async pid => [pid, await runCapacity(db, CC3_TEST, pid, null, 'implement', now)])));
    expect(result.claude.capable).toBe(false);
    expect(result.claude.reason).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(result.grok.capable).toBe(false);
    expect(result.vibe).toEqual({ capable: true, reason: 'workers-ai:@cf/zai-org/glm-4.7-flash' });
    expect(result.gemini.capable).toBe(true);
    expect(result.gemini.reason).toMatch(/^gemini:/);
    // La capacité suit la configuration : sans clé Gemini, Gemini retombe sur Gemma (Workers AI, sa famille).
    const noKey = { ...CC3_TEST, LLM_KEY_GEMINI: undefined };
    expect((await runCapacity(db, noKey, 'gemini', null, 'implement', now)).reason).toBe('workers-ai:@cf/google/gemma-4-26b-a4b-it');
    // Ni politique ni modèle global : refus typé.
    expect(await runCapacity(db, {}, 'gemini', null, 'implement', now)).toEqual({ capable: false, reason: 'NO_MODEL : aucune politique ni modèle global' });
  });

  it('état réel du 2026-11-01 rejoué : aucune exécution pour Claude ni Grok, Gemini servi au premier passage', async () => {
    const cycle = await seed('rejeu');
    const result = await planAgentRuns(db, CC3_TEST, { now: 1_983_000_000 });
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe']);
    expect(result.created).toBe(2);
    expect(result.incapable).toBe(2);
    // Passage suivant : les réveils de Claude et Grok restent en attente, rien n'est créé pour eux.
    const again = await planAgentRuns(db, CC3_TEST, { now: 1_983_000_900 });
    expect(again.incapable).toBe(2);
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe']);
  });

  it('la capacité revenue, le réveil en attente est servi (ici : modèle global pour un agent sans politique)', async () => {
    const cycle = await seed('retour');
    const withoutPolicy = { AGENT_RUN_PARTICIPANTS: 'claude', AGENT_RUN_GITHUB_WRITES: 'true' } as Record<string, unknown>;
    // Aucune configuration de modèle du tout : comportement historique conservé (exécution créée).
    expect((await planAgentRuns(db, withoutPolicy as never, { now: 1_984_000_000 })).created).toBe(1);
    expect(await runsOf(cycle)).toEqual(['claude']);
  });
});

describe('CC-8 S1a — service à tour de rôle', () => {
  it('limite d’un passage partagée entre agents : chacun son tour, dans l’ordre de la liste', async () => {
    const cycle = await seed('tour');
    const capableOnly = { ...CC3_TEST, AGENT_RUN_PARTICIPANTS: 'vibe,gemini' };
    const first = await planAgentRuns(db, capableOnly, { now: 1_985_000_000, limit: 1 });
    expect(first).toMatchObject({ created: 1, considered: 1 });
    expect(await runsOf(cycle)).toEqual(['vibe']);
    const second = await planAgentRuns(db, capableOnly, { now: 1_985_000_060, limit: 2 });
    expect(second.created).toBe(1);
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe']);
  });
});

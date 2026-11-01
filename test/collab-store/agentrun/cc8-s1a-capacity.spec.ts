import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { planAgentRuns } from '../../../src/collab-store/agentrun';
import { runCapacity } from '../../../src/collab-store/agentrun/capacity';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { decisionKey, ensureControllerJournal } from '../../../src/collab-store/controller/journal';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
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
const NOW = new Date('2032-11-02T10:00:00Z');
let n = 0;

/**
 * Cycle P6 (ordre de tri en tête), seul cycle ouvert : chaque tâche sans soumission → réveil « implémenter » de
 * son auteur. `owners` liste l'auteur de chaque tâche (un auteur peut en avoir plusieurs).
 */
async function seed(label: string, owners: string[] = AGENTS): Promise<string> {
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
  for (const [i, owner] of owners.entries()) {
    const others = AGENTS.filter(pid => pid !== owner);
    await insertTaskRow(db, { taskId: 't' + i + '-' + owner, cycle, owner, reviewer: others[0], tester: others[1] });
  }
  return cycle;
}

async function runsOf(cycle: string): Promise<string[]> {
  const { results } = await db.prepare('SELECT participant_id FROM agent_runs WHERE cycle_id = ?1 ORDER BY participant_id')
    .bind(cycle).all<{ participant_id: string }>();
  return (results ?? []).map(row => row.participant_id);
}

/** Réveil d'un agent journalisé par le contrôleur à `at` (ancienneté réelle lue par le planificateur). */
async function journalWakes(cycle: string, participantId: string, at: number): Promise<void> {
  await ensureControllerJournal(db);
  for (const decision of (await previewNextActions(db, cycle, participantId)).mine) {
    await db.prepare(`INSERT INTO controller_decisions (cycle_id, decision_key, revision, kind, actor, task_id, action, rule, subject,
      reason, state_hash, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'h', ?10)`)
      .bind(cycle, await decisionKey(cycle, decision), decision.kind, decision.actor, decision.task_id ?? '', decision.action,
        decision.rule, decision.subject, decision.reason, at).run();
  }
}

describe('CC-8 S1a — capacité réelle (runCapacity)', () => {
  it('avec politique : Claude et Grok incapables (clé absente), Vibe (Workers AI) et Gemini (clé + attestation) capables', async () => {
    await ensureSchema(db);
    const result = Object.fromEntries(await Promise.all(AGENTS.map(async pid => [pid, await runCapacity(db, CC3_TEST, pid, null, 'implement', NOW)])));
    expect(result.claude.capable).toBe(false);
    expect(result.claude.reason).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(result.grok.capable).toBe(false);
    expect(result.vibe).toEqual({ capable: true, reason: 'workers-ai:@cf/zai-org/glm-4.7-flash' });
    expect(result.gemini.capable).toBe(true);
    expect(result.gemini.reason).toMatch(/^gemini:/);
    // La capacité suit la configuration : sans clé Gemini, Gemini retombe sur Gemma (Workers AI, sa famille)…
    const noKey = { ...CC3_TEST, LLM_KEY_GEMINI: undefined };
    expect((await runCapacity(db, noKey, 'gemini', null, 'implement', NOW)).reason).toBe('workers-ai:@cf/google/gemma-4-26b-a4b-it');
    // … et sans clé ni binding AI, plus rien.
    expect((await runCapacity(db, { ...noKey, AI: undefined }, 'gemini', null, 'implement', NOW)).capable).toBe(false);
  });

  it('sans politique : la référence unique passe les mêmes règles que la fabrique (registre, palier, clé, budget)', async () => {
    await ensureSchema(db);
    const solo = (extra: Record<string, unknown>) => runCapacity(db, extra, 'solo', null, 'implement', NOW);
    // Ni politique ni référence : refus typé.
    expect(await solo({})).toEqual({ capable: false, reason: 'NO_MODEL : aucune politique ni modèle global' });
    // Référence inconnue (relecture GPT-6, seq 1289) : refusée, plus de faux positif.
    expect(await solo({ AGENT_RUN_MODEL_SOLO: 'anthropic:modele-inconnu', LLM_KEY_ANTHROPIC: 'k' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/^MODEL_ROUTE_REFUSED : anthropic:modele-inconnu — /) });
    // Fournisseur inconnu.
    expect((await solo({ AGENT_RUN_MODEL_SOLO: 'inconnu:x' })).capable).toBe(false);
    // Référence tarifée connue, clé absente.
    expect(await solo({ AGENT_RUN_MODEL_SOLO: 'anthropic:claude-haiku-5-5' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/clé absente/) });
    // Clé présente, budget nul (enveloppe non financée).
    expect(await solo({ AGENT_RUN_MODEL_SOLO: 'anthropic:claude-haiku-5-5', LLM_KEY_ANTHROPIC: 'k' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/^MODEL_BUDGET_EXHAUSTED : anthropic:claude-haiku-5-5/) });
    // Clé et enveloppe propres à l'agent : capable.
    expect(await solo({ AGENT_RUN_MODEL_SOLO: 'anthropic:claude-haiku-5-5', LLM_KEY_ANTHROPIC: 'k',
      AGENT_RUN_PAID_DAY_CENTS_SOLO: '500', AGENT_RUN_PAID_CYCLE_CENTS_SOLO: '500' }))
      .toEqual({ capable: true, reason: 'anthropic:claude-haiku-5-5' });
    // AGENT_RUN_MODEL (palier gratuit) n'accepte jamais un modèle payant, même financé.
    expect(await solo({ AGENT_RUN_MODEL: 'anthropic:claude-haiku-5-5', LLM_KEY_ANTHROPIC: 'k',
      AGENT_RUN_PAID_DAY_CENTS_SOLO: '500', AGENT_RUN_PAID_CYCLE_CENTS_SOLO: '500' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/AGENT_RUN_MODEL n’accepte qu’un modèle gratuit/) });
    // Gratuit Workers AI : binding exigé.
    expect((await solo({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash' })).capable).toBe(false);
    expect(await solo({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: {} }))
      .toEqual({ capable: true, reason: 'workers-ai:@cf/zai-org/glm-4.7-flash' });
  });
});

describe('CC-8 S1a — planificateur : aucune exécution vouée à l’échec', () => {
  it('état réel du 2026-11-01 rejoué : aucune exécution pour Claude ni Grok, Gemini servi au premier passage, motifs rendus', async () => {
    const cycle = await seed('rejeu');
    const result = await planAgentRuns(db, CC3_TEST, { now: 1_983_000_000 });
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe']);
    expect(result.created).toBe(2);
    expect(result.incapable).toBe(2);
    expect(result.incapable_detail?.map(row => [row.participant_id, row.cycle_id, row.kind])).toEqual([
      ['claude', cycle, 'implement'], ['grok', cycle, 'implement']]);
    for (const row of result.incapable_detail ?? []) expect(row.reason).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    // Passage suivant : les réveils de Claude et Grok restent en attente, rien n'est créé pour eux.
    const again = await planAgentRuns(db, CC3_TEST, { now: 1_983_000_900 });
    expect(again.incapable).toBe(2);
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe']);
  });

  it('retour de capacité : le réveil resté en attente est servi dès que la clé revient', async () => {
    const cycle = await seed('retour', ['gemini']);
    const offline = { ...CC3_TEST, AGENT_RUN_PARTICIPANTS: 'gemini', LLM_KEY_GEMINI: undefined, AI: undefined };
    const before = await planAgentRuns(db, offline, { now: 1_984_000_000 });
    expect(before).toMatchObject({ created: 0, incapable: 1 });
    expect(before.incapable_detail?.[0].reason).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(await runsOf(cycle)).toEqual([]);
    const after = await planAgentRuns(db, { ...offline, LLM_KEY_GEMINI: 'k' }, { now: 1_984_000_900 });
    expect(after.created).toBe(1);
    expect(after.incapable).toBeUndefined();
    expect(await runsOf(cycle)).toEqual(['gemini']);
  });

  it('aucune configuration de modèle : aucune exécution (plus de capacité supposée), motif NO_MODEL', async () => {
    const cycle = await seed('sans-modele', ['claude']);
    const out = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: 'claude', AGENT_RUN_GITHUB_WRITES: 'true' }, { now: 1_984_100_000 });
    expect(out).toMatchObject({ created: 0, incapable: 1 });
    expect(out.incapable_detail?.[0].reason).toBe('NO_MODEL : aucune politique ni modèle global');
    expect(await runsOf(cycle)).toEqual([]);
  });
});

describe('CC-8 S1a — équité par ancienneté, à tour de rôle', () => {
  const two = { ...CC3_TEST, AGENT_RUN_PARTICIPANTS: 'vibe,gemini' };

  it('limite 1 constante : le réveil le plus ancien passe avant un agent de tête riche en réveils récents', async () => {
    // Vibe en tête de liste avec trois réveils récents ; Gemini avec un réveil plus ancien (journal du contrôleur).
    const cycle = await seed('anciennete', ['vibe', 'vibe', 'vibe', 'gemini']);
    await journalWakes(cycle, 'gemini', 1_985_000_000 - 3600);
    await journalWakes(cycle, 'vibe', 1_985_000_000 - 60);
    const first = await planAgentRuns(db, two, { now: 1_985_000_000, limit: 1 });
    expect(first.created).toBe(1);
    expect(await runsOf(cycle)).toEqual(['gemini']);
    // Passages suivants, limite toujours 1 : Vibe, une par passage.
    for (const [i, expected] of [['gemini', 'vibe'], ['gemini', 'vibe', 'vibe'], ['gemini', 'vibe', 'vibe', 'vibe']].entries()) {
      expect((await planAgentRuns(db, two, { now: 1_985_000_060 + i * 60, limit: 1 })).created).toBe(1);
      expect(await runsOf(cycle)).toEqual(expected);
    }
  });

  it('contre-épreuve : réveils de même âge → ordre de la liste, puis une exécution par agent et par tour', async () => {
    const cycle = await seed('tour', ['vibe', 'vibe', 'vibe', 'gemini']);
    expect((await planAgentRuns(db, two, { now: 1_986_000_000, limit: 1 })).created).toBe(1);
    expect(await runsOf(cycle)).toEqual(['vibe']);
    // Limite 2 : un tour = Vibe (réveil suivant) puis Gemini — Vibe ne prend pas les deux places.
    expect((await planAgentRuns(db, two, { now: 1_986_000_060, limit: 2 })).created).toBe(2);
    expect(await runsOf(cycle)).toEqual(['gemini', 'vibe', 'vibe']);
  });
});

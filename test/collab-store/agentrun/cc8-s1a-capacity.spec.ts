import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerRaw from '../../../wrangler.jsonc?raw';
import { planAgentRuns } from '../../../src/collab-store/agentrun';
import { coordinatorRunOverview, runCapacity, stopReasonCode } from '../../../src/collab-store/agentrun/capacity';
import { ensureModelPolicySchema } from '../../../src/collab-store/agentrun/model-policy';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { decisionKey, ensureControllerJournal } from '../../../src/collab-store/controller/journal';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { collabToolHandler, OWNER_PROOF } from '../coordinator-helpers';

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
      .toMatchObject({ capable: false, reason: expect.stringMatching(/^MODEL_ROUTE_REFUSED : anthropic:modele-inconnu \(palier auto\) — /) });
    // Fournisseur inconnu.
    expect((await solo({ AGENT_RUN_MODEL_SOLO: 'inconnu:x' })).capable).toBe(false);
    // Référence tarifée connue, clé absente.
    expect(await solo({ AGENT_RUN_MODEL_SOLO: 'anthropic:claude-haiku-5-5' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/clé ou binding absent/) });
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

  it('palier forcé « paid » (AGENT_RUN_PAID_MODEL) respecté comme par la fabrique (relecture GPT-6, seq 1293)', async () => {
    await ensureSchema(db);
    const solo = (extra: Record<string, unknown>) => runCapacity(db, extra, 'solo', null, 'implement', NOW);
    const funded = { AGENT_RUN_PAID_DAY_CENTS_SOLO: '500', AGENT_RUN_PAID_CYCLE_CENTS_SOLO: '500' };
    // Contre-exemple 1 : modèle Workers AI gratuit forcé payant → chemin payant, hors liste payante : refusé même financé.
    const paidFree = await solo({ AGENT_RUN_PAID_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: {}, ...funded });
    expect(paidFree).toMatchObject({ capable: false, reason: expect.stringMatching(/\(palier paid\) — PAID_MODEL_UNSUPPORTED/) });
    // Le même modèle au palier auto reste gratuit et capable.
    expect((await solo({ AGENT_RUN_MODEL_SOLO: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: {} })).capable).toBe(true);
    // Contre-exemple 2 : modèle API gratuit (attesté) forcé payant → tarif daté, enveloppe exigée.
    const gemini = { LLM_KEY_GEMINI: 'k', GEMINI_FREE_PROJECT_ATTESTED: 'true', PUBLIC_ORIGIN: CC3_VARS.PUBLIC_ORIGIN };
    expect(await solo({ ...gemini, AGENT_RUN_PAID_MODEL: 'gemini:gemini-3.8-flash' }))
      .toMatchObject({ capable: false, reason: expect.stringMatching(/^MODEL_BUDGET_EXHAUSTED : gemini:gemini-3.8-flash \(palier paid, \d+c par étape\)/) });
    expect(await solo({ ...gemini, AGENT_RUN_PAID_MODEL: 'gemini:gemini-3.8-flash', ...funded }))
      .toEqual({ capable: true, reason: 'gemini:gemini-3.8-flash' });
    // Au palier auto, le même modèle attesté reste gratuit : capable sans enveloppe.
    expect(await solo({ ...gemini, AGENT_RUN_MODEL_SOLO: 'gemini:gemini-3.8-flash' }))
      .toEqual({ capable: true, reason: 'gemini:gemini-3.8-flash' });
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
    const online = { ...offline, LLM_KEY_GEMINI: 'k' };
    const after = await planAgentRuns(db, online, { now: 1_984_000_900 });
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

// ──────────────────────────────────────────────────────────────────────────────
// CC-8 S1a 2/3 — refus anticipé sur coupe-circuit, capacité journalisée, vue du coordinateur.
// ──────────────────────────────────────────────────────────────────────────────
const GEMINI_REFS = CC3_VARS.AGENT_RUN_MODELS_GEMINI.split(',');

async function openBreaker(participantId: string, refs: string[], until: number): Promise<void> {
  await ensureModelPolicySchema(db);
  for (const ref of refs) {
    await db.prepare([
      'INSERT INTO agent_model_breaker (participant_id, ref, consecutive_transient_failures, last_failure_at, circuit_open_until, probe_until)',
      'VALUES (?1, ?2, 3, ?3, ?4, 0) ON CONFLICT(participant_id, ref) DO UPDATE SET consecutive_transient_failures = 3,',
      'last_failure_at = excluded.last_failure_at, circuit_open_until = excluded.circuit_open_until, probe_until = 0',
    ].join(' ')).bind(participantId, ref, until - 1800, until).run();
  }
}

async function closeBreaker(participantId: string): Promise<void> {
  await ensureModelPolicySchema(db);
  await db.prepare('DELETE FROM agent_model_breaker WHERE participant_id = ?1').bind(participantId).run();
}

describe('CC-8 S1a 2/3 — refus anticipé : coupe-circuit S1b-2 pris en compte avant toute exécution', () => {
  it('runCapacity : tous les maillons en pause → CIRCUIT_OPEN ; un seul en pause → maillon suivant ; pause échue → capable ; sonde exemptée', async () => {
    await ensureSchema(db);
    const now = Math.floor(NOW.getTime() / 1000);
    try {
      await openBreaker('gemini', GEMINI_REFS, now + 600);
      const all = await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', NOW);
      expect(all.capable).toBe(false);
      expect(all.reason).toMatch(/^CIRCUIT_OPEN : tous les maillons de gemini/);
      // Sonde S4/S5 : exemptée, comme dans le routage réel.
      expect((await runCapacity(db, CC3_TEST, 'gemini', null, 'probe', NOW)).capable).toBe(true);
      // Pause échue : capable de nouveau, sans écriture.
      expect((await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', new Date((now + 601) * 1000))).capable).toBe(true);
      // Seul gemini-3.8 en pause : le maillon suivant est retenu (même ordre que le routage).
      await closeBreaker('gemini');
      await openBreaker('gemini', [GEMINI_REFS[0]], now + 600);
      expect(await runCapacity(db, CC3_TEST, 'gemini', null, 'implement', NOW)).toEqual({ capable: true, reason: GEMINI_REFS[1] });
      // Coupe-circuit par participant × modèle (option B) : vibe n'est pas touché.
      expect((await runCapacity(db, CC3_TEST, 'vibe', null, 'implement', NOW)).capable).toBe(true);
    } finally {
      await closeBreaker('gemini');
    }
  });

  it('chemin sans politique : la référence unique en pause → CIRCUIT_OPEN', async () => {
    await ensureSchema(db);
    const now = Math.floor(NOW.getTime() / 1000);
    const solo = { AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: {} };
    try {
      await openBreaker('solo-s1a', ['workers-ai:@cf/zai-org/glm-4.7-flash'], now + 600);
      expect((await runCapacity(db, solo, 'solo-s1a', null, 'answer', NOW)).reason).toMatch(/^CIRCUIT_OPEN : workers-ai:/);
    } finally {
      await closeBreaker('solo-s1a');
    }
  });

  it('planificateur : Gemini tout en pause → aucune exécution, refus typé ; la pause échue, il est servi', async () => {
    const cycle = await seed('circuit', ['gemini']);
    const env = { ...CC3_TEST, AGENT_RUN_PARTICIPANTS: 'gemini' };
    try {
      await openBreaker('gemini', GEMINI_REFS, 1_987_000_000 + 600);
      const blocked = await planAgentRuns(db, env, { now: 1_987_000_000 });
      expect(blocked).toMatchObject({ created: 0, incapable: 1 });
      expect(blocked.incapable_detail?.[0].reason).toMatch(/^CIRCUIT_OPEN/);
      expect(await runsOf(cycle)).toEqual([]);
      const served = await planAgentRuns(db, env, { now: 1_987_000_000 + 900 });
      expect(served.created).toBe(1);
      expect(await runsOf(cycle)).toEqual(['gemini']);
    } finally {
      await closeBreaker('gemini');
    }
  });
});

describe('CC-8 S1a 2/3 — capacité journalisée et vue du coordinateur', () => {
  it('chaque verdict évalué par le planificateur est consigné (capable ou refus typé), puis mis à jour', async () => {
    const cycle = await seed('journal');
    await planAgentRuns(db, CC3_TEST, { now: 1_988_000_000 });
    const { results } = await db.prepare('SELECT participant_id, task_kind, capable, reason, checked_at FROM agent_run_capacity WHERE cycle_id = ?1 ORDER BY participant_id')
      .bind(cycle).all<{ participant_id: string; task_kind: string; capable: number; reason: string; checked_at: number }>();
    expect(results.map(row => [row.participant_id, row.task_kind, row.capable])).toEqual([
      ['claude', 'implement', 0], ['gemini', 'implement', 1], ['grok', 'implement', 0], ['vibe', 'implement', 1]]);
    expect(results.find(row => row.participant_id === 'claude')!.reason).toMatch(/^MODEL_BUDGET_EXHAUSTED : /);
    expect(results.find(row => row.participant_id === 'vibe')!.reason).toBe('workers-ai:@cf/zai-org/glm-4.7-flash');
    // Passage suivant : même clé, ligne mise à jour (une ligne par agent, cycle et type).
    await planAgentRuns(db, CC3_TEST, { now: 1_988_000_900 });
    const again = await db.prepare('SELECT COUNT(*) AS c, MAX(checked_at) AS at FROM agent_run_capacity WHERE cycle_id = ?1').bind(cycle).first<{ c: number; at: number }>();
    expect(again).toEqual({ c: 4, at: 1_988_000_900 });
  });

  it('coordinatorRunOverview : exécutions de tous les agents, comptes, capacité, coupe-circuit — jamais la consigne ni le résumé', async () => {
    const cycle = await seed('vue');
    await planAgentRuns(db, CC3_TEST, { now: 1_989_000_000 });
    await db.prepare("UPDATE agent_runs SET status = 'failed', stop_reason = ?2, summary = 'SECRET-RESUME' WHERE cycle_id = ?1 AND participant_id = 'vibe'")
      .bind(cycle, 'model_transient: CIRCUIT_OPEN : détail libre du fournisseur').run();
    try {
      await openBreaker('gemini', [GEMINI_REFS[0]], 1_989_000_000 + 600);
      const view = await coordinatorRunOverview(db, cycle, { now: 1_989_000_010 });
      expect(view.runs.map(run => run.participant_id).sort()).toEqual(['gemini', 'vibe']);
      const vibe = view.runs.find(run => run.participant_id === 'vibe')!;
      expect(vibe).toMatchObject({ status: 'failed', stop_code: 'model_transient:CIRCUIT_OPEN', task_kind: 'implement' });
      const text = JSON.stringify(view);
      expect(text).not.toContain('SECRET-RESUME');
      expect(text).not.toContain('détail libre');
      expect(Object.keys(vibe)).not.toContain('prompt');
      expect(Object.keys(vibe)).not.toContain('summary');
      expect(view.counts).toEqual(expect.arrayContaining([{ participant_id: 'vibe', status: 'failed', runs: 1 }]));
      expect(view.capacity.filter(row => !row.capable).map(row => row.participant_id).sort()).toEqual(['claude', 'grok']);
      expect(view.breaker).toEqual([{ participant_id: 'gemini', ref: GEMINI_REFS[0], consecutive_failures: 3, open_until: 1_989_000_600 }]);
    } finally {
      await closeBreaker('gemini');
    }
  });

  it('stopReasonCode : code typé seulement, sans détail libre', () => {
    expect(stopReasonCode('model_error: MODEL_BUDGET_EXHAUSTED : Aucun modèle abordable pour claude…')).toBe('model_error:MODEL_BUDGET_EXHAUSTED');
    expect(stopReasonCode('deadline')).toBe('deadline');
    expect(stopReasonCode('')).toBe('');
  });

  it('outil collab_agent_runs_overview : coordinateur du cycle seulement (COORDINATOR_REQUIRED sinon)', async () => {
    const cycle = await seed('outil');
    const tag = 's1a-' + n;
    const coordinator = 'coord-' + tag;
    await registerParticipant(db, { participant_id: coordinator, display_label: coordinator, proof: OWNER_PROOF, op: 'reg-' + coordinator });
    const family = 'fam-' + tag;
    await db.prepare('INSERT INTO participant_identity_families (participant_id, family_id, event_seq, updated_at) VALUES (?1, ?2, NULL, 1)')
      .bind(coordinator, family).run();
    await appointCycleCoordinator(db, { cycleId: cycle, participantId: coordinator, familyId: family, expectedEpoch: 0, proof: OWNER_PROOF, op: 'appoint-' + tag });
    for (const pid of [coordinator, 'vibe']) {
      await mapClient(db, { oauth_client_id: 'client-' + tag + '-' + pid, participant_id: pid, proof: OWNER_PROOF, op: 'map-' + tag + '-' + pid });
    }
    await planAgentRuns(db, CC3_TEST, { now: 1_990_000_000 });
    const asCoordinator = await collabToolHandler(db, 'collab_agent_runs_overview', 'client-' + tag + '-' + coordinator);
    const ok = await asCoordinator({ cycle_id: cycle });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse(ok.content[0].text) as { cycle_id: string; runs: unknown[]; capacity: unknown[] };
    expect(body.cycle_id).toBe(cycle);
    expect(body.runs.length).toBe(2);
    expect(body.capacity.length).toBe(4);
    const asAgent = await collabToolHandler(db, 'collab_agent_runs_overview', 'client-' + tag + '-vibe');
    const denied = await asAgent({ cycle_id: cycle });
    expect(denied.isError).toBe(true);
    expect((denied as unknown as { structuredContent: { error: { code: string } } }).structuredContent.error.code).toBe('COORDINATOR_REQUIRED');
  });
});

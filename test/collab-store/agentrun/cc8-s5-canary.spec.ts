import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { branchCanaryToF2, type BranchF2Input, type PromotionTaskProposal } from '../../../src/collab-store/agentrun/canary/f2';
import {
  evidenceStateOf,
  replayKindOf,
  selectReplayTasks,
  type JournalEventRow,
} from '../../../src/collab-store/agentrun/canary/replay';
import { runCanary, type CanaryCaller, type CanaryReport } from '../../../src/collab-store/agentrun/canary/runner';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { countEvents, insertCycleRow } from '../a0-helpers';

// CC-8 S5 — canary + branchement F2 (CC-PLAN-8 §4 : rapport rejouable par
// type, contre-exemples F2 conservés, sortie = tâche de promotion).
// Coût 0 (v0.2 seq 1270) : simulateur déterministe, aucun appel fournisseur.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = new Date('2032-11-02T10:00:00Z');
let n = 0;

async function seedCycle(): Promise<string> {
  await ensureSchema(db);
  const cycle = ('0000-cc8-s5-c-' + (++n)).slice(0, 48);
  await insertCycleRow(db, cycle, 'P6');
  return cycle;
}

async function seedEvent(cycle: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.prepare([
    "INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key)",
    "VALUES (?1, ?2, ?3, 'vibe', ?4, ?5)",
  ].join(' ')).bind(cycle, 1790000000 + n, type, JSON.stringify(payload), 's5-seed-' + (++n)).run();
}

/** Journal complet : 6 rejouables de chaque type + bruit non rejouable. */
async function seedFullJournal(cycle: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await seedEvent(cycle, 'proposal.submit', { task: 'p-vibe', content: 'proposition canary ' + i });
    await seedEvent(cycle, 'checkpoint', { task: 'S5', state: 'etape ' + i });
    await seedEvent(cycle, 'evidence.add', { task: 'S5', state: 'AGREE', review: 'relecture ' + i });
    await seedEvent(cycle, 'evidence.add', { task: 'S5', state: 'PASS', review: 'test ' + i });
    await seedEvent(cycle, 'manual_op.log', { note: 'operation ' + i });
  }
  await seedEvent(cycle, 'clarify.ask', { question: 'coordination, non rejouee' });
  await seedEvent(cycle, 'task.status', { task: { task_id: 'S5', status: 'done' } });
  await seedEvent(cycle, 'owner.request', { request_id: 'bruit' });
  await seedEvent(cycle, 'evidence.add', { task: 'S5', state: 'SUBMITTED', review: 'soumission, non rejouee' });
}

const okCaller: CanaryCaller = {
  provenance: 'simulation',
  async call() {
    return { ok: true, in_tokens: 100, out_tokens: 50, latency_ms: 10 };
  },
};

const RATES = {
  current: { input_per_m: 100, output_per_m: 200 },
  candidate: { input_per_m: 50, output_per_m: 100 },
};

const probeOk = () => ({ ok: true, tools_ok: true, efforts_ok: ['low', 'medium', 'high'] });

function greenInput(cycle: string, report: CanaryReport, auto = false): BranchF2Input {
  return {
    cycle_id: cycle,
    current_ref: 'gemini:gemini-3.5-flash-lite',
    candidate_ref: 'gemini:gemini-3.6-flash',
    same_family: true,
    current_rate: RATES.current,
    candidate_rate: RATES.candidate,
    candidate_still_free: true,
    current_is_free: true,
    probe: probeOk(),
    report,
    auto_policy_enabled: auto,
    paid_ceiling_ok: true,
  };
}

/** Rapport littéral (contre-exemples sans journal). */
function reportOf(overrides: Partial<CanaryReport> = {}): CanaryReport {
  return {
    cycle_id: 'c',
    candidate_ref: 'gemini:gemini-3.6-flash',
    provenance: 'simulation',
    created_at: NOW.toISOString(),
    calls: 20,
    failures: 0,
    calls_by_kind: { answer: 5, review: 5, test: 5, implement: 5 },
    replay: [],
    cost_micro_cents: 1,
    cost_ratio: 0.5,
    cost_measured: true,
    avg_latency_ms: 10,
    quota_rejections: 0,
    identity_leak: false,
    critical_error: false,
    insufficient: {},
    ...overrides,
  };
}

describe('CC-8 S5 — rejeu stratifié du journal', () => {
  it('mapping documenté : types rejouables vs coordination et mémoire', () => {
    expect(replayKindOf('proposal.submit')).toBe('answer');
    expect(replayKindOf('checkpoint')).toBe('answer');
    expect(replayKindOf('evidence.add', 'AGREE')).toBe('review');
    expect(replayKindOf('evidence.add', 'CHANGES_REQUESTED')).toBe('review');
    expect(replayKindOf('evidence.add', 'PASS')).toBe('test');
    expect(replayKindOf('evidence.add', 'FAIL')).toBe('test');
    expect(replayKindOf('evidence.add', 'SUBMITTED')).toBeNull();
    expect(replayKindOf('manual_op.log')).toBe('implement');
    expect(replayKindOf('task.handoff')).toBe('implement');
    for (const type of ['clarify.ask', 'clarify.answer', 'owner.request', 'owner.decision', 'task.claim', 'task.status', 'memory.propose', 'round.add']) {
      expect(replayKindOf(type), type).toBeNull();
    }
    expect(evidenceStateOf('{"task":"S5","state":"AGREE"}')).toBe('AGREE');
    expect(evidenceStateOf('{pas json')).toBeUndefined();
  });

  it('sélection : 5 plus récents par type, prompts bornés, ordre stable, hash de source', async () => {
    const rows: JournalEventRow[] = [];
    for (let i = 1; i <= 7; i++) {
      rows.push({ seq: i, type: 'evidence.add', participant_id: 'vibe', payload_json: JSON.stringify({ task: 'S5', state: 'AGREE', review: 'r' + i }) });
    }
    const tasks = await selectReplayTasks(rows, 5);
    expect(tasks).toHaveLength(5);
    expect(tasks.map((t) => t.seq)).toEqual([3, 4, 5, 6, 7]);
    for (const task of tasks) {
      expect(task.kind).toBe('review');
      expect(task.prompt.length).toBeLessThanOrEqual(2000);
      expect(task.prompt).toContain('evidence.add AGREE');
      expect(task.source_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('payload non JSON : ignoré sans exception', async () => {
    const rows: JournalEventRow[] = [
      { seq: 1, type: 'checkpoint', participant_id: 'vibe', payload_json: '{pas json' },
      { seq: 2, type: 'checkpoint', participant_id: 'vibe', payload_json: JSON.stringify({ state: 'ok' }) },
    ];
    const tasks = await selectReplayTasks(rows, 5);
    expect(tasks.map((t) => t.seq)).toEqual([2]);
  });
});

describe('CC-8 S5 — runner canary (coût 0, rapport rejouable)', () => {
  it('journal complet : 20 appels, 5 par type, rapport rejouable, aucune écriture store', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const seeded = await countEvents(db, cycle);
    const options = {
      cycle_id: cycle,
      candidate_ref: 'gemini:gemini-3.6-flash',
      caller: okCaller,
      current_rate: RATES.current,
      candidate_rate: RATES.candidate,
      now: () => NOW,
    };
    const first = await runCanary(db, options);
    expect(first.calls).toBe(20);
    expect(first.failures).toBe(0);
    expect(first.calls_by_kind).toEqual({ answer: 5, review: 5, test: 5, implement: 5 });
    expect(first.insufficient).toEqual({});
    expect(first.cost_measured).toBe(true);
    // panier par appel : 100 entrées × 50 + 50 sorties × 100 = moitié du tarif actuel
    expect(first.cost_ratio).toBeCloseTo(0.5, 5);
    expect(first.cost_micro_cents).toBe(20 * (100 * 50 + 50 * 100));
    expect(first.avg_latency_ms).toBe(10);
    for (const record of first.replay) {
      expect(record.ok).toBe(true);
      expect(record.source_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // rejouabilité : même journal, même caller, même now → même rapport
    const second = await runCanary(db, options);
    expect(second).toEqual(first);
    // lecture seule : le journal n'a pas bougé
    expect(await countEvents(db, cycle)).toBe(seeded);
  });

  it('canary incomplet (aucun événement test) : déficit tracé, propose seulement même politique on', async () => {
    const cycle = await seedCycle();
    for (let i = 0; i < 6; i++) {
      await seedEvent(cycle, 'proposal.submit', { task: 'p', content: 'a' + i });
      await seedEvent(cycle, 'checkpoint', { task: 'S5', state: 'e' + i });
      await seedEvent(cycle, 'evidence.add', { task: 'S5', state: 'AGREE', review: 'r' + i });
      await seedEvent(cycle, 'manual_op.log', { note: 'op' + i });
    }
    const report = await runCanary(db, { cycle_id: cycle, candidate_ref: 'gemini:gemini-3.6-flash', caller: okCaller, now: () => NOW });
    expect(report.calls).toBe(15);
    expect(report.calls_by_kind.test).toBe(0);
    expect(report.insufficient).toEqual({ test: 5 });
    const { decision, proposal } = await branchCanaryToF2(greenInput(cycle, report, true));
    expect(decision.verdict).toBe('propose');
    expect(decision.reasons).toContain('canary_incomplet');
    expect(proposal?.next).toBe('beta');
  });

  it('caller qui jette : erreur critique, échecs comptés, F2 rejette (fail-closed)', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const broken: CanaryCaller = {
      provenance: 'simulation',
      async call() {
        throw new Error('PANNE');
      },
    };
    const report = await runCanary(db, { cycle_id: cycle, candidate_ref: 'gemini:gemini-3.6-flash', caller: broken, now: () => NOW });
    expect(report.critical_error).toBe(true);
    expect(report.failures).toBe(20);
    expect(report.calls_by_kind).toEqual({ answer: 5, review: 5, test: 5, implement: 5 });
    const { decision, proposal } = await branchCanaryToF2(greenInput(cycle, report));
    expect(decision.verdict).toBe('reject');
    expect(decision.reasons).toContain('canary_critique');
    expect(proposal).toBeNull();
  });

  it('quotas refusés et fuite d identité tracés (fuite → reject F2)', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const leaky: CanaryCaller = {
      provenance: 'simulation',
      async call(task) {
        return {
          ok: true,
          in_tokens: 10,
          out_tokens: 5,
          latency_ms: 1,
          quota_rejected: task.kind === 'test',
          identity_leak: task.kind === 'review',
        };
      },
    };
    const report = await runCanary(db, { cycle_id: cycle, candidate_ref: 'gemini:gemini-3.6-flash', caller: leaky, now: () => NOW });
    expect(report.quota_rejections).toBe(5);
    expect(report.identity_leak).toBe(true);
    const { decision } = await branchCanaryToF2(greenInput(cycle, report));
    expect(decision.verdict).toBe('reject');
    expect(decision.reasons).toContain('canary_critique');
  });
});

describe('CC-8 S5 — branchement F2 : sortie = tâche de promotion, contre-exemples conservés', () => {
  it('canary vert, politique éteinte → propose + tâche de promotion (next beta)', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const report = await runCanary(db, {
      cycle_id: cycle,
      candidate_ref: 'gemini:gemini-3.6-flash',
      caller: okCaller,
      current_rate: RATES.current,
      candidate_rate: RATES.candidate,
      now: () => NOW,
    });
    const { decision, proposal } = await branchCanaryToF2(greenInput(cycle, report, false));
    expect(decision.verdict).toBe('propose');
    expect(decision.reasons).toContain('auto_desactivee');
    const p = proposal as PromotionTaskProposal;
    expect(p.next).toBe('beta');
    expect(p.candidate_ref).toBe('gemini:gemini-3.6-flash');
    expect(p.canary_calls).toBe(20);
    expect(p.report_hash).toMatch(/^[0-9a-f]{64}$/);
    // même rapport → même empreinte (rejouable)
    const again = await branchCanaryToF2(greenInput(cycle, report, false));
    expect((again.proposal as PromotionTaskProposal).report_hash).toBe(p.report_hash);
  });

  it('politique auto + canary simulé : propose seulement, jamais auto_apply (fail-closed)', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const report = await runCanary(db, {
      cycle_id: cycle,
      candidate_ref: 'gemini:gemini-3.6-flash',
      caller: okCaller,
      current_rate: RATES.current,
      candidate_rate: RATES.candidate,
      now: () => NOW,
    });
    expect(report.provenance).toBe('simulation');
    const { decision, proposal } = await branchCanaryToF2(greenInput(cycle, report, true));
    expect(decision.verdict).toBe('propose');
    expect(decision.reasons).toContain('canary_v0_auto_interdit');
    expect(decision.reasons).toContain('canary_simule_pas_de_promotion_auto');
    expect(proposal?.verdict).toBe('propose');
    expect(proposal?.next).toBe('beta');
  });

  it('caller mock étiqueté real : jamais auto_apply en v0 (fail-closed)', async () => {
    const cycle = await seedCycle();
    await seedFullJournal(cycle);
    const realCaller: CanaryCaller = {
      provenance: 'real',
      async call() {
        return { ok: true, in_tokens: 100, out_tokens: 50, latency_ms: 10 };
      },
    };
    const report = await runCanary(db, {
      cycle_id: cycle,
      candidate_ref: 'gemini:gemini-3.6-flash',
      caller: realCaller,
      current_rate: RATES.current,
      candidate_rate: RATES.candidate,
      now: () => NOW,
    });
    expect(report.provenance).toBe('real');
    // v0 : une étiquette real déclarée n’est pas une preuve — pas d’auto_apply.
    const { decision, proposal } = await branchCanaryToF2(greenInput(cycle, report, true));
    expect(decision.verdict).toBe('propose');
    expect(decision.reasons).toContain('canary_v0_auto_interdit');
    expect(proposal?.verdict).toBe('propose');
    expect(proposal?.next).toBe('beta');
  });

  it('rapport d’un autre cycle ou candidat : reject fail-closed, aucune proposition', async () => {
    const autreCycle = await branchCanaryToF2(greenInput('c', reportOf({ cycle_id: 'autre-cycle' }), true));
    expect(autreCycle.decision.verdict).toBe('reject');
    expect(autreCycle.decision.reasons).toContain('rapport_cycle_etranger');
    expect(autreCycle.proposal).toBeNull();
    const autreCandidat = await branchCanaryToF2(greenInput('c', reportOf({ candidate_ref: 'gemini:gemini-9-pro' }), true));
    expect(autreCandidat.decision.verdict).toBe('reject');
    expect(autreCandidat.decision.reasons).toContain('rapport_candidat_etranger');
    expect(autreCandidat.proposal).toBeNull();
  });

  it('contre-exemples F2 conservés à travers le branchement', async () => {
    // 1 seul appel : jamais auto, même politique on
    const one = await branchCanaryToF2(greenInput('c', reportOf({ calls: 1, calls_by_kind: { answer: 1 } }), true));
    expect(one.decision.verdict).toBe('propose');
    expect(one.decision.reasons).toContain('canary_incomplet');
    // type manquant : canary incomplet → propose seulement
    const missing = await branchCanaryToF2(greenInput('c', reportOf({ calls: 15, calls_by_kind: { answer: 5, review: 5, implement: 5 } }), true));
    expect(missing.decision.verdict).toBe('propose');
    // alias latest : reject, aucune tâche de promotion
    const latest = await branchCanaryToF2({ ...greenInput('c', reportOf({ candidate_ref: 'gemini:latest' })), candidate_ref: 'gemini:latest' });
    expect(latest.decision.verdict).toBe('reject');
    expect(latest.decision.reasons).toContain('ref_non_epinglee');
    expect(latest.proposal).toBeNull();
    // tarif NaN : reject
    const nan = await branchCanaryToF2({ ...greenInput('c', reportOf()), candidate_rate: { input_per_m: Number.NaN, output_per_m: 1 } });
    expect(nan.decision.verdict).toBe('reject');
    expect(nan.decision.reasons).toContain('tarif_candidat_invalide');
    // efforts invalides : reject sonde
    const efforts = await branchCanaryToF2({ ...greenInput('c', reportOf()), probe: { ok: true, tools_ok: true, efforts_ok: ['niveau-invalide'] } });
    expect(efforts.decision.verdict).toBe('reject');
    expect(efforts.decision.reasons).toContain('sonde_efforts_invalides');
    // sonde échouée : reject
    const sonde = await branchCanaryToF2({ ...greenInput('c', reportOf()), probe: { ok: false, tools_ok: true, efforts_ok: ['low'] } });
    expect(sonde.decision.verdict).toBe('reject');
    expect(sonde.decision.reasons).toContain('sonde_echec');
    // fuite : reject
    expect((await branchCanaryToF2(greenInput('c', reportOf({ identity_leak: true })))).decision.reasons).toContain('canary_critique');
    // taux d échec > 5 % : reject
    const taux = await branchCanaryToF2(greenInput('c', reportOf({ failures: 2 })));
    expect(taux.decision.verdict).toBe('reject');
    expect(taux.decision.reasons).toContain('canary_taux_echec');
    // coût supérieur : propose (jamais auto), pas de reject silencieux
    const cout = await branchCanaryToF2(greenInput('c', reportOf({ cost_ratio: 1.5 }), true));
    expect(cout.decision.verdict).toBe('propose');
    expect(cout.decision.reasons).toContain('canary_cout_superieur');
    // gratuit devenu payant : propose gel ou repli
    const payant = await branchCanaryToF2(greenInput('c', reportOf(), true));
    const gele = await branchCanaryToF2({ ...greenInput('c', reportOf(), true), candidate_still_free: false });
    expect(gele.decision.verdict).toBe('propose');
    expect(gele.decision.reasons).toContain('gratuit_devenu_payant_gel_ou_repli');
    expect(payant.decision.verdict).not.toBe('reject');
  });
});

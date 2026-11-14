import { describe, expect, it } from 'vitest';
import { createRun, leaseKeyOf, type ToolHost } from '../../../src/collab-store/agentrun';
import { redactedReceipt, redactedRunSummaryFor, STOP_CODES, typedStop } from '../../../src/collab-store/agentrun/chat-continuity';
import { objectAlarm, objectWake, type ObjectSlot, type OrchestratorDeps } from '../../../src/collab-store/agentrun/orchestrator';
import { recordRunModelCall } from '../../../src/collab-store/agentrun/provider-models';
import { publishRunProof, RUN_PROOF_ATTEMPTS, RUN_PROOF_RETRY_S } from '../../../src/collab-store/agentrun/run-proof';
import { requestCorrection } from '../../../src/collab-store/controller/corrections';
import { taskEvidence } from '../../../src/collab-store/controller/facts';
import { previewNextActions } from '../../../src/collab-store/controller/next-actions';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { appointCycleCoordinator } from '../../../src/collab-store/owner/delegation-execution';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { countEvents, insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { OWNER_PROOF, uniqueIds } from '../coordinator-helpers';
import { BASE, BRANCH, C1, commitAs, db, drive, host, PASSED, SCOPE, scripted, setHalt, T } from './s7-guided-harness';

// CC8 S7 durcissement — lot B (#282, issue mère #280) : R4 preuve serveur run.proof, R5 résumé expurgé et modèle servi.
const uniq = uniqueIds('hb');
const PR_BASE = 'e'.repeat(40);
const GOOD = "import { describe, expect, it } from 'vitest';\nimport { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n"
  + "describe('s7', () => { it('plan', () => { expect(planGuidedS7([], 'a-api-b', 't', 0).kind).toBe('server'); }); });\n";

interface World { cycle: string; author: string; reviewer: string; tester: string; holder: string }

async function world(): Promise<World> {
  const tag = uniq('w');
  const [author, reviewer, tester, holder] = ['ba', 'br', 'bt', 'bh'].map(p => p + '-' + tag);
  for (const pid of [author, reviewer, tester, holder]) {
    await registerParticipant(db, { participant_id: pid, display_label: pid, proof: OWNER_PROOF, op: uniq('reg') });
  }
  const cycle = uniq('cyc');
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 't0', cycle, owner: author, reviewer, tester });
  await appointCycleCoordinator(db, { cycleId: cycle, participantId: holder, familyId: holder, expectedEpoch: 0, proof: OWNER_PROOF, op: uniq('appoint') });
  return { cycle, author, reviewer, tester, holder };
}

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
}

let corrections = 0;
/** Demande de correction du coordinateur (horodatée maintenant, donc AVANT la création du run à T). */
async function correct(w: World): Promise<number> {
  const out = await requestCorrection(db, { cycle_id: w.cycle, participant_id: w.holder, task_id: 't0', items: ['Pilote guidé'],
    expected_revision: await revision(w.cycle), op_id: w.holder + ':' + w.cycle + ':corr:' + (++corrections) });
  return out.event_seq;
}

/** Run guidé S7 de `participant` sur t0, mené jusqu'à `completed/final` (PR #300 au SHA C1). */
async function completedRun(w: World, participant = w.author) {
  const runId = 'cc8-hb-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId: w.cycle, participantId: participant, taskId: 't0', taskKind: 'implement', prompt: 'Lot B.',
    maxSteps: 12, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
  const grants = [{ cycle: w.cycle, participant, task: 't0', branch: BRANCH }];
  const h = host({ github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: BASE }],
    github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
    github_check_result: [PASSED(C1)], github_open_pr: [{ branch: BRANCH, number: 300, head_sha: C1, draft: false }] });
  const outcomes = await drive(runId, { model: scripted([commitAs('github_commit_files', GOOD)]).client, tools: h.tools, now: () => T + 100,
    workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
  expect(outcomes.at(-1)).toBe('completed');
  return { runId, grants };
}

/** Banc d'outils de la preuve : relecture de la PR (file de réponses ; fonction = panne). */
function prReads(...answers: Array<unknown | (() => never)>): ToolHost {
  return host({ github_pull_request: answers }).tools;
}
const OPEN = { number: 300, state: 'open', merged: false, head: { sha: C1 }, base: { sha: PR_BASE } };
const proofDeps = (tools: ToolHost, grants: Awaited<ReturnType<typeof completedRun>>['grants'], at = T + 200) =>
  ({ tools, githubCompletionGrants: grants, now: () => at });

/** Demande de correction posée directement en SQL (horodatage choisi), comme un coordinateur l'aurait déposée. */
async function insertCorrection(target: D1Database, w: World, at: number, label: string): Promise<void> {
  await target.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, ?2, 'correction.request', ?3, '', 'coordinator', ?4, 0, ?5, '')",
  ].join(' ')).bind(w.cycle, at, w.holder, JSON.stringify({ task: 't0', items: [label] }), uniq(label)).run();
}

/** Base qui exécute `mutate` une seule fois, juste avant le lot d'écriture de la preuve (5 instructions). */
function racingOnce(mutate: (target: D1Database) => Promise<unknown>): { db: D1Database; raced: () => boolean } {
  let raced = false;
  const proxy = new Proxy(db, { get(target, prop, receiver) {
    if (prop === 'batch') {
      return async (statements: D1PreparedStatement[]) => {
        if (!raced && statements.length === 5) {
          raced = true;
          await mutate(target);
        }
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db: proxy, raced: () => raced };
}

async function proofEvents(cycle: string) {
  const { results } = await db.prepare("SELECT seq, participant_id, role, payload_json FROM events WHERE cycle_id = ?1 AND type = 'run.proof'")
    .bind(cycle).all<{ seq: number; participant_id: string; role: string; payload_json: string }>();
  return results;
}

describe('Lot B R4 — preuve serveur run.proof', () => {
  it('CI verte + PR ouverte : une seule preuve signée agentrun, soumission au couple réel, correction close, review/test réveillés', async () => {
    const w = await world();
    const corr = await correct(w);
    expect((await previewNextActions(db, w.cycle, w.author)).mine).toMatchObject([{ action: 'address_correction', subject: 'corr#' + corr }]);
    const { runId, grants } = await completedRun(w);
    const rev = await revision(w.cycle);
    const out = await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants));
    expect(out.status).toBe('published');
    const [event] = await proofEvents(w.cycle);
    expect(event).toMatchObject({ participant_id: 'agentrun', role: 'server' });
    expect(JSON.parse(event.payload_json)).toMatchObject({ task: 't0', run_id: runId, run_participant: w.author, mandate_epoch: 1, pr: 300, head: C1,
      base: PR_BASE, verified_success: true, scope: 'pilot_e2e_pass' });
    expect(await revision(w.cycle)).toBe(rev + 1);
    // Plus de demande ouverte : relecteur et testeur sont réveillés au couple exact ; l'auteur n'a plus rien.
    expect((await previewNextActions(db, w.cycle, w.author)).mine).toEqual([]);
    expect((await previewNextActions(db, w.cycle, w.reviewer)).mine).toMatchObject([{ action: 'review', subject: C1 + '..' + PR_BASE }]);
    expect((await previewNextActions(db, w.cycle, w.tester)).mine).toMatchObject([{ action: 'test', subject: C1 + '..' + PR_BASE }]);
    // Rejeu, double réveil : même preuve, aucune écriture de plus (GitHub n'est même pas relu).
    expect(await publishRunProof(db, runId, proofDeps(prReads(), grants))).toEqual({ status: 'published', event_seq: event.seq });
    expect(await proofEvents(w.cycle)).toHaveLength(1);
  });

  it('mandat D1 dynamique : un run API validé publie la même preuve D12 sans grant statique', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const requests: Array<{ cycle_id: string; task_id: string; participant_id: string }> = [];
    const proof = await publishRunProof(db, runId, {
      ...proofDeps(prReads(OPEN), []),
      dynamicGrantFor: async target => { requests.push(target); return { ...grants[0]!, mission: 'pilot' }; },
    });
    expect(proof.status).toBe('published');
    expect(requests).toEqual([{ cycle_id: w.cycle, task_id: 't0', participant_id: w.author }]);
    expect((await proofEvents(w.cycle)).map(e => JSON.parse(e.payload_json))).toMatchObject([
      { task: 't0', run_participant: w.author, head: C1, base: PR_BASE, verified_success: true },
    ]);
    expect((await previewNextActions(db, w.cycle, w.reviewer)).mine).toMatchObject([
      { action: 'review', subject: C1 + '..' + PR_BASE },
    ]);
    // Un ancien run déjà prouvé reste idempotent si son grant a expiré ou a été retiré.
    expect(await publishRunProof(db, runId, {
      ...proofDeps(prReads(), []), dynamicGrantFor: async () => null,
    })).toEqual(proof);
    expect(await proofEvents(w.cycle)).toHaveLength(1);
  });

  it('mandat dynamique absent ou sur un autre participant : aucune preuve D12', async () => {
    const absent = await world();
    const first = await completedRun(absent);
    expect(await publishRunProof(db, first.runId, {
      ...proofDeps(prReads(OPEN), []), dynamicGrantFor: async () => null,
    })).toEqual({ status: 'skipped', reason: 'no_s7_mandate' });
    expect(await proofEvents(absent.cycle)).toHaveLength(0);
    const wrong = await world();
    const second = await completedRun(wrong);
    expect(await publishRunProof(db, second.runId, {
      ...proofDeps(prReads(OPEN), []), dynamicGrantFor: async () => ({ ...second.grants[0]!, participant: wrong.reviewer }),
    })).toEqual({ status: 'skipped', reason: 'no_s7_mandate' });
    expect(await proofEvents(wrong.cycle)).toHaveLength(0);
  });

  it('jamais un avis : une preuve ne compte que comme soumission de l’auteur (pur)', () => {
    const roles = { owner: 'a', reviewer: 'r', tester: 't' };
    const proof = (participant: string, seq: number) => ({ seq, participant, evidence_ref: '', server_proof: true,
      payload_json: JSON.stringify({ task: 't0', state: 'AGREE', verdict: 'PASS', pr: 300, head: C1, base: PR_BASE }) });
    expect(taskEvidence('t0', roles, [proof('a', 1)])).toEqual({ submission: { head: C1, base: PR_BASE, seq: 1 }, verdicts: [] });
    expect(taskEvidence('t0', roles, [proof('r', 2), proof('t', 3)])).toEqual({ submission: null, verdicts: [] });
    expect(taskEvidence('t1', roles, [proof('a', 4)])).toEqual({ submission: null, verdicts: [] });
  });

  it('le type est réservé au serveur : collab_append_event refuse run.proof', async () => {
    const w = await world();
    const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
    await expect(store.appendEvent({ cycle_id: w.cycle, type: 'run.proof' as never, participant_id: w.author, expected_rev: await revision(w.cycle),
      payload_json: JSON.stringify({ task: 't0', head: C1, base: PR_BASE, pr: 300 }), op_id: w.author + ':' + w.cycle + ':proof:1' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_EVENT_TYPE' });
    expect(await countEvents(db, w.cycle, 'run.proof')).toBe(0);
  });

  for (const [label, answer, reason] of [
    ['tête déplacée', { ...OPEN, head: { sha: 'f'.repeat(40) } }, 'pr_head_moved'],
    ['PR fermée', { ...OPEN, state: 'closed' }, 'pr_not_open'],
    ['PR fusionnée', { ...OPEN, merged: true }, 'pr_not_open'],
  ] as Array<[string, unknown, string]>) {
    it('couple GitHub réel (' + label + ') → refus définitif, aucune preuve', async () => {
      const w = await world();
      const { runId, grants } = await completedRun(w);
      expect(await publishRunProof(db, runId, proofDeps(prReads(answer), grants))).toEqual({ status: 'refused', reason });
      expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).toEqual({ status: 'refused', reason });
      expect(await proofEvents(w.cycle)).toHaveLength(0);
    });
  }

  it('run d’un autre que l’auteur, correction postérieure au run, tâche terminée → refus, aucune preuve', async () => {
    const other = await world();
    const run = await completedRun(other, other.reviewer);
    expect(await publishRunProof(db, run.runId, proofDeps(prReads(OPEN), run.grants))).toEqual({ status: 'refused', reason: 'not_task_owner' });
    const later = await world();
    const done = await completedRun(later);
    await insertCorrection(db, later, T + 150, 'late');
    expect(await publishRunProof(db, done.runId, proofDeps(prReads(OPEN), done.grants))).toEqual({ status: 'refused', reason: 'correction_after_run' });
    const closed = await world();
    const fin = await completedRun(closed);
    await db.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1").bind(closed.cycle).run();
    expect(await publishRunProof(db, fin.runId, proofDeps(prReads(OPEN), fin.grants))).toEqual({ status: 'refused', reason: 'task_closed' });
    for (const w of [other, later, closed]) expect(await proofEvents(w.cycle)).toHaveLength(0);
  });

  it('relecture D12 B1 : correction déposée dans la MÊME seconde que la création du run → traitée comme postérieure, aucune preuve', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    await insertCorrection(db, w, T, 'same');
    expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).toEqual({ status: 'refused', reason: 'correction_after_run' });
    expect(await proofEvents(w.cycle)).toHaveLength(0);
  });

  it('relecture D12 B1 : correction même seconde arrivée entre la vérification et l’écriture → garde SQL, aucune preuve', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const racing = racingOnce(target => insertCorrection(target, w, T, 'race'));
    const out = await publishRunProof(racing.db, runId, proofDeps(prReads(OPEN), grants));
    expect(racing.raced()).toBe(true);
    expect(out.status).not.toBe('published');
    expect(await proofEvents(w.cycle)).toHaveLength(0);
    // Relecture suivante : la correction est vue avant toute écriture, refus définitif.
    expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).toEqual({ status: 'refused', reason: 'correction_after_run' });
  });

  it('hors mandat S7 ou run non terminé : ignoré sans trace', async () => {
    const w = await world();
    const { runId } = await completedRun(w);
    expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), []))).toEqual({ status: 'skipped', reason: 'no_s7_mandate' });
    expect(await publishRunProof(db, 'inconnu', proofDeps(prReads(OPEN), []))).toEqual({ status: 'skipped', reason: 'not_a_completed_implement_run' });
    expect(await db.prepare('SELECT COUNT(*) AS c FROM agent_run_proofs WHERE run_id = ?1').bind(runId).first<{ c: number }>()).toEqual({ c: 0 });
  });

  it('HALT : aucune écriture, attente sans tentative consommée ; après levée, preuve publiée', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    await setHalt(true);
    try {
      expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).toEqual({ status: 'pending', reason: 'halted', attempts: 0 });
      expect(await proofEvents(w.cycle)).toHaveLength(0);
    } finally {
      await setHalt(false);
    }
    expect((await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).status).toBe('published');
  });

  it('GitHub illisible : reprise bornée, puis refus après ' + RUN_PROOF_ATTEMPTS + ' tentatives', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const down = () => { throw new Error('github_down'); };
    for (let attempt = 1; attempt < RUN_PROOF_ATTEMPTS; attempt++) {
      expect(await publishRunProof(db, runId, proofDeps(prReads(down), grants))).toEqual({ status: 'pending', reason: 'github_unreadable', attempts: attempt });
    }
    expect(await publishRunProof(db, runId, proofDeps(prReads(down), grants))).toEqual({ status: 'refused', reason: 'attempts_exhausted:github_unreadable' });
    expect(await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants))).toMatchObject({ status: 'refused' });
    expect(await proofEvents(w.cycle)).toHaveLength(0);
  });

  it('révision concurrente entre lecture et écriture : relecture puis une seule preuve', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const racing = racingOnce(target => target.prepare('UPDATE cycles SET revision = revision + 1 WHERE cycle_id = ?1').bind(w.cycle).run());
    expect((await publishRunProof(racing.db, runId, proofDeps(prReads(OPEN), grants))).status).toBe('published');
    expect(racing.raced()).toBe(true);
    expect(await proofEvents(w.cycle)).toHaveLength(1);
  });
});

function slotFixture() {
  const values = new Map<string, string | number>();
  const state = { alarm: null as number | null };
  const slot: ObjectSlot = {
    get: async key => values.get(key) as never, put: async (key, value) => { values.set(key, value); },
    delete: async key => values.delete(key), getAlarm: async () => state.alarm,
    setAlarm: async at => { state.alarm = at; }, deleteAlarm: async () => { state.alarm = null; },
  };
  return { slot, state };
}

describe('Lot B R4 — orchestrateur : preuve à la fin du run, nouvel essai borné par l’alarme', () => {
  it('GitHub illisible à la fin : l’objet garde le run et réessaie ; au succès, preuve publiée puis libération', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const { slot, state } = slotFixture();
    const answers: Array<unknown | (() => never)> = [() => { throw new Error('github_down'); }, OPEN];
    const tools = prReads(...answers);
    const clock = { ms: (T + 300) * 1000 };
    const deps: OrchestratorDeps = { db, env: { AGENT_RUNS_ENABLED: 'true' }, slot, ownsLease: () => true, nowMs: () => clock.ms,
      engine: () => ({ model: scripted([]).client, tools, now: () => Math.floor(clock.ms / 1000), githubCompletionGrants: grants }),
      workerId: () => 'hb-worker' };
    await slot.put('run_id', runId);
    expect(await objectAlarm(deps)).toEqual({ action: 'rescheduled', outcome: 'proof_pending', next_at: clock.ms + RUN_PROOF_RETRY_S * 1000 });
    expect(state.alarm).toBe(clock.ms + RUN_PROOF_RETRY_S * 1000);
    clock.ms += RUN_PROOF_RETRY_S * 1000;
    expect(await objectAlarm(deps)).toEqual({ action: 'finished', outcome: 'completed' });
    expect(await proofEvents(w.cycle)).toHaveLength(1);
    expect(await slot.get('run_id')).toBeUndefined();
    // Réveil tardif d'un run terminé : rien à refaire.
    expect(await objectWake(deps, runId, leaseKeyOf(w.cycle, w.author, 't0'))).toEqual({ accepted: true, reason: 'terminal' });
  });

  it('la terminaison de la WorkSession transmet le mandat dynamique à run.proof', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    const { slot } = slotFixture();
    const requests: Array<{ cycle_id: string; task_id: string; participant_id: string }> = [];
    const clock = { ms: (T + 300) * 1000 };
    const deps: OrchestratorDeps = { db, env: { AGENT_RUNS_ENABLED: 'true' }, slot, ownsLease: () => true,
      nowMs: () => clock.ms,
      engine: () => ({ model: scripted([]).client, tools: prReads(OPEN),
        now: () => Math.floor(clock.ms / 1000), githubCompletionGrants: [],
        dynamicGrantFor: async target => { requests.push(target); return { ...grants[0]!, mission: 'pilot' }; } }),
      workerId: () => 'hb-dynamic-worker' };
    await slot.put('run_id', runId);
    expect(await objectAlarm(deps)).toEqual({ action: 'finished', outcome: 'completed' });
    expect(requests).toEqual([{ cycle_id: w.cycle, task_id: 't0', participant_id: w.author }]);
    expect(await proofEvents(w.cycle)).toHaveLength(1);
    expect(await slot.get('run_id')).toBeUndefined();
  });
});

describe('Lot B R5 — résumé expurgé et modèle servi', () => {
  it('propriétaire et coordinateur lisent le même résumé expurgé ; toute autre identité → null', async () => {
    const w = await world();
    const { runId, grants } = await completedRun(w);
    await publishRunProof(db, runId, proofDeps(prReads(OPEN), grants));
    const mine = await redactedRunSummaryFor(db, w.author, runId);
    expect(mine).toMatchObject({ run_id: runId, status: 'completed', stop_code: 'final', stop_class: null, steps_done: 6, server_steps: 5, model_steps: 1,
      tokens_used: 2_000, proof: { status: 'published' } });
    expect(mine!.effects.find(e => e.tool === 'github_open_pr')).toMatchObject({ receipt: { number: 300, head_sha: C1, draft: false } });
    expect(await redactedRunSummaryFor(db, w.holder, runId)).toEqual(mine);
    expect(await redactedRunSummaryFor(db, w.reviewer, runId)).toBeNull();
    expect(await redactedRunSummaryFor(db, w.author, 'inconnu')).toBeNull();
  });

  it('relecture D12 B2 : vue fail-closed — secrets factices connus ET inconnus, courts, jamais exposés ; aucun texte libre', async () => {
    const w = await world();
    const { runId } = await completedRun(w);
    const known = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const unknown = ['zq7', 'hush'].join('-'); // format inconnu de toute regex de secrets, court
    await db.prepare([
      'INSERT INTO agent_run_effects (effect_key, run_id, n, idx, tool, args, status, result, updated_at)',
      "VALUES (?1, ?2, 99, 0, 'github_read_file', ?3, 'completed', ?4, ?5)",
    ].join(' ')).bind(uniq('fx'), runId, JSON.stringify({ token: known, other: unknown }),
      JSON.stringify({ content: 'TOKEN=' + known, sha: 'a'.repeat(40), error: unknown, status: unknown, conclusion: unknown,
        next_action: unknown, branch: unknown, number: unknown, draft: unknown }), T).run();
    await db.prepare("UPDATE agent_runs SET stop_reason = ?2 WHERE run_id = ?1").bind(runId, 'model_permanent: key ' + unknown + ' ' + known).run();
    const summary = await redactedRunSummaryFor(db, w.holder, runId);
    const text = JSON.stringify(summary);
    for (const leak of [known, unknown, 'TOKEN=', 'Lot B.']) expect(text).not.toContain(leak);
    expect(summary).toMatchObject({ stop_code: 'model_permanent', stop_class: null });
    expect(summary!.effects.find(e => e.n === 99)).toMatchObject({ receipt: { sha: 'a'.repeat(40) } });
    expect(Object.keys(summary!.effects.find(e => e.n === 99)!.receipt)).toEqual(['sha']);
  });

  it('relecture D12 B2 : reçus et codes d’arrêt par listes fermées (pur)', () => {
    expect(redactedReceipt(JSON.stringify({ sha: 'a'.repeat(40), error: 'abc', number: 3, status: 'completed', conclusion: 'success',
      next_action: 'request_D12', branch: 'mcp/105856986/vibe-api-s7-live', verifiedSuccess: true, content: 'x', head_sha: 'A'.repeat(40) })))
      .toEqual({ sha: 'a'.repeat(40), branch: 'mcp/105856986/vibe-api-s7-live', number: 3, status: 'completed', conclusion: 'success',
        next_action: 'request_D12', verifiedSuccess: true });
    expect(typedStop('guided_violation:tool_not_offered:github_open_pr')).toEqual({ stop_code: 'guided_violation', stop_class: 'tool_not_offered' });
    expect(typedStop('guided_stop:precheck_failed')).toEqual({ stop_code: 'guided_stop', stop_class: 'precheck_failed' });
    expect(typedStop('model_permanent: clé zq7 refusée')).toEqual({ stop_code: 'model_permanent', stop_class: null });
    expect(typedStop('Erreur libre ' + 'x'.repeat(10))).toEqual({ stop_code: 'other', stop_class: null });
    expect(typedStop(null)).toEqual({ stop_code: 'other', stop_class: null });
    // Relecture GPT-6 (B2) : préfixe syntaxiquement valide mais inconnu → other (jamais repris).
    expect(typedStop('zq7hush: erreur')).toEqual({ stop_code: 'other', stop_class: null });
    expect(typedStop('zq7hush:precheck_failed')).toEqual({ stop_code: 'other', stop_class: 'precheck_failed' });
    for (const code of STOP_CODES) expect(typedStop(code + ': détail libre zq7').stop_code).toBe(code);
    expect([...STOP_CODES].sort()).toEqual(['cost_limit', 'deadline', 'effect_outcome_unknown', 'final', 'guided_handover_violation',
      'guided_preparation_violation', 'guided_stop', 'guided_violation', 'halted', 'incomplete_final',
      'model_permanent', 'model_transient', 'preempted', 'step_attempts_exhausted', 'step_limit', 'token_limit']);
  });

  it('modèle servi : chaque essai de maillon tracé (choisi, servi, repli, échec), visible du coordinateur', async () => {
    const w = await world();
    const { runId } = await completedRun(w);
    await recordRunModelCall(db, { run_id: runId, n: 2, chosen_ref: 'gemini:gemini-3.8-flash', ref: 'gemini:gemini-3.8-flash', ok: false,
      failure: 'transient', latency_ms: 1200, at: T });
    await recordRunModelCall(db, { run_id: runId, n: 2, chosen_ref: 'gemini:gemini-3.8-flash', ref: 'gemini:gemini-3.5-flash-lite', ok: true,
      failure: '', latency_ms: 800, at: T });
    const summary = await redactedRunSummaryFor(db, w.holder, runId);
    expect(summary!.model_calls).toEqual([
      { n: 2, k: 0, chosen_ref: 'gemini:gemini-3.8-flash', served_ref: 'gemini:gemini-3.8-flash', ok: false, fallback: false, failure: 'transient', latency_ms: 1200, input_tokens: null, output_tokens: null, estimated_input_tokens: null },
      { n: 2, k: 1, chosen_ref: 'gemini:gemini-3.8-flash', served_ref: 'gemini:gemini-3.5-flash-lite', ok: true, fallback: true, failure: '', latency_ms: 800, input_tokens: null, output_tokens: null, estimated_input_tokens: null },
    ]);
    await expect(db.prepare('UPDATE agent_run_model_calls SET ok = 1 WHERE run_id = ?1').bind(runId).run()).rejects.toThrow();
  });
});

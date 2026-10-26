import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, runStep, createReadToolHost, planAgentRuns, verdictOpId, VERDICT_STATES, TASK_KIND_COST_CENTS,
  ToolRefused, type GitHubReads, type ModelClient,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { TASK_KIND_BOUNDS, normalizeTaskKind, resolveEffectiveMaxTokens } from '../../../src/collab-store/executors/task-profiles';
import { countEvents, insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-7 L5b (S10) — store_verdict : verdict D12 contrôlé serveur pour les exécutions
// review/test. Sept contrôles (type, participant actif, tâche/rôle, identité logique
// D12, couple exact relu, CI verte, preuve de lecture github_diff), un test de refus
// par contrôle, journal agent_run_reads, N1 (plafonds par type de tâche câblés au
// canal API) et N2 (plafond de coût par type, 0 = fail-closed).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_995_000_000;
const REPO = 'rfkevin/github-mcp';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
let n = 0;
const uniq = (label: string) => '0000-l5b-' + label + '-' + (++n) + '-' + Date.now().toString(36);

/** Soumission d'un auteur au couple exact (seed par défaut de chaque cycle de test). */
const submission = { task: 'l5', pr: 300, state: 'SUBMITTED', source: 'github', head: HEAD, base: BASE };
interface SeededEvent { type: string; participant: string; role: string; payload: unknown }

/** Cycle ouvert en P6 avec la tâche l5, trois participants actifs, la soumission et les événements donnés. */
async function seedTask(label: string, extra?: (pids: { owner: string; reviewer: string; tester: string }) => SeededEvent[]) {
  const cycle = uniq(label);
  const pids = { owner: 'l5b-own-' + n, reviewer: 'l5b-rev-' + n, tester: 'l5b-tst-' + n };
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l5', cycle, ...pids });
  for (const pid of [pids.owner, pids.reviewer, pids.tester]) {
    await db.prepare("INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?2, 'active')")
      .bind(pid, pid).run();
  }
  const events = [
    { type: 'evidence.add', participant: pids.owner, role: 'owner', payload: submission },
    ...(extra ? extra(pids) : []),
  ];
  for (const [index, event] of events.entries()) {
    await insertEventRow(db, { cycle, type: event.type, participant: event.participant, role: event.role,
      payload: event.payload, key: cycle + ':e' + index, expectedRev: 1 });
  }
  return { cycle, ...pids };
}

/** Exécution de type donné pour le participant ; toute exécution active antérieure du même bail passe en failed. */
async function newRun(cycle: string, participant: string, kind: string, at = T) {
  await db.prepare("UPDATE agent_runs SET status = 'failed' WHERE cycle_id = ?1 AND participant_id = ?2 AND status = 'running'")
    .bind(cycle, participant).run();
  const runId = 'l5b-run-' + (++n) + '-' + Date.now().toString(36);
  const created = await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: 'l5', taskKind: kind,
    prompt: 'p', maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: at + 86_400, now: at });
  expect(created.created).toBe(true);
  return runId;
}

/** Lectures GitHub pilotées : PR au couple demandé, contrôles CI configurables. */
function fakeReads(over: {
  prHead?: string; prBase?: string; merged?: boolean; prMissing?: boolean;
  checks?: Array<Record<string, unknown>>;
} = {}): GitHubReads {
  return {
    async getTextFile(repository, path) { return { path, sha: OTHER, size: 1, content: 'x' }; },
    async getPullRequest() {
      if (over.prMissing) return null;
      return { number: 300, title: 'L5', state: 'open', draft: false, merged: over.merged === true,
        head: { ref: 'h', sha: over.prHead ?? HEAD }, base: { ref: 'b', sha: over.prBase ?? BASE } };
    },
    async listCheckRuns() {
      return over.checks ?? [
        { name: 'ci', status: 'completed', conclusion: 'success' },
        { name: 'workers-builds', status: 'completed', conclusion: 'success' },
      ];
    },
    async compareRefs(repository, base, head) {
      return { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [],
        files: [{ filename: 'a.txt', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@' }] };
    },
  };
}

/** Args complets d'un appel store_verdict ; override pour les tests de refus. */
function verdictCall(over: Record<string, unknown> = {}) {
  return { id: 'v', name: 'store_verdict', args: { task: 'l5', pr: 300, head: HEAD, base: BASE, state: 'AGREE', review: 'RAS', ...over } };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolRefused);
    return (error as Error).message;
  }
  throw new Error('refus attendu');
}

const withProof = async (host: ReturnType<typeof createReadToolHost>, runId: string) => {
  await host.execute({ id: 'd', name: 'github_diff', args: { base: BASE, head: HEAD } }, { run_id: runId });
};

describe('CC-7 L5b — store_verdict contrôlé serveur', () => {
  it('happy path review : preuve github_diff journalée puis verdict AGREE écrit par le serveur (rôle reviewer)', async () => {
    const q = await seedTask('happy');
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true, storeWrites: true });
    await withProof(host, runId);
    const read = (await db.prepare('SELECT tool, ref_sha, status FROM agent_run_reads WHERE run_id = ?1')
      .bind(runId).first<{ tool: string; ref_sha: string; status: string }>())!;
    expect(read).toEqual({ tool: 'github_diff', ref_sha: HEAD, status: 'completed' });
    const out = await host.execute(verdictCall(), { run_id: runId, effect_key: 'f'.repeat(64) }) as { seq: number };
    expect(typeof out.seq).toBe('number');
    expect(await countEvents(db, q.cycle, 'evidence.add')).toBe(2);
    const row = (await db.prepare("SELECT participant_id, role, payload_json, idempotency_key FROM events WHERE cycle_id = ?1 AND type = 'evidence.add' AND participant_id = ?2")
      .bind(q.cycle, q.reviewer).first<{ role: string; payload_json: string; idempotency_key: string }>())!;
    expect(row.role).toBe('reviewer');
    expect(JSON.parse(row.payload_json)).toEqual({ task: 'l5', source: 'github', pr: 300, head: HEAD, base: BASE, state: 'AGREE', review: 'RAS' });
    expect(row.idempotency_key).toBe('op:' + await verdictOpId('review', q.cycle, q.reviewer, 'l5', 300, HEAD, BASE, 'AGREE'));
  });

  it('happy path test : verdict PASS écrit avec rôle tester', async () => {
    const q = await seedTask('happy-test');
    const runId = await newRun(q.cycle, q.tester, 'test');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    await withProof(host, runId);
    await host.execute(verdictCall({ state: 'PASS' }), { run_id: runId, effect_key: '0'.repeat(64) });
    const row = (await db.prepare("SELECT role, payload_json FROM events WHERE cycle_id = ?1 AND type = 'evidence.add' AND participant_id = ?2")
      .bind(q.cycle, q.tester).first<{ role: string; payload_json: string }>())!;
    expect(row.role).toBe('tester');
    expect(JSON.parse(row.payload_json)).toMatchObject({ state: 'PASS' });
    expect(await countEvents(db, q.cycle, 'evidence.add')).toBe(2);
  });

  it('rejeu : même verdict = duplicate sans second événement ; autre texte libre = IDEMPOTENCY_CONFLICT', async () => {
    const q = await seedTask('replay');
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    await withProof(host, runId);
    const first = await host.execute(verdictCall(), { run_id: runId, effect_key: '1'.repeat(64) }) as { seq: number };
    const again = await host.execute(verdictCall(), { run_id: runId, effect_key: '2'.repeat(64) }) as { seq: number };
    expect(again.seq).toBe(first.seq);
    expect(await countEvents(db, q.cycle, 'evidence.add')).toBe(2);
    expect(await refusal(host.execute(verdictCall({ review: 'texte différent' }), { run_id: runId, effect_key: '3'.repeat(64) }))).toBe('IDEMPOTENCY_CONFLICT');
    expect(await countEvents(db, q.cycle, 'evidence.add')).toBe(2);
  });

  it('allowlist : store_verdict seulement avec verdicts+GitHub et pour review/test ; ① kind run et vocabulaire de la décision', async () => {
    const q = await seedTask('allow');
    const bare = createReadToolHost({ db, repository: REPO, github: fakeReads(), storeWrites: true });
    expect(bare.list('review')).not.toContain('store_verdict');
    expect(bare.spec('review', 'store_verdict')).toBeNull();
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true, storeWrites: true });
    for (const kind of ['review', 'test'] as const) {
      expect(host.list(kind)).toContain('store_verdict');
      expect(host.spec(kind, 'store_verdict')).toEqual({ name: 'store_verdict', effect: 'write' });
      expect(host.schemas(kind).map(schema => schema.name)).toContain('store_verdict');
    }
    for (const kind of ['research', 'answer', 'planning', 'status', 'implement']) {
      expect(host.list(kind)).not.toContain('store_verdict');
    }
    expect(createReadToolHost({ db, repository: null, github: null, verdicts: true }).list('review')).not.toContain('store_verdict');
    expect(VERDICT_STATES.review).toEqual(['AGREE', 'CHANGES_REQUESTED']);
    expect(VERDICT_STATES.test).toEqual(['PASS', 'FAIL']);
    const implementRun = await newRun(q.cycle, q.owner, 'implement');
    expect(await refusal(host.execute(verdictCall(), { run_id: implementRun, effect_key: '4'.repeat(64) }))).toBe('VERDICT_KIND_FORBIDDEN');
    const reviewRun = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host.execute(verdictCall({ state: 'PASS' }), { run_id: reviewRun, effect_key: '5'.repeat(64) }))).toBe('VERDICT_KIND_FORBIDDEN');
  });

  it('rôles : verdict de relecture refusé à l’auteur et au testeur de la tâche', async () => {
    const q = await seedTask('roles');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    const ownerRun = await newRun(q.cycle, q.owner, 'review');
    expect(await refusal(host.execute(verdictCall(), { run_id: ownerRun, effect_key: '6'.repeat(64) }))).toBe('VERDICT_ROLE_FORBIDDEN');
    const testerRun = await newRun(q.cycle, q.tester, 'review');
    expect(await refusal(host.execute(verdictCall(), { run_id: testerRun, effect_key: '7'.repeat(64) }))).toBe('VERDICT_ROLE_FORBIDDEN');
  });

  it('participant inactif : UNREGISTERED_PARTICIPANT, rien n’est écrit', async () => {
    const q = await seedTask('inactive');
    await db.prepare("UPDATE participants SET status = 'inactive' WHERE participant_id = ?1").bind(q.reviewer).run();
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    expect(await refusal(host.execute(verdictCall(), { run_id: runId, effect_key: '8'.repeat(64) }))).toBe('UNREGISTERED_PARTICIPANT');
  });

  it('tâche inconnue : TASK_UNKNOWN', async () => {
    const q = await seedTask('unknown-task');
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    expect(await refusal(host.execute(verdictCall({ task: 'l6' }), { run_id: runId, effect_key: '9'.repeat(64) }))).toBe('TASK_UNKNOWN');
  });

  it('identités confondues : SELF_REVIEW quand l’auteur et le relecteur partagent une famille logique', async () => {
    const q = await seedTask('self');
    await db.prepare('INSERT INTO participant_identity_families (participant_id, family_id, event_seq, updated_at) VALUES (?1, ?2, NULL, ?3), (?4, ?2, NULL, ?3)')
      .bind(q.owner, 'l5b-fam-1', T, q.reviewer).run();
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    expect(await refusal(host.execute(verdictCall(), { run_id: runId, effect_key: 'a'.repeat(64) }))).toBe('SELF_REVIEW');
  });

  it('couple : head divergent, base déplacée, PR fusionnée → VERDICT_COUPLE_MISMATCH ; PR inconnue → VERDICT_PR_UNKNOWN', async () => {
    const q = await seedTask('couple');
    const host = (github: GitHubReads) => createReadToolHost({ db, repository: REPO, github, verdicts: true });
    let runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host(fakeReads({ prHead: OTHER })).execute(verdictCall(), { run_id: runId, effect_key: 'b'.repeat(64) }))).toBe('VERDICT_COUPLE_MISMATCH');
    runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host(fakeReads({ prBase: OTHER })).execute(verdictCall(), { run_id: runId, effect_key: 'c'.repeat(64) }))).toBe('VERDICT_COUPLE_MISMATCH');
    runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host(fakeReads({ merged: true })).execute(verdictCall(), { run_id: runId, effect_key: 'd'.repeat(64) }))).toBe('VERDICT_COUPLE_MISMATCH');
    runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host(fakeReads({ prMissing: true })).execute(verdictCall(), { run_id: runId, effect_key: 'e'.repeat(64) }))).toBe('VERDICT_PR_UNKNOWN');
  });

  it('CI : rouge, en cours ou absente → VERDICT_CI_NOT_GREEN', async () => {
    const q = await seedTask('ci');
    const host = (github: GitHubReads) => createReadToolHost({ db, repository: REPO, github, verdicts: true });
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host(fakeReads({ checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] }))
      .execute(verdictCall(), { run_id: runId, effect_key: 'f'.repeat(64) }))).toBe('VERDICT_CI_NOT_GREEN');
    expect(await refusal(host(fakeReads({ checks: [{ name: 'ci', status: 'in_progress', conclusion: null }] }))
      .execute(verdictCall(), { run_id: runId, effect_key: '1'.repeat(64) }))).toBe('VERDICT_CI_NOT_GREEN');
    expect(await refusal(host(fakeReads({ checks: [] }))
      .execute(verdictCall(), { run_id: runId, effect_key: '2'.repeat(64) }))).toBe('VERDICT_CI_NOT_GREEN');
  });

  it('preuve de lecture : github_diff au head exigé pour CETTE exécution', async () => {
    const q = await seedTask('proof');
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    expect(await refusal(host.execute(verdictCall(), { run_id: runId, effect_key: '3'.repeat(64) }))).toBe('VERDICT_READ_PROOF_MISSING');
    await host.execute({ id: 'd', name: 'github_diff', args: { base: BASE, head: OTHER } }, { run_id: runId });
    expect(await refusal(host.execute(verdictCall(), { run_id: runId, effect_key: '4'.repeat(64) }))).toBe('VERDICT_READ_PROOF_MISSING');
  });

  it('N2 : plafond de coût dépassé → cost_limit avant tout appel modèle', async () => {
    const q = await seedTask('cost');
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    await db.prepare('UPDATE agent_runs SET cost_cents = 1 WHERE run_id = ?1').bind(runId).run();
    let calls = 0;
    const model: ModelClient = { complete: async () => { calls += 1; return { output: { text: 'x', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } }; } };
    const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
    const outcome = await runStep(db, runId, { model, tools: host, now: () => T, workerId: 'w' });
    expect(outcome.outcome).toBe('cost_limit');
    expect(calls).toBe(0);
  });

  // HALT est un drapeau global : ce test passe le drapeau puis le relève TOUJOURS.
  it('HALT : aucune écriture de verdict, modèle jamais appelé (garde LIVE du moteur)', async () => {
    const q = await seedTask('halt');
    const runId = await newRun(q.cycle, q.reviewer, 'review');
    await db.prepare("INSERT INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', ?1)").bind(T).run();
    try {
      let calls = 0;
      const model: ModelClient = { complete: async () => { calls += 1; return { output: { text: 'x', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } }; } };
      const host = createReadToolHost({ db, repository: REPO, github: fakeReads(), verdicts: true });
      const outcome = await runStep(db, runId, { model, tools: host, now: () => T, workerId: 'w' });
      expect(outcome.outcome).toBe('halted');
      expect(calls).toBe(0);
      expect(await countEvents(db, q.cycle, 'evidence.add')).toBe(1);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
  });
});

describe('CC-7 L5b — N1 : plafonds de jetons par type de tâche', () => {
  it('kinds réels du canal API dans TASK_KIND_BOUNDS, normalizeTaskKind et resolveEffectiveMaxTokens', () => {
    for (const kind of ['planning', 'status', 'implement', 'research'] as const) {
      expect(normalizeTaskKind(kind)).toBe(kind);
    }
    expect(TASK_KIND_BOUNDS.planning).toEqual({ max_tokens: 4_096, thinking: 'low' });
    expect(TASK_KIND_BOUNDS.status).toEqual({ max_tokens: 2_048, thinking: 'off' });
    expect(TASK_KIND_BOUNDS.implement).toEqual({ max_tokens: 4_096, thinking: 'low' });
    expect(TASK_KIND_BOUNDS.research).toEqual({ max_tokens: 4_096, thinking: 'low' });
    expect(resolveEffectiveMaxTokens({ task_kind: 'review' })).toBe(2_048);
    expect(resolveEffectiveMaxTokens({ task_kind: 'implement' })).toBe(4_096);
  });

  it('engineFor câble le résolveur : max_tokens envoyé = borne du type de tâche ; store_verdict proposé', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ai = { async run(_model: string, input: Record<string, unknown>) {
      calls.push(input);
      return { choices: [{ message: { content: 'fin' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } };
    const deps = engineFor({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: ai, AGENT_RUN_REPOSITORY: REPO }, db, fakeReads())('r');
    expect(deps.tools.list('review')).toContain('store_verdict');
    await deps.model.complete({ messages: [], tools: deps.tools.list('review'), task_kind: 'review' });
    await deps.model.complete({ messages: [], tools: [], task_kind: 'implement' });
    expect((calls[0] as { max_tokens: number }).max_tokens).toBe(2_048);
    expect((calls[1] as { max_tokens: number }).max_tokens).toBe(4_096);
  });
});

describe('CC-7 L5b — N2 : plafond de coût par type de tâche', () => {
  it('registre figé à 0 (fail-closed) et planAgentRuns le passe à chaque exécution', async () => {
    expect(Object.isFrozen(TASK_KIND_COST_CENTS)).toBe(true);
    expect(TASK_KIND_COST_CENTS).toEqual({ answer: 0, review: 0, test: 0, implement: 0 });
    const q = await seedTask('n2');
    const out = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: q.reviewer + ',' + q.tester }, { now: T });
    expect(out.created).toBe(2);
    const rows = (await db.prepare('SELECT task_kind, max_cost_cents FROM agent_runs WHERE cycle_id = ?1')
      .bind(q.cycle).all<{ task_kind: string; max_cost_cents: number }>()).results;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.max_cost_cents).toBe(0);
      expect(row.max_cost_cents).toBe(TASK_KIND_COST_CENTS[row.task_kind as 'review' | 'test']);
    }
  });
});

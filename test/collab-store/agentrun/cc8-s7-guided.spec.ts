import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, ToolRefused, type AgentMessage, type ModelOutput, type ToolCall, type ToolHost }
  from '../../../src/collab-store/agentrun';
import { planGuidedS7, type GuidedEntry } from '../../../src/collab-store/agentrun/s7-guided';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC8 S7 — mode guidé : le serveur fait les étapes mécaniques, le modèle écrit seulement le contenu.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_970_000_000;
const BRANCH = 'mcp/105856986/vibe-api-s7-live';
const PATH = 'test/collab-store/agentrun/s7-live-vibe.spec.ts';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);
const SCOPE = { branch: BRANCH, name: 's7-live', base_branch: 'mcp/105856986/cc3-integration', base_sha: BASE, granted_paths: [PATH], task_paths: [PATH], corrections_remaining: 3 };
const WAIT = (sha: string) => ({ targetSha: sha, status: 'in_progress', conclusion: null, verifiedSuccess: false, next_action: 'wait', next_poll_seconds: 15 });
const PASSED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'success', verifiedSuccess: true, next_action: 'request_D12', next_poll_seconds: null });
const FAILED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'failure', verifiedSuccess: false, next_action: 'correct', next_poll_seconds: null, diagnostics: ['expected 1 to be 2'] });

const S7_TOOLS = ['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_replace_text', 'github_run_checks',
  'github_check_result', 'github_open_pr', 'github_read_file'];

function host(queues: Record<string, Array<unknown | (() => never)>>) {
  const calls: ToolCall[] = [];
  const tools: ToolHost = {
    list: () => S7_TOOLS,
    spec: (_kind, name) => S7_TOOLS.includes(name) ? { name, effect: name === 'github_read_file' ? 'read' : 'write' } : null,
    async execute(call: ToolCall) {
      calls.push(call);
      const next = (queues[call.name] ?? []).shift();
      if (typeof next === 'function') return (next as () => never)();
      if (next === undefined) throw new ToolRefused('unexpected ' + call.name);
      return next;
    },
  };
  return { tools, calls };
}

function scripted(outputs: ModelOutput[]) {
  const seen: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
  return {
    seen,
    client: { async complete(input: { messages: AgentMessage[]; tools: string[] }) {
      seen.push({ messages: input.messages, tools: input.tools });
      return { output: outputs[seen.length - 1] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 2_000, cost_cents: 0 } };
    } },
  };
}

const commit = (head: string, content: string): ModelOutput => ({ text: '', tool_calls: [{ id: 'm-commit', name: 'github_commit_files',
  args: { name: 's7-live', expected_head_sha: head, message: 'S7 test', files: [{ path: PATH, content }] } }] });

async function newRun(label: string, maxSteps = 12) {
  await ensureSchema(db);
  const runId = 'cc8-guided-' + label + '-' + crypto.randomUUID();
  const cycleId = 'cc8-guided-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 'S7-live-vibe', taskKind: 'implement', prompt: 'Écris le test S7.',
    maxSteps, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
  const grants = [{ cycle: cycleId, participant: 'vibe', task: 'S7-live-vibe', branch: BRANCH }];
  return { runId, grants };
}

async function drive(runId: string, deps: Parameters<typeof runStep>[2], max = 30) {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const { outcome } = await runStep(db, runId, deps);
    outcomes.push(outcome);
    if (outcome !== 'stepped') break;
  }
  return outcomes;
}

async function row(runId: string) {
  return (await db.prepare('SELECT status, stop_reason, steps_done, tokens_used FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; stop_reason: string; steps_done: number; tokens_used: number }>())!;
}

describe('CC8 S7 — mode guidé (planificateur pur)', () => {
  const e = (tool: string, value: Record<string, unknown> | null, failed = false): GuidedEntry => ({ tool, value, failed });
  it('enchaîne mandat → branche → contenu (modèle) → CI → résultat → PR', () => {
    expect(planGuidedS7([], BRANCH, 'S7-live-vibe', 0)).toMatchObject({ kind: 'server', call: { name: 'github_write_scope' } });
    const s1 = [e('github_write_scope', SCOPE)];
    expect(planGuidedS7(s1, BRANCH, 'S7-live-vibe', 1)).toMatchObject({ kind: 'server', call: { name: 'github_create_branch', args: { name: 's7-live', base_sha: BASE } } });
    const s2 = [...s1, e('github_create_branch', { branch: BRANCH, sha: HEAD })];
    const content = planGuidedS7(s2, BRANCH, 'S7-live-vibe', 2);
    expect(content).toMatchObject({ kind: 'model', tools: ['github_commit_files'] });
    expect(content?.kind === 'model' && content.instruction).toContain(HEAD);
    expect(content?.kind === 'model' && content.instruction).toContain(PATH);
    const s3 = [...s2, e('github_commit_files', { branch: BRANCH, commit_sha: C1 })];
    expect(planGuidedS7(s3, BRANCH, 'S7-live-vibe', 3)).toMatchObject({ kind: 'server', call: { name: 'github_run_checks', args: { sha: C1 } } });
    const s4 = [...s3, e('github_run_checks', { targetSha: C1, runId: 9 })];
    expect(planGuidedS7(s4, BRANCH, 'S7-live-vibe', 4)).toMatchObject({ kind: 'server', call: { name: 'github_check_result', args: { sha: C1, run_id: 9 } } });
    const s5 = [...s4, e('github_check_result', PASSED(C1))];
    expect(planGuidedS7(s5, BRANCH, 'S7-live-vibe', 5)).toMatchObject({ kind: 'server', call: { name: 'github_open_pr', args: { name: 's7-live' } } });
    expect(planGuidedS7([...s5, e('github_open_pr', { branch: BRANCH, number: 1, head_sha: C1, draft: false })], BRANCH, 'S7-live-vibe', 6))
      .toEqual({ kind: 'stop', reason: 'pr_already_open' });
  });
  it('CI rouge → correction par le modèle au SHA du dernier commit ; refus ou état inattendu → arrêt typé', () => {
    const base = [e('github_write_scope', SCOPE), e('github_create_branch', { branch: BRANCH, sha: HEAD }),
      e('github_commit_files', { branch: BRANCH, commit_sha: C1 }), e('github_run_checks', { targetSha: C1, runId: 9 })];
    const fix = planGuidedS7([...base, e('github_check_result', FAILED(C1))], BRANCH, 'S7-live-vibe', 5);
    expect(fix).toMatchObject({ kind: 'model', tools: ['github_commit_files'] });
    expect(fix?.kind === 'model' && fix.instruction).toContain(C1);
    expect(planGuidedS7([...base, e('github_check_result', { targetSha: C1, next_action: 'escalate', status: 'blocked' })], BRANCH, 'S7-live-vibe', 5))
      .toEqual({ kind: 'stop', reason: 'ci_escalate' });
    expect(planGuidedS7([...base, e('github_check_result', { next_action: 'escalate', status: 'blocked' })], BRANCH, 'S7-live-vibe', 5))
      .toEqual({ kind: 'stop', reason: 'check_unexpected' });
    expect(planGuidedS7([e('github_write_scope', SCOPE), e('github_create_branch', null, true)], BRANCH, 'S7-live-vibe', 2))
      .toEqual({ kind: 'stop', reason: 'branch_refused' });
    expect(planGuidedS7([e('github_write_scope', null, true)], BRANCH, 'S7-live-vibe', 1)).toEqual({ kind: 'stop', reason: 'scope_refused' });
    expect(planGuidedS7([e('github_write_scope', { ...SCOPE, branch: 'autre' })], BRANCH, 'S7-live-vibe', 1))
      .toMatchObject({ kind: 'server', call: { name: 'github_write_scope' } });
  });
});

describe('CC8 S7 — mode guidé (moteur, D1)', () => {
  it('parcours complet : un seul appel modèle (contenu), le reste par le serveur, run completed final', async () => {
    const { runId, grants } = await newRun('happy');
    const model = scripted([commit(HEAD, 'export {};\n')]);
    const { tools, calls } = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD, base: 'x' }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1, files: [PATH], next_action: 'github_run_checks' }],
      github_run_checks: [{ targetSha: C1, runId: 9 }], github_check_result: [WAIT(C1), PASSED(C1)],
      github_open_pr: [{ branch: BRANCH, number: 300, head_sha: C1, draft: false }],
    });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(1);
    // L'étape de contenu reçoit un seul outil et une consigne précise.
    expect(model.seen[0].tools).toEqual(['github_commit_files']);
    const instruction = model.seen[0].messages.at(-1)!;
    expect(instruction.role).toBe('user');
    expect(instruction.content).toContain(HEAD);
    expect(instruction.content).toContain(PATH);
    expect(calls.map(c => c.name).filter(n => n !== 'github_read_file')).toEqual(['github_write_scope', 'github_create_branch',
      'github_commit_files', 'github_run_checks', 'github_check_result', 'github_check_result', 'github_open_pr']);
    expect(await row(runId)).toMatchObject({ status: 'completed', stop_reason: 'final', tokens_used: 2_000 });
    // 6 étapes (5 serveur + 1 modèle) ; le relevé de CI n'en consomme pas.
    expect((await row(runId)).steps_done).toBe(6);
    const server = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_server_steps WHERE run_id = ?1').bind(runId).first<{ c: number }>();
    expect(server?.c).toBe(5);
  });

  it('relecture D12 R1 : le serveur impose name, expected_head_sha et le expected_sha du fichier lu au head', async () => {
    const { runId, grants } = await newRun('fill');
    const BLOB = 'e'.repeat(40);
    // Le modèle se trompe de nom et de head et invente un expected_sha : le serveur corrige.
    const model = scripted([{ text: '', tool_calls: [{ id: 'm', name: 'github_commit_files', args: { name: 'autre', expected_head_sha: 'f'.repeat(40),
      message: 'm', files: [{ path: PATH, content: 'x', expected_sha: '0'.repeat(40) }] } }] }]);
    const { tools, calls } = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_read_file: [{ path: PATH, sha: BLOB, size: 7, content: 'ancien contenu' }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
      github_check_result: [PASSED(C1)], github_open_pr: [{ branch: BRANCH, number: 302, head_sha: C1, draft: false }],
    });
    expect((await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true })).at(-1)).toBe('completed');
    const commitCall = calls.find(c => c.name === 'github_commit_files')!;
    expect(commitCall.args).toMatchObject({ name: 's7-live', expected_head_sha: HEAD, files: [{ path: PATH, content: 'x', expected_sha: BLOB }] });
    expect(calls.find(c => c.name === 'github_read_file')?.args).toEqual({ path: PATH, ref: HEAD });
    expect(model.seen[0].messages.at(-1)!.content).toContain('ancien contenu');
  });

  it('relecture D12 R2 : trois corrections tiennent (étapes serveur hors max_steps), diagnostics injectés', async () => {
    const { runId, grants } = await newRun('three-fixes', 4);
    const C3 = '1'.repeat(40);
    const C4 = '2'.repeat(40);
    const model = scripted([commit(HEAD, 'v1'), commit(C1, 'v2'), commit(C2, 'v3'), commit(C3, 'v4')]);
    const { tools } = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_commit_files: [C1, C2, C3, C4].map(c => ({ branch: BRANCH, commit_sha: c })),
      github_run_checks: [C1, C2, C3, C4].map((c, i) => ({ targetSha: c, runId: 20 + i })),
      github_check_result: [FAILED(C1), FAILED(C2), FAILED(C3), PASSED(C4)],
      github_open_pr: [{ branch: BRANCH, number: 303, head_sha: C4, draft: false }],
    });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true }, 40);
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(4);
    expect(model.seen[1].messages.at(-1)!.content).toContain('expected 1 to be 2');
    const r = await row(runId);
    expect(r).toMatchObject({ status: 'completed', stop_reason: 'final' });
    // 4 étapes modèle (= max_steps 4) et 11 étapes serveur, hors plafond.
    expect(r.steps_done).toBe(15);
    const server = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_server_steps WHERE run_id = ?1').bind(runId).first<{ c: number }>();
    expect(server?.c).toBe(11);
  });

  it('la limite d’étapes modèle reste appliquée : une correction au-delà de max_steps → step_limit', async () => {
    const { runId, grants } = await newRun('limit', 1);
    const model = scripted([commit(HEAD, 'v1'), commit(C1, 'v2')]);
    const { tools } = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
      github_check_result: [FAILED(C1)],
    });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('step_limit');
    expect(model.seen).toHaveLength(1);
  });

  it('branche préexistante : reprise depuis la tête lue dans le mandat, sans création, preuve de complétude valable', async () => {
    const { runId, grants } = await newRun('existing');
    const model = scripted([commit(HEAD, 'v1')]);
    const { tools, calls } = host({
      github_write_scope: [{ ...SCOPE, branch_head: HEAD }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
      github_check_result: [PASSED(C1)], github_open_pr: [{ branch: BRANCH, number: 304, head_sha: C1, draft: false }],
    });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(calls.some(c => c.name === 'github_create_branch')).toBe(false);
    expect(calls.find(c => c.name === 'github_commit_files')?.args).toMatchObject({ expected_head_sha: HEAD });
    expect(await row(runId)).toMatchObject({ status: 'completed', stop_reason: 'final' });
  });

  it('texte sans outil à l’étape de contenu : échec typé immédiat, jamais de faux succès ni de rafale', async () => {
    const { runId, grants } = await newRun('no-tool');
    const model = scripted([{ text: 'Je vais réfléchir.', tool_calls: [] }]);
    const { tools } = host({ github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }] });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('failed');
    expect(model.seen).toHaveLength(1);
    expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: 'guided_violation:no_tool_call' });
  });

  it('CI rouge : le modèle corrige au SHA du commit, puis le serveur relance la CI et ouvre la PR', async () => {
    const { runId, grants } = await newRun('fix');
    const model = scripted([commit(HEAD, 'bug'), commit(C1, 'fixed')]);
    const { tools } = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }, { branch: BRANCH, commit_sha: C2 }],
      github_run_checks: [{ targetSha: C1, runId: 9 }, { targetSha: C2, runId: 10 }],
      github_check_result: [FAILED(C1), PASSED(C2)],
      github_open_pr: [{ branch: BRANCH, number: 301, head_sha: C2, draft: false }],
    });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(2);
    expect(model.seen[1].tools).toEqual(['github_commit_files']);
    expect(model.seen[1].messages.at(-1)!.content).toContain('ÉCHOUÉ');
    expect(model.seen[1].messages.at(-1)!.content).toContain(C1);
    expect(await row(runId)).toMatchObject({ status: 'completed', stop_reason: 'final', tokens_used: 4_000 });
  });

  it('refus serveur (branche) : arrêt typé guided_stop, aucun repli libre, le modèle n’est jamais rappelé', async () => {
    const { runId, grants } = await newRun('refused');
    const model = scripted([{ text: 'Je ne peux pas créer la branche.', tool_calls: [] }]);
    const { tools } = host({ github_write_scope: [SCOPE], github_create_branch: [() => { throw new ToolRefused('api_write_branch_exists'); }] });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('failed');
    expect(model.seen).toHaveLength(0);
    expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: 'guided_stop:branch_refused' });
  });

  for (const [label, output, reason] of [
    ['open_pr non offert', { text: '', tool_calls: [{ id: 'x', name: 'github_open_pr', args: { name: 's7-live', title: 't' } }] }, 'guided_violation:tool_not_offered:github_open_pr'],
    ['replace_text non offert', { text: '', tool_calls: [{ id: 'x', name: 'github_replace_text', args: { name: 's7-live' } }] }, 'guided_violation:tool_not_offered:github_replace_text'],
    ['commit + open_pr', { text: '', tool_calls: [commit(HEAD, 'a').tool_calls[0], { id: 'y', name: 'github_open_pr', args: {} }] }, 'guided_violation:tool_not_offered:github_commit_files,github_open_pr'],
    ['deux commits', { text: '', tool_calls: [commit(HEAD, 'a').tool_calls[0], { ...commit(HEAD, 'b').tool_calls[0], id: 'm2' }] }, 'guided_violation:multiple_tool_calls:2'],
  ] as Array<[string, ModelOutput, string]>) {
    it('relecture D12 (2e passe) : sortie hostile à l’étape de contenu (' + label + ') → arrêt typé AVANT tout effet', async () => {
      const { runId, grants } = await newRun('hostile');
      const model = scripted([output]);
      const { tools, calls } = host({ github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
        github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_open_pr: [{ branch: BRANCH, number: 9, head_sha: C1, draft: false }],
        github_replace_text: [{ branch: BRANCH, commit_sha: C1 }] });
      const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
      expect(outcomes.at(-1)).toBe('failed');
      expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: reason });
      // Aucun effet après les deux étapes serveur : ni commit, ni PR, ni remplacement.
      expect(calls.map(c => c.name).filter(n => n !== 'github_read_file')).toEqual(['github_write_scope', 'github_create_branch']);
    });
  }

  it('plafond serveur atteint : arrêt typé guided_stop:server_cap', async () => {
    const { runId, grants } = await newRun('cap');
    for (let k = 0; k < 24; k++) await db.prepare('INSERT INTO agent_run_server_steps (run_id, n) VALUES (?1, ?2)').bind(runId, 1000 + k).run();
    const model = scripted([]);
    const { tools, calls } = host({ github_write_scope: [SCOPE] });
    expect(await runStep(db, runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true }))
      .toEqual({ outcome: 'failed' });
    expect(calls).toHaveLength(0);
    expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: 'guided_stop:server_cap' });
  });

  it('HALT : aucune étape serveur, le run s’arrête ; sans mandat ou sans activation, comportement historique', async () => {
    const halted = await newRun('halt');
    const { tools, calls } = host({ github_write_scope: [SCOPE] });
    const model = scripted([]);
    await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', '1', NULL, ?1) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .bind(T).run();
    try {
      expect(await runStep(db, halted.runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: halted.grants, guidedS7: true }))
        .toEqual({ outcome: 'halted' });
      expect(calls).toHaveLength(0);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
    for (const label of ['noflag', 'nogrant']) {
      const { runId, grants } = await newRun(label);
      const m = scripted([{ text: 'fin', tool_calls: [] }]);
      const h = host({});
      await runStep(db, runId, { model: m.client, tools: h.tools, now: () => T + 100, workerId: 'w1',
        ...(label === 'noflag' ? { githubCompletionGrants: grants } : { guidedS7: true }) });
      expect(m.seen).toHaveLength(1);
      expect(m.seen[0].tools).toEqual(S7_TOOLS);
      expect(h.calls).toHaveLength(0);
    }
  });
});

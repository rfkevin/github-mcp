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

async function newRun(label: string) {
  await ensureSchema(db);
  const runId = 'cc8-guided-' + label + '-' + crypto.randomUUID();
  const cycleId = 'cc8-guided-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 'S7-live-vibe', taskKind: 'implement', prompt: 'Écris le test S7.',
    maxSteps: 12, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
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
    expect(planGuidedS7([...s5, e('github_open_pr', { branch: BRANCH, number: 1, head_sha: C1, draft: false })], BRANCH, 'S7-live-vibe', 6)).toBeNull();
  });
  it('CI rouge → correction par le modèle au SHA du dernier commit ; refus ou état inattendu → aucun guidage', () => {
    const base = [e('github_write_scope', SCOPE), e('github_create_branch', { branch: BRANCH, sha: HEAD }),
      e('github_commit_files', { branch: BRANCH, commit_sha: C1 }), e('github_run_checks', { targetSha: C1, runId: 9 })];
    const fix = planGuidedS7([...base, e('github_check_result', FAILED(C1))], BRANCH, 'S7-live-vibe', 5);
    expect(fix).toMatchObject({ kind: 'model', tools: ['github_commit_files'] });
    expect(fix?.kind === 'model' && fix.instruction).toContain(C1);
    expect(planGuidedS7([...base, e('github_check_result', { next_action: 'escalate', status: 'blocked' })], BRANCH, 'S7-live-vibe', 5)).toBeNull();
    expect(planGuidedS7([e('github_write_scope', SCOPE), e('github_create_branch', null, true)], BRANCH, 'S7-live-vibe', 2)).toBeNull();
    expect(planGuidedS7([e('github_write_scope', null, true)], BRANCH, 'S7-live-vibe', 1)).toBeNull();
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
    expect(calls.map(c => c.name)).toEqual(['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_run_checks',
      'github_check_result', 'github_check_result', 'github_open_pr']);
    expect(await row(runId)).toMatchObject({ status: 'completed', stop_reason: 'final', tokens_used: 2_000 });
    // 6 étapes (5 serveur + 1 modèle) ; le relevé de CI n'en consomme pas.
    expect((await row(runId)).steps_done).toBe(6);
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

  it('refus serveur (branche) : plus de guidage, le modèle reprend la main avec tous ses outils ; jamais de faux succès', async () => {
    const { runId, grants } = await newRun('refused');
    const model = scripted([{ text: 'Je ne peux pas créer la branche.', tool_calls: [] }]);
    const { tools } = host({ github_write_scope: [SCOPE], github_create_branch: [() => { throw new ToolRefused('api_write_branch_exists'); }] });
    const outcomes = await drive(runId, { model: model.client, tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('failed');
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0].tools).toEqual(S7_TOOLS);
    expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: 'incomplete_final:github_evidence_missing' });
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

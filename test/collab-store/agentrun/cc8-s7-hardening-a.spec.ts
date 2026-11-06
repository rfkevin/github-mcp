import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, ToolRefused, type AgentMessage, type ModelOutput, type ToolCall, type ToolHost }
  from '../../../src/collab-store/agentrun';
import { canonicalGuidedOutput, GUIDED_PRECHECK_TOOL, guidedPrecheck, guidedViolation, planGuidedS7, PRECHECK_MAX_BYTES,
  type GuidedEntry } from '../../../src/collab-store/agentrun/s7-guided';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC8 S7 durcissement — lot A (#281, issue mère #280) : R1 nom d'outil canonique, R2 prévalidation du contenu.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_970_000_000;
const BRANCH = 'mcp/105856986/vibe-api-s7-live';
const PATH = 'test/collab-store/agentrun/s7-live-vibe.spec.ts';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const C1 = 'c'.repeat(40);
const C2 = 'd'.repeat(40);
const SCOPE = { branch: BRANCH, name: 's7-live', base_branch: 'mcp/105856986/cc3-integration', base_sha: BASE, granted_paths: [PATH], task_paths: [PATH], corrections_remaining: 3 };
const PASSED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'success', verifiedSuccess: true, next_action: 'request_D12', next_poll_seconds: null });
const FAILED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'failure', verifiedSuccess: false, next_action: 'correct', next_poll_seconds: null, diagnostics: ['x'] });
const GOOD = "import { describe, expect, it } from 'vitest';\nimport { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n"
  + "describe('s7', () => { it('plan', () => { expect(planGuidedS7([], 'a-api-b', 't', 0).kind).toBe('server'); }); });\n";
const JEST = "import { describe, expect, it } from '@jest/globals';\ndescribe('s7', () => { it('x', () => { expect(1).toBe(1); }); });\n";

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
  return { tools, calls, writes: () => calls.map(c => c.name).filter(n => n !== 'github_read_file') };
}

function scripted(outputs: ModelOutput[], tokens = 2_000) {
  const seen: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
  return {
    seen,
    client: { async complete(input: { messages: AgentMessage[]; tools: string[] }) {
      seen.push({ messages: input.messages, tools: input.tools });
      return { output: outputs[seen.length - 1] ?? { text: 'fin', tool_calls: [] }, usage: { tokens, cost_cents: 0 } };
    } },
  };
}

const commitAs = (name: string, content: string, head = HEAD): ModelOutput => ({ text: '', tool_calls: [{ id: 'm-commit', name,
  args: { name: 's7-live', expected_head_sha: head, message: 'S7 test', files: [{ path: PATH, content }] } }] });
const commit = (content: string, head = HEAD) => commitAs('github_commit_files', content, head);

async function newRun(label: string, maxSteps = 12) {
  await ensureSchema(db);
  const runId = 'cc8-hardening-a-' + label + '-' + crypto.randomUUID();
  const cycleId = 'cc8-hardening-a-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 'S7-live-vibe', taskKind: 'implement', prompt: 'Écris le test S7.',
    maxSteps, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
  return { runId, grants: [{ cycle: cycleId, participant: 'vibe', task: 'S7-live-vibe', branch: BRANCH }] };
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

async function journal(runId: string, kind: string) {
  const { results } = await db.prepare('SELECT detail FROM agent_run_journal WHERE run_id = ?1 AND kind = ?2 ORDER BY id').bind(runId, kind)
    .all<{ detail: string }>();
  return results.map(r => JSON.parse(r.detail) as Record<string, unknown>);
}

const happyQueues = () => ({
  github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
  github_commit_files: [{ branch: BRANCH, commit_sha: C1 }], github_run_checks: [{ targetSha: C1, runId: 9 }],
  github_check_result: [PASSED(C1)], github_open_pr: [{ branch: BRANCH, number: 300, head_sha: C1, draft: false }],
});

describe('Lot A R1 — nom d’outil canonique (pur)', () => {
  const one = (name: string): ModelOutput => commitAs(name, GOOD);
  for (const name of [' github_commit_files ', 'github_commit_files ', '\tgithub_commit_files\n', ' github_commit_files', '﻿github_commit_files']) {
    it('espaces de bord acceptés et canonisés : ' + JSON.stringify(name), () => {
      const { output, normalized } = canonicalGuidedOutput(one(name));
      expect(output.tool_calls[0].name).toBe('github_commit_files');
      expect(normalized).toEqual([JSON.stringify(name)]);
      expect(guidedViolation(output)).toBeNull();
      // Arguments, chemins et SHA jamais touchés.
      expect(output.tool_calls[0].args).toEqual(one(name).tool_calls[0].args);
    });
  }
  for (const [name, why] of [
    ['GitHub_commit_files', 'casse'], ['github_commit _files', 'espace interne'], ['github_commit_files​', 'caractère invisible non blanc'],
    ['gіthub_commit_files', 'homoglyphe cyrillique'], ['github_commit_files_x', 'suffixe'], ['github_open_pr', 'autre outil'], ['', 'vide'],
  ] as Array<[string, string]>) {
    it('refus strict (' + why + ') : nom laissé intact, guided_violation', () => {
      const { output, normalized } = canonicalGuidedOutput(one(name));
      expect(output.tool_calls[0].name).toBe(name);
      expect(normalized).toEqual([]);
      expect(guidedViolation(output)).toMatch(/^tool_not_offered:/);
    });
  }
  it('deux appels, même canonisés : toujours refusés', () => {
    const two: ModelOutput = { text: '', tool_calls: [one(' github_commit_files').tool_calls[0], { ...one('github_commit_files ').tool_calls[0], id: 'm2' }] };
    expect(guidedViolation(canonicalGuidedOutput(two).output)).toBe('multiple_tool_calls:2');
  });
});

describe('Lot A R2 — prévalidation statique (pure)', () => {
  const call = (files: unknown, message: unknown = 'msg'): ToolCall => ({ id: 'c', name: 'github_commit_files', args: { name: 's7-live', message, files } });
  it('contenu Vitest valide accepté ; fichier non test sans exigence vitest', () => {
    expect(guidedPrecheck(call([{ path: PATH, content: GOOD }]), [PATH])).toBeNull();
    expect(guidedPrecheck(call([{ path: 'docs/a.md', content: '# titre' }]), ['docs/a.md'])).toBeNull();
    expect(guidedPrecheck(call([{ path: 'src/a.ts', content: 'export const a = 1;' }]), ['src/a.ts'])).toBeNull();
  });
  for (const [label, content, cause] of [
    ['@jest/globals', JEST, 'test_runner_incompatible'],
    ['jest (require)', "const { expect } = require('jest');\nimport { it } from 'vitest';\n", 'test_runner_incompatible'],
    ['mocha', "import { describe } from 'mocha';\n", 'test_runner_incompatible'],
    ['aucun import vitest', "describe('x', () => { it('y', () => {}); });\n", 'test_vitest_import_missing'],
    ['vide', '   \n', 'content_empty'],
    ['trop gros', "import { it } from 'vitest';\n" + 'x'.repeat(PRECHECK_MAX_BYTES), 'content_too_large'],
  ] as Array<[string, string, string]>) {
    it('spec refusée (' + label + ') → ' + cause, () => {
      expect(guidedPrecheck(call([{ path: PATH, content }]), [PATH])).toBe(cause);
    });
  }
  it('schéma, chemin, doublon et message refusés avant GitHub', () => {
    expect(guidedPrecheck(call([{ path: 'src/autre.ts', content: 'x' }]), [PATH])).toBe('path_not_granted');
    expect(guidedPrecheck(call([{ path: PATH, content: GOOD }, { path: PATH, content: GOOD }]), [PATH, 'b'])).toBe('path_duplicate');
    expect(guidedPrecheck(call([{ path: PATH, content: GOOD }, { path: 'b', content: 'x' }]), [PATH])).toBe('too_many_files');
    expect(guidedPrecheck(call([]), [PATH])).toBe('files_missing');
    expect(guidedPrecheck(call('x'), [PATH])).toBe('files_missing');
    expect(guidedPrecheck(call(['x']), [PATH])).toBe('file_invalid');
    expect(guidedPrecheck(call([{ path: PATH, content: 42 }]), [PATH])).toBe('content_empty');
    expect(guidedPrecheck(call([{ path: PATH, content: GOOD }], ''), [PATH])).toBe('message_missing');
    expect(guidedPrecheck(call([{ path: PATH, content: GOOD }], 'm'.repeat(501)), [PATH])).toBe('message_too_long');
  });
});

describe('Lot A R2 — planificateur : une reformulation, puis arrêt typé', () => {
  const e = (tool: string, value: Record<string, unknown> | null, failed = false, detail?: string): GuidedEntry => ({ tool, value, failed, detail });
  const created = [e('github_write_scope', SCOPE), e('github_create_branch', { branch: BRANCH, sha: HEAD })];
  const refused = (cause: string) => e(GUIDED_PRECHECK_TOOL, null, true, cause);
  it('contenu initial : consigne Vitest/qualité ; 1 refus → consigne de reprise avec la cause ; 2 refus → precheck_failed', () => {
    const first = planGuidedS7(created, BRANCH, 'S7-live-vibe', 2);
    expect(first.kind === 'model' && first.instruction).toContain('vitest');
    expect(first.kind === 'model' && first.instruction).toContain('pas de test tautologique');
    expect(first.kind === 'model' && first.instruction).not.toContain('REFUSÉE');
    const retry = planGuidedS7([...created, refused('test_runner_incompatible')], BRANCH, 'S7-live-vibe', 3);
    expect(retry).toMatchObject({ kind: 'model', tools: ['github_commit_files'] });
    expect(retry.kind === 'model' && retry.instruction).toContain('REFUSÉE');
    expect(retry.kind === 'model' && retry.instruction).toContain('test_runner_incompatible');
    expect(planGuidedS7([...created, refused('a'), refused('b')], BRANCH, 'S7-live-vibe', 4)).toEqual({ kind: 'stop', reason: 'precheck_failed' });
  });
  it('correction après CI rouge : refus comptés depuis le dernier résultat seulement', () => {
    const red = [...created, refused('content_empty'), e('github_commit_files', { branch: BRANCH, commit_sha: C1 }),
      e('github_run_checks', { targetSha: C1, runId: 9 }), e('github_check_result', FAILED(C1))];
    // Le refus d'avant le commit initial ne compte pas pour la correction.
    const fix = planGuidedS7(red, BRANCH, 'S7-live-vibe', 6);
    expect(fix.kind === 'model' && fix.instruction).not.toContain('REFUSÉE');
    expect(planGuidedS7([...red, refused('x')], BRANCH, 'S7-live-vibe', 7)).toMatchObject({ kind: 'model' });
    expect(planGuidedS7([...red, refused('x'), refused('y')], BRANCH, 'S7-live-vibe', 8)).toEqual({ kind: 'stop', reason: 'precheck_failed' });
  });
});

describe('Lot A — moteur (D1)', () => {
  it('R1 : nom avec espaces de bord → commit exécuté sous le nom canonique, normalisation tracée, run completed', async () => {
    const { runId, grants } = await newRun('r1-ok');
    const model = scripted([commitAs(' github_commit_files ', GOOD)]);
    const h = host(happyQueues());
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_run_checks', 'github_check_result', 'github_open_pr']);
    expect(await journal(runId, 'guided_tool_normalized')).toEqual([{ n: 2, worker: 'w1', raw_names: [JSON.stringify(' github_commit_files ')] }]);
  });

  it('R1 : espace interne ou caractère invisible → guided_violation, nom brut au journal, aucun commit', async () => {
    for (const name of ['github_commit _files', 'github_commit_files​']) {
      const { runId, grants } = await newRun('r1-bad');
      const model = scripted([commitAs(name, GOOD)]);
      const h = host(happyQueues());
      const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
      expect(outcomes.at(-1)).toBe('failed');
      expect((await row(runId)).stop_reason).toMatch(/^guided_violation:tool_not_offered:/);
      expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch']);
      const [trace] = await journal(runId, 'guided_violation');
      expect(trace.raw_names).toEqual([JSON.stringify(name)]);
      expect(await journal(runId, 'guided_tool_normalized')).toEqual([]);
    }
  });

  it('R2 : import Jest refusé AVANT GitHub, reformulation comptée (étape modèle + jetons), puis succès', async () => {
    const { runId, grants } = await newRun('r2-retry');
    const model = scripted([commit(JEST), commit(GOOD)]);
    const h = host(happyQueues());
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(2);
    expect(model.seen[1].tools).toEqual(['github_commit_files']);
    const retry = model.seen[1].messages.at(-1)!.content;
    expect(retry).toContain('REFUSÉE');
    expect(retry).toContain('test_runner_incompatible');
    // Un seul commit GitHub (le contenu valide), une seule CI : la reformulation ne consomme pas de correction.
    expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_run_checks', 'github_check_result', 'github_open_pr']);
    expect(h.calls.find(c => c.name === 'github_commit_files')!.args).toMatchObject({ files: [{ path: PATH, content: GOOD }] });
    // 7 étapes : 5 serveur + 2 modèle (dont la reformulation) ; jetons des deux appels.
    expect(await row(runId)).toMatchObject({ status: 'completed', stop_reason: 'final', steps_done: 7, tokens_used: 4_000 });
    const servers = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_server_steps WHERE run_id = ?1').bind(runId).first<{ c: number }>();
    expect(servers?.c).toBe(5);
    const effect = await db.prepare("SELECT status, result FROM agent_run_effects WHERE run_id = ?1 AND tool = ?2").bind(runId, GUIDED_PRECHECK_TOOL)
      .first<{ status: string; result: string }>();
    expect(effect).toMatchObject({ status: 'failed' });
    expect(JSON.parse(effect!.result)).toEqual({ error: 'guided_precheck', cause: 'test_runner_incompatible' });
  });

  it('R2 : deux refus consécutifs → guided_stop:precheck_failed, aucun commit ni CI', async () => {
    const { runId, grants } = await newRun('r2-stop');
    const model = scripted([commit(JEST), commit("describe('x', () => {});\n"), commit(GOOD)]);
    const h = host(happyQueues());
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('failed');
    expect(model.seen).toHaveLength(2);
    expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch']);
    expect(await row(runId)).toMatchObject({ status: 'failed', stop_reason: 'guided_stop:precheck_failed', tokens_used: 4_000 });
  });

  it('R2 : la reformulation compte dans max_steps — max_steps 1 → step_limit après le refus', async () => {
    const { runId, grants } = await newRun('r2-limit', 1);
    const model = scripted([commit(JEST), commit(GOOD)]);
    const h = host(happyQueues());
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('step_limit');
    expect(model.seen).toHaveLength(1);
    expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch']);
  });

  it('R2 : correction après CI rouge — refus Jest, reprise, CI relancée une seule fois de plus', async () => {
    const { runId, grants } = await newRun('r2-fix');
    const model = scripted([commit(GOOD), commit(JEST, C1), commit(GOOD + '// corrigé\n', C1)]);
    const h = host({
      github_write_scope: [SCOPE], github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }, { branch: BRANCH, commit_sha: C2 }],
      github_run_checks: [{ targetSha: C1, runId: 9 }, { targetSha: C2, runId: 10 }],
      github_check_result: [FAILED(C1), PASSED(C2)], github_open_pr: [{ branch: BRANCH, number: 301, head_sha: C2, draft: false }],
    });
    const outcomes = await drive(runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true });
    expect(outcomes.at(-1)).toBe('completed');
    expect(model.seen).toHaveLength(3);
    expect(model.seen[2].messages.at(-1)!.content).toContain('ÉCHOUÉ');
    expect(model.seen[2].messages.at(-1)!.content).toContain('REFUSÉE');
    expect(h.writes().filter(n => n === 'github_commit_files')).toHaveLength(2);
    expect(h.writes().filter(n => n === 'github_run_checks')).toHaveLength(2);
  });

  it('R2 sous garde : HALT entre la sortie modèle et la prévalidation → halted, aucun refus enregistré, aucun effet', async () => {
    const { runId, grants } = await newRun('r2-halt');
    const model = scripted([commit(JEST)]);
    const h = host(happyQueues());
    const probe = async (point: string) => {
      if (point === 'after_model') {
        await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', '1', NULL, ?1) ON CONFLICT(name) DO UPDATE SET value = excluded.value").bind(T).run();
      }
    };
    try {
      const deps = { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true };
      expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
      expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
      expect(await runStep(db, runId, { ...deps, probe })).toEqual({ outcome: 'halted' });
      expect(await row(runId)).toMatchObject({ status: 'halted' });
      const refusedRows = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_effects WHERE run_id = ?1 AND tool = ?2').bind(runId, GUIDED_PRECHECK_TOOL).first<{ c: number }>();
      expect(refusedRows?.c).toBe(0);
      expect(h.writes()).toEqual(['github_write_scope', 'github_create_branch']);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
  });

  it('R2 rejouable : coupure après model_done → la reprise retrouve le même refus (clé déterministe), sans doublon ni GitHub', async () => {
    const { runId, grants } = await newRun('r2-replay');
    const model = scripted([commit(JEST), commit(GOOD)]);
    const h = host(happyQueues());
    const deps = { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'w1', githubCompletionGrants: grants, guidedS7: true };
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
    expect(await runStep(db, runId, deps)).toEqual({ outcome: 'stepped' });
    await expect(runStep(db, runId, { ...deps, probe: async (p: string) => { if (p === 'after_model') throw new Error('coupure'); } })).rejects.toThrow('coupure');
    // Reprise par un autre worker après péremption de la réclamation.
    const outcomes = await drive(runId, { ...deps, workerId: 'w2', now: () => T + 1_000 });
    expect(outcomes.at(-1)).toBe('completed');
    const refusedRows = await db.prepare('SELECT COUNT(*) AS c FROM agent_run_effects WHERE run_id = ?1 AND tool = ?2').bind(runId, GUIDED_PRECHECK_TOOL).first<{ c: number }>();
    expect(refusedRows?.c).toBe(1);
    expect(model.seen).toHaveLength(2);
    expect(h.writes().filter(n => n === 'github_commit_files')).toHaveLength(1);
  });
});

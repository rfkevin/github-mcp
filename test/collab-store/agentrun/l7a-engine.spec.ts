import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, runStep, preemptByChat, releaseChat, runSummary, ModelCallError, ToolRefused, STEP_TIMEOUT_S,
  type ModelOutput, type ToolCall, type ToolHost, type LookupResult, type AgentMessage,
} from '../../../src/collab-store/agentrun';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-5 l7 incrément 7a — moteur d'exécution autonome, modèle simulé (0 €).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const T0 = 1_900_000_000;

class Crash extends Error {}

function scripted(outputs: ModelOutput[], options: { fail?: number; usage?: { tokens: number; cost_cents: number } } = {}) {
  const state = { calls: 0 };
  return {
    state,
    async complete(input: { messages: AgentMessage[] }) {
      state.calls += 1;
      if (options.fail && state.calls <= options.fail) throw new ModelCallError('fournisseur indisponible', { tokens: 7, cost_cents: 0 });
      const step = input.messages.filter(message => message.role === 'assistant').length;
      return { output: outputs[step] ?? { text: 'fin', tool_calls: [] }, usage: options.usage ?? { tokens: 100, cost_cents: 0 } };
    },
  };
}

function host(options: {
  onExecute?: (call: ToolCall) => void | Promise<void>;
  lookup?: (call: ToolCall, ctx: { effect_key: string }) => Promise<LookupResult>;
  failWith?: Error;
} = {}) {
  const log: string[] = [];
  const commits: string[] = [];
  const specs: Record<string, 'read' | 'write'> = { read_file: 'read', commit: 'write', post_note: 'write' };
  const tools: ToolHost = {
    spec: (_kind, name) => (specs[name] ? { name, effect: specs[name] } : null),
    list: () => Object.keys(specs),
    async execute(call, ctx) {
      log.push(call.name);
      await options.onExecute?.(call);
      if (options.failWith) throw options.failWith;
      if (call.name === 'commit') {
        commits.push(ctx.effect_key!);
        return { sha: 'sha-' + commits.length };
      }
      return 'contenu de ' + String(call.args.path ?? '?');
    },
    lookup: options.lookup ? (call, ctx) => options.lookup!(call, ctx) : undefined,
  };
  return { tools, log, commits };
}

const READ_THEN_COMMIT: ModelOutput[] = [
  { text: 'je lis', tool_calls: [{ id: 'a', name: 'read_file', args: { path: 'src/x.ts' } }] },
  { text: 'je corrige', tool_calls: [{ id: 'b', name: 'commit', args: { message: 'fix', expectedHeadSha: 'h1' } }] },
  { text: 'correction faite', tool_calls: [] },
];

async function newRun(overrides: Partial<{ maxSteps: number; maxTokens: number; maxCostCents: number; deadlineAt: number; now: number; task: string }> = {}) {
  await ensureSchema(db);
  const id = ++n;
  const input = {
    runId: 'l7a-run-' + id + '-' + Date.now().toString(36), cycleId: 'l7a-cycle-' + id, participantId: 'vibe',
    taskId: overrides.task ?? 'fix-1', taskKind: 'fix', prompt: 'Corrige le test cassé.',
    maxSteps: overrides.maxSteps ?? 10, maxTokens: overrides.maxTokens ?? 100_000, maxCostCents: overrides.maxCostCents ?? 0,
    deadlineAt: overrides.deadlineAt ?? T0 + 86_400, now: overrides.now ?? T0,
  };
  const created = await createRun(db, input);
  return { input, created };
}

function deps(model: ReturnType<typeof scripted>, tools: ToolHost, at: () => number, extra: Partial<{ workerId: string; probe: (point: string) => void }> = {}) {
  return { model, tools, now: at, workerId: extra.workerId ?? 'w1', probe: extra.probe };
}

async function status(runId: string) {
  return (await db.prepare('SELECT status, stop_reason, steps_done, tokens_used FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; stop_reason: string; steps_done: number; tokens_used: number }>())!;
}

async function setHalt(value: '0' | '1') {
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, NULL, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(value).run();
}

describe('CC-5 l7a — exécution pas à pas', () => {
  it('lecture, effet, réponse finale : terminé, un seul commit, usage compté', async () => {
    const { input, created } = await newRun();
    expect(created.created).toBe(true);
    const model = scripted(READ_THEN_COMMIT);
    const h = host();
    const d = deps(model, h.tools, () => T0 + 1);
    expect((await runStep(db, input.runId, d)).outcome).toBe('stepped');
    expect((await runStep(db, input.runId, d)).outcome).toBe('stepped');
    expect((await runStep(db, input.runId, d)).outcome).toBe('completed');
    expect((await runStep(db, input.runId, d)).outcome).toBe('completed');
    expect(h.commits).toHaveLength(1);
    expect(model.state.calls).toBe(3);
    const summary = await runSummary(db, input.runId);
    expect(summary).toMatchObject({ status: 'completed', stop_reason: 'final', steps_done: 3, tokens_used: 300, summary: 'correction faite' });
    expect(summary!.effects).toEqual([{ tool: 'commit', status: 'completed' }]);
  });

  it('double réveil sur la même étape : le second reçoit busy et rien n’est exécuté deux fois', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT);
    const h = host();
    const [a, b] = await Promise.all([
      runStep(db, input.runId, deps(model, h.tools, () => T0 + 1, { workerId: 'w1' })),
      runStep(db, input.runId, deps(model, h.tools, () => T0 + 1, { workerId: 'w2' })),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['busy', 'stepped']);
    expect(model.state.calls).toBe(1);
    expect(h.log).toEqual(['read_file']);
  });
});

describe('CC-5 l7a — coupures et reprise', () => {
  it('coupure après l’appel modèle : la reprise réutilise la décision enregistrée (pas de second appel)', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT);
    const h = host();
    let crash = true;
    const probe = (point: string) => { if (crash && point === 'after_model') { crash = false; throw new Crash('coupure'); } };
    await expect(runStep(db, input.runId, deps(model, h.tools, () => T0 + 1, { probe }))).rejects.toThrow('coupure');
    // Alarme perdue puis réveil de secours, avant l'expiration : l'étape est encore tenue.
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 2, { workerId: 'w2' }))).outcome).toBe('busy');
    // Après STEP_TIMEOUT_S : reprise par un autre worker, depuis D1 seulement.
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 2 + STEP_TIMEOUT_S, { workerId: 'w2' }))).outcome).toBe('stepped');
    expect(model.state.calls).toBe(1);
    expect(h.log).toEqual(['read_file']);
  });

  it('coupure après l’effet externe et avant son enregistrement : lookup le retrouve, aucun second commit', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT);
    let seen: string | null = null;
    const h = host({ lookup: async (_call, ctx) => (seen === ctx.effect_key ? { found: true, result: { sha: 'sha-1' } } : { found: false }) });
    const at = T0 + 1;
    await runStep(db, input.runId, deps(model, h.tools, () => at));
    let crash = true;
    const probe = (point: string) => {
      if (crash && point === 'after_effect') { crash = false; seen = h.commits[0]; throw new Crash('coupure'); }
    };
    await expect(runStep(db, input.runId, deps(model, h.tools, () => at, { probe }))).rejects.toThrow('coupure');
    expect(h.commits).toHaveLength(1);
    expect((await runStep(db, input.runId, deps(model, h.tools, () => at + STEP_TIMEOUT_S, { workerId: 'w2' }))).outcome).toBe('stepped');
    expect(h.commits).toHaveLength(1);
    expect((await runStep(db, input.runId, deps(model, h.tools, () => at + STEP_TIMEOUT_S, { workerId: 'w2' }))).outcome).toBe('completed');
    expect((await runSummary(db, input.runId))!.effects).toEqual([{ tool: 'commit', status: 'completed' }]);
  });

  it('effet incertain sans moyen de vérifier : needs_reconcile, jamais réémis', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT);
    const h = host();
    await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1));
    let crash = true;
    const probe = (point: string) => { if (crash && point === 'after_effect') { crash = false; throw new Crash('coupure'); } };
    await expect(runStep(db, input.runId, deps(model, h.tools, () => T0 + 1, { probe }))).rejects.toThrow('coupure');
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1 + STEP_TIMEOUT_S, { workerId: 'w2' }))).outcome).toBe('needs_reconcile');
    expect(h.commits).toHaveLength(1);
    expect(await status(input.runId)).toMatchObject({ status: 'needs_reconcile' });
    expect((await runSummary(db, input.runId))!.effects).toEqual([{ tool: 'commit', status: 'ambiguous' }]);
  });

  it('délai dépassé pendant l’effet (erreur non certaine) : ambiguous et arrêt ; refus certain : failed et l’agent continue', async () => {
    const ambiguous = await newRun();
    const h1 = host({ failWith: new Error('timeout') });
    const model1 = scripted([READ_THEN_COMMIT[1]]);
    expect((await runStep(db, ambiguous.input.runId, deps(model1, h1.tools, () => T0 + 1))).outcome).toBe('needs_reconcile');
    const refused = await newRun();
    const h2 = host({ failWith: new ToolRefused('expected_head_mismatch') });
    const model2 = scripted([READ_THEN_COMMIT[1]]);
    expect((await runStep(db, refused.input.runId, deps(model2, h2.tools, () => T0 + 1))).outcome).toBe('stepped');
    expect((await runSummary(db, refused.input.runId))!.effects).toEqual([{ tool: 'commit', status: 'failed' }]);
  });

  it('effet resté pending, lookup certain qu’il n’a pas eu lieu : il est tenté une seule fois', async () => {
    const { input } = await newRun();
    const model = scripted([READ_THEN_COMMIT[1]]);
    const h = host({ lookup: async () => ({ found: false }) });
    let crash = true;
    const probe = (point: string) => { if (crash && point === 'before_effect') { crash = false; throw new Crash('coupure'); } };
    await expect(runStep(db, input.runId, deps(model, h.tools, () => T0 + 1, { probe }))).rejects.toThrow('coupure');
    expect(h.commits).toHaveLength(0);
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1 + STEP_TIMEOUT_S))).outcome).toBe('stepped');
    expect(h.commits).toHaveLength(1);
  });

  it('erreurs modèle : un réessai, puis échec terminal ; l’usage des échecs est compté', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT, { fail: 5 });
    const h = host();
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1))).outcome).toBe('retry');
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 2))).outcome).toBe('failed');
    expect(await status(input.runId)).toMatchObject({ status: 'failed', tokens_used: 14 });
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 3))).outcome).toBe('failed');
    expect(model.state.calls).toBe(2);
  });
});

describe('CC-5 l7a — préemption par le chat et HALT', () => {
  it('le chat reprend la main pendant l’effet : l’effet est enregistré, l’étape refusée, l’exécution préemptée', async () => {
    const { input } = await newRun();
    const model = scripted([READ_THEN_COMMIT[1], READ_THEN_COMMIT[2]]);
    const h = host({ onExecute: async () => { await preemptByChat(db, { cycleId: input.cycleId, participantId: 'vibe', taskId: 'fix-1', now: T0 + 1, holdSeconds: 600 }); } });
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1))).outcome).toBe('preempted');
    expect(h.commits).toHaveLength(1);
    expect((await runSummary(db, input.runId))!.effects).toEqual([{ tool: 'commit', status: 'completed' }]);
    expect(await status(input.runId)).toMatchObject({ status: 'preempted', steps_done: 0 });
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 2))).outcome).toBe('preempted');
    expect(model.state.calls).toBe(1);
  });

  it('préemption avant l’effet : aucun effet ; le chat tient le bail, une nouvelle exécution est refusée puis permise après libération', async () => {
    const { input } = await newRun();
    await preemptByChat(db, { cycleId: input.cycleId, participantId: 'vibe', taskId: 'fix-1', now: T0, holdSeconds: 600 });
    const h = host();
    const model = scripted(READ_THEN_COMMIT);
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1))).outcome).toBe('preempted');
    expect(model.state.calls).toBe(0);
    const again = { ...input, runId: input.runId + '-b', now: T0 + 10 };
    expect(await createRun(db, again)).toEqual({ created: false, reason: 'chat_holds_lease' });
    await releaseChat(db, { cycleId: input.cycleId, participantId: 'vibe', taskId: 'fix-1', now: T0 + 20 });
    const third = await createRun(db, { ...input, runId: input.runId + '-c', now: T0 + 30 });
    expect(third.created).toBe(true);
    // Même run_id rejoué : pas de seconde exécution.
    expect(await createRun(db, { ...input, runId: input.runId + '-c', now: T0 + 40 })).toEqual({ created: false, reason: 'run_exists' });
  });

  it('une seule exécution active par clé de bail', async () => {
    const { input } = await newRun();
    expect(await createRun(db, { ...input, runId: input.runId + '-2', now: T0 + 5 })).toEqual({ created: false, reason: 'run_already_active' });
  });

  it('HALT entre deux étapes : aucune étape suivante, aucun appel modèle ; création refusée', async () => {
    const { input } = await newRun();
    const model = scripted(READ_THEN_COMMIT);
    const h = host();
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1))).outcome).toBe('stepped');
    await setHalt('1');
    try {
      expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 2))).outcome).toBe('halted');
      expect(model.state.calls).toBe(1);
      expect(h.commits).toHaveLength(0);
      const other = await newRun({ task: 'fix-halt' });
      expect(other.created).toEqual({ created: false, reason: 'halted' });
    } finally {
      await setHalt('0');
    }
  });

  it('HALT posé pendant l’appel modèle : la décision n’est pas enregistrée, l’usage l’est', async () => {
    const { input } = await newRun();
    const h = host();
    const model = {
      state: { calls: 0 },
      async complete() { this.state.calls += 1; await setHalt('1'); return { output: READ_THEN_COMMIT[1], usage: { tokens: 50, cost_cents: 0 } }; },
    };
    try {
      expect((await runStep(db, input.runId, { model, tools: h.tools, now: () => T0 + 1, workerId: 'w1' })).outcome).toBe('halted');
      expect(h.commits).toHaveLength(0);
      expect(await status(input.runId)).toMatchObject({ status: 'halted', tokens_used: 50 });
    } finally {
      await setHalt('0');
    }
  });
});

describe('CC-5 l7a — plafonds et outils', () => {
  it('plafond d’étapes, de jetons et échéance vérifiés à chaque étape', async () => {
    const steps = await newRun({ maxSteps: 1 });
    const loop: ModelOutput[] = Array.from({ length: 5 }, () => READ_THEN_COMMIT[0]);
    expect((await runStep(db, steps.input.runId, deps(scripted(loop), host().tools, () => T0 + 1))).outcome).toBe('step_limit');
    const tokens = await newRun({ maxTokens: 150 });
    const model = scripted(loop);
    expect((await runStep(db, tokens.input.runId, deps(model, host().tools, () => T0 + 1))).outcome).toBe('stepped');
    expect((await runStep(db, tokens.input.runId, deps(model, host().tools, () => T0 + 2))).outcome).toBe('token_limit');
    expect((await runStep(db, tokens.input.runId, deps(model, host().tools, () => T0 + 3))).outcome).toBe('token_limit');
    expect(model.state.calls).toBe(2);
    const late = await newRun({ deadlineAt: T0 + 5 });
    expect((await runStep(db, late.input.runId, deps(scripted(loop), host().tools, () => T0 + 6))).outcome).toBe('deadline');
    const costly = await newRun();
    expect((await runStep(db, costly.input.runId, deps(scripted(loop, { usage: { tokens: 1, cost_cents: 3 } }), host().tools, () => T0 + 1))).outcome).toBe('cost_limit');
  });

  it('outil hors allowlist, outil interdit au canal API et verdict D12 : refusés sans exécution', async () => {
    const { input } = await newRun();
    const h = host();
    const model = scripted([{
      text: 'tentatives', tool_calls: [
        { id: '1', name: 'merge', args: {} },
        { id: '2', name: 'evidence.add', args: { state: 'PASS' } },
        { id: '3', name: 'delete_branch', args: {} },
        { id: '4', name: 'post_note', args: { review: 'AGREE au couple h/b' } },
      ],
    }]);
    expect((await runStep(db, input.runId, deps(model, h.tools, () => T0 + 1))).outcome).toBe('stepped');
    expect(h.log).toEqual([]);
    const row = await db.prepare('SELECT results FROM agent_run_steps WHERE run_id = ?1 AND n = 0').bind(input.runId).first<{ results: string }>();
    expect((JSON.parse(row!.results) as { content: string }[]).map(entry => JSON.parse(entry.content).error)).toEqual([
      'tool_forbidden_on_api_channel', 'tool_forbidden_on_api_channel', 'tool_not_allowlisted', 'd12_verdict_forbidden_on_api_channel',
    ]);
  });

  it('les tables sont append-only : suppression refusée', async () => {
    const { input } = await newRun();
    await expect(db.prepare('DELETE FROM agent_runs WHERE run_id = ?1').bind(input.runId).run()).rejects.toThrow(/append-only/);
  });
});

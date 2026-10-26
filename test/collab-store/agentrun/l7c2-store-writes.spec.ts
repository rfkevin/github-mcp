import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runStep, createReadToolHost, createStoreWriteTools, effectOpId, WRITE_TOOLS_BY_KIND, planAgentRuns, apiParticipants, answerRunId,
  taskRunId, ToolRefused, type ModelClient, type ModelOutput,
} from '../../../src/collab-store/agentrun';
import { agentRunPass } from '../../../src/collab-store/agentrun/orchestrator';
import { engineFor, AGENT_RUN_SYSTEM } from '../../../src/collab-store/agentrun/object';
import { previewNextActions } from '../../../src/collab-store/controller';
import { parseOpId } from '../../../src/collab-store/contracts/phases';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { insertCycleRow, insertEventRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC-5 l7 incrément 7c-2 — écritures store non-verdict du canal API (clarify, task.status
// in_progress/blocked), idempotentes par clé d'effet, et création d'exécutions depuis les
// décisions du contrôleur (question adressée, et réveils de tâche depuis L5a), éteinte par défaut.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_970_000_000;
let n = 0;
// Préfixe trié en tête : le planificateur lit au plus PLAN_MAX_CYCLES cycles ouverts par ordre d'id.
const uniq = (label: string) => '0000-0l7c2-' + label + '-' + (++n) + '-' + Date.now().toString(36);
const KEY = (c: string) => c.repeat(64);

afterEach(() => { vi.restoreAllMocks(); });

/** Cycle ouvert en P6, tâche l7 (owner/reviewer/tester), question adressée à `to` par `asker`. */
async function seedQuestion(label: string, to: string, asker = 'p-ask') {
  await ensureSchema(db);
  const cycle = uniq(label);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { taskId: 'l7', cycle, owner: 'p-own-' + n, reviewer: 'p-rev-' + n, tester: 'p-tst-' + n });
  await insertEventRow(db, { cycle, type: 'clarify.ask', participant: asker, role: '', payload: { question: 'Quel SHA ?', to },
    key: cycle + ':ask:1', expectedRev: 1 });
  const askSeq = (await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(cycle + ':ask:1').first<{ seq: number }>())!.seq;
  return { cycle, askSeq, owner: 'p-own-' + n, reviewer: 'p-rev-' + n };
}

async function newRun(cycle: string, participant: string, kind: string, at = T) {
  const runId = 'l7c2-run-' + (++n) + '-' + Date.now().toString(36);
  const created = await createRun(db, { runId, cycleId: cycle, participantId: participant, taskId: 'l7', taskKind: kind, prompt: 'p',
    maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: at + 86_400, now: at });
  expect(created.created).toBe(true);
  return runId;
}

function scripted(outputs: ModelOutput[]): ModelClient {
  let i = 0;
  return { async complete() { return { output: outputs[i++] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 10, cost_cents: 0 } }; } };
}

async function eventsOf(cycle: string, type: string) {
  return (await db.prepare('SELECT seq, participant_id, role, payload_json, idempotency_key FROM events WHERE cycle_id = ?1 AND type = ?2 ORDER BY seq')
    .bind(cycle, type).all<{ seq: number; participant_id: string; role: string; payload_json: string; idempotency_key: string }>()).results;
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

describe('CC-5 l7c-2 — hôte : écritures figées par type de tâche', () => {
  it('écritures seulement avec storeWrites, effet write, deny-by-default ; jamais evidence.add ni verdict', () => {
    const readOnly = createReadToolHost({ db, repository: null, github: null });
    const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    expect(readOnly.list('answer')).toEqual(['store_context', 'store_delta']);
    expect(host.list('answer')).toEqual(['store_context', 'store_delta', 'store_answer']);
    expect(host.list('research')).toEqual(['store_context', 'store_delta']);
    expect(host.list('fix')).toEqual([]);
    expect(host.list('__proto__')).toEqual([]);
    expect(host.spec('answer', 'store_answer')).toEqual({ name: 'store_answer', effect: 'write' });
    expect(host.spec('answer', 'store_task_status')).toBeNull();
    expect(host.spec('status', 'store_task_status')).toEqual({ name: 'store_task_status', effect: 'write' });
    expect(host.schemas('planning').map(s => s.name)).toEqual(['store_context', 'store_delta', 'store_ask']);
    expect(typeof host.lookup).toBe('function');
    const all = Object.values(WRITE_TOOLS_BY_KIND).flat();
    expect(all.some(name => /evidence|verdict|owner|merge/.test(name))).toBe(false);
    const statusSchema = host.schemas('status').find(s => s.name === 'store_task_status')!;
    expect((statusSchema.parameters as { properties: { status: { enum: string[] } } }).properties.status.enum).toEqual(['in_progress', 'blocked']);
  });

  it('op_id dérivé de la clé d’effet : déterministe, grammaire stricte du store, segment client canonique', () => {
    const a = effectOpId('agent:gpt6', 'cc5', KEY('a'));
    expect(a).toBe(effectOpId('agent:gpt6', 'cc5', KEY('a')));
    expect(a).not.toBe(effectOpId('agent:gpt6', 'cc5', KEY('b')));
    expect(parseOpId(a)).toEqual({ client: 'agent.gpt6', cycle: 'cc5', op: 'api-' + 'a'.repeat(32), n: '1' });
    expect(() => effectOpId('agent:gpt6', 'cc5', 'pas-une-cle')).toThrow(ToolRefused);
    expect(() => effectOpId('a.b', 'cc5', KEY('a'))).toThrow(ToolRefused);
  });
});

describe('CC-5 l7c-2 — écritures store', () => {
  it('parcours moteur réel : la réponse est écrite une fois, par le participant de l’exécution, et ferme la question', async () => {
    const q = await seedQuestion('engine', 'p-resp');
    const runId = await newRun(q.cycle, 'p-resp', 'answer');
    const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    const model = scripted([
      { text: '', tool_calls: [{ id: 'a', name: 'store_answer', args: { ask_seq: q.askSeq, answer: 'Le SHA est bc58d886.' } }] },
      { text: 'Réponse déposée.', tool_calls: [] },
    ]);
    const deps = { model, tools: host, now: () => T, workerId: 'w1' };
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    const answers = await eventsOf(q.cycle, 'clarify.answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ participant_id: 'p-resp', role: 'api-agent' });
    expect(JSON.parse(answers[0].payload_json)).toEqual({ ask_seq: q.askSeq, answer: 'Le SHA est bc58d886.' });
    const effect = (await db.prepare('SELECT effect_key, status, result FROM agent_run_effects WHERE run_id = ?1').bind(runId)
      .first<{ effect_key: string; status: string; result: string }>())!;
    expect(effect.status).toBe('completed');
    expect(answers[0].idempotency_key).toBe('op:' + effectOpId('p-resp', q.cycle, effect.effect_key));
    expect(JSON.parse(effect.result)).toMatchObject({ seq: answers[0].seq, type: 'clarify.answer', status: 'applied' });
    expect((await previewNextActions(db, q.cycle, 'p-resp')).mine.some(d => d.action === 'answer_question')).toBe(false);
  });

  it('rejeu de la même clé d’effet : événement original (duplicate), aucune seconde écriture ; lookup avant et après', async () => {
    const q = await seedQuestion('replay', 'p-resp');
    const runId = await newRun(q.cycle, 'p-resp', 'answer');
    const tools = createStoreWriteTools(db);
    const call = { id: 'x', name: 'store_answer', args: { ask_seq: q.askSeq, answer: 'oui' } };
    const ctx = { run_id: runId, effect_key: KEY('c') };
    expect(await tools.lookup(call, ctx)).toEqual({ found: false });
    const first = await tools.execute(call, ctx) as { seq: number; status: string };
    expect(first.status).toBe('applied');
    const again = await tools.execute(call, ctx) as { seq: number; status: string };
    expect(again).toMatchObject({ seq: first.seq, status: 'duplicate' });
    expect(await tools.lookup(call, ctx)).toEqual({ found: true, result: { seq: first.seq, type: 'clarify.answer', status: 'duplicate' } });
    expect(await eventsOf(q.cycle, 'clarify.answer')).toHaveLength(1);
  });

  it('STALE : réessai borné à la révision courante, une seule écriture', async () => {
    const q = await seedQuestion('stale', 'p-resp');
    const runId = await newRun(q.cycle, 'p-resp', 'answer');
    const current = await new CollabStore(db).currentRevision(q.cycle);
    vi.spyOn(CollabStore.prototype, 'currentRevision').mockResolvedValueOnce(current - 1);
    const out = await createStoreWriteTools(db).execute({ id: 'x', name: 'store_answer', args: { ask_seq: q.askSeq, answer: 'ok' } },
      { run_id: runId, effect_key: KEY('d') }) as { status: string };
    expect(out.status).toBe('applied');
    expect(await eventsOf(q.cycle, 'clarify.answer')).toHaveLength(1);
  });

  it('task.status : in_progress/blocked par un rôle de la tâche ; review, verified, done refusés sans rien écrire', async () => {
    const q = await seedQuestion('status', 'p-resp');
    const runId = await newRun(q.cycle, q.reviewer, 'status');
    const tools = createStoreWriteTools(db);
    const status = (s: string, key: string) => tools.execute({ id: 's', name: 'store_task_status', args: { task: 'l7', status: s, note: 'attente CI' } },
      { run_id: runId, effect_key: KEY(key) });
    for (const [s, key] of [['review', '1'], ['verified', '2'], ['done', '3']] as const) {
      expect(await refusal(status(s, key))).toContain('in_progress ou blocked');
    }
    expect(await eventsOf(q.cycle, 'task.status')).toHaveLength(0);
    expect(await status('blocked', '4')).toMatchObject({ type: 'task.status', status: 'applied' });
    const [event] = await eventsOf(q.cycle, 'task.status');
    expect(JSON.parse(event.payload_json)).toEqual({ task: { task_id: 'l7', status: 'blocked' }, note: 'attente CI' });
    expect((await db.prepare('SELECT status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2').bind(q.cycle, 'l7').first<{ status: string }>())!.status).toBe('blocked');
  });

  it('gardes du store conservées : tâche non tenue, réponse d’un tiers, cycle clos → refus certain (ToolRefused), rien d’écrit', async () => {
    const q = await seedQuestion('guards', 'p-resp');
    const tools = createStoreWriteTools(db);
    const outsider = await newRun(q.cycle, 'p-outsider', 'status');
    expect(await refusal(tools.execute({ id: 's', name: 'store_task_status', args: { task: 'l7', status: 'in_progress' } },
      { run_id: outsider, effect_key: KEY('5') }))).toBe('TASK_FORBIDDEN');
    expect(await refusal(tools.execute({ id: 'a', name: 'store_answer', args: { ask_seq: q.askSeq, answer: 'je réponds à sa place' } },
      { run_id: outsider, effect_key: KEY('6') }))).toBe('CLARIFY_ANSWER_FORBIDDEN');
    const responder = await newRun(q.cycle, 'p-resp', 'answer');
    await db.prepare("UPDATE cycles SET status = 'closed' WHERE cycle_id = ?1").bind(q.cycle).run();
    expect(await refusal(tools.execute({ id: 'a', name: 'store_answer', args: { ask_seq: q.askSeq, answer: 'trop tard' } },
      { run_id: responder, effect_key: KEY('7') }))).toBe('CYCLE_CLOSED');
    expect(await eventsOf(q.cycle, 'clarify.answer')).toHaveLength(0);
    expect(await eventsOf(q.cycle, 'task.status')).toHaveLength(0);
  });

  it('moteur : evidence.add interdit au canal API, verdict D12 refusé, outil hors type refusé — aucun effet', async () => {
    const q = await seedQuestion('engine-refusals', 'p-resp');
    const runId = await newRun(q.cycle, 'p-resp', 'planning');
    const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    const model = scripted([{ text: '', tool_calls: [
      { id: 'e', name: 'evidence.add', args: { kind: 'note' } },
      { id: 'v', name: 'store_ask', args: { question: 'ok ?', verdict: 'PASS' } },
      { id: 't', name: 'store_task_status', args: { task: 'l7', status: 'in_progress' } },
      { id: 'q', name: 'store_ask', args: { question: 'Quel est le head testé ?', to: q.reviewer } },
    ] }]);
    expect((await runStep(db, runId, { model, tools: host, now: () => T, workerId: 'w1' })).outcome).toBe('stepped');
    const results = JSON.parse((await db.prepare('SELECT results FROM agent_run_steps WHERE run_id = ?1 AND n = 0').bind(runId).first<{ results: string }>())!.results) as Array<{ id: string; content: string }>;
    expect(results.map(r => r.content.match(/"error":"([^"]+)"/)?.[1] ?? 'ok')).toEqual([
      'tool_forbidden_on_api_channel', 'd12_verdict_forbidden_on_api_channel', 'tool_not_allowlisted', 'ok',
    ]);
    const asks = await eventsOf(q.cycle, 'clarify.ask');
    expect(asks.filter(a => a.participant_id === 'p-resp')).toHaveLength(1);
    expect(await eventsOf(q.cycle, 'evidence.add')).toHaveLength(0);
    expect(await eventsOf(q.cycle, 'task.status')).toHaveLength(0);
  });

  it('câblage : engineFor réel propose les écritures du type ; consigne commune explicite', () => {
    const ai = { async run() { return {}; } };
    const deps = engineFor({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: ai }, db)('r');
    expect(deps.tools.list('answer')).toEqual(['store_context', 'store_delta', 'store_answer']);
    expect(deps.tools.list('research')).toEqual(['store_context', 'store_delta']);
    expect(AGENT_RUN_SYSTEM).toContain('in_progress/blocked');
  });
});

describe('CC-5 l7c-2 — création depuis les décisions du contrôleur', () => {
  it('participants : vide par défaut, entrées invalides ignorées, doublons retirés', () => {
    expect(apiParticipants(undefined)).toEqual([]);
    expect(apiParticipants('')).toEqual([]);
    expect(apiParticipants(' gpt6, vibe ,gpt6,a.b,,agent:x ')).toEqual(['gpt6', 'vibe', 'agent:x']);
  });

  it('éteint par défaut : sans AGENT_RUN_PARTICIPANTS, aucune exécution même avec une question ouverte', async () => {
    const q = await seedQuestion('plan-off', 'p-plan-off');
    expect(await planAgentRuns(db, {}, { now: T })).toEqual({ considered: 0, created: 0 });
    const runs = await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(q.cycle).first<{ c: number }>();
    expect(runs!.c).toBe(0);
    const pass = await agentRunPass(db, { AGENT_RUN_PARTICIPANTS: 'p-plan-off' }, { now: T, deliverer: 'd', wake: async () => ({ accepted: true }) });
    expect(pass.skipped).toBe('disabled');
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(q.cycle).first<{ c: number }>())!.c).toBe(0);
  });

  it('question adressée → une exécution « answer » au run_id déterministe ; passage rejoué = aucune seconde', async () => {
    const q = await seedQuestion('plan-on', 'p-plan-on');
    const first = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: 'p-plan-on' }, { now: T });
    expect(first.created).toBe(1);
    const runId = await answerRunId(q.cycle, 'p-plan-on', q.askSeq);
    const run = (await db.prepare('SELECT participant_id, task_id, task_kind, status, max_cost_cents, prompt FROM agent_runs WHERE run_id = ?1').bind(runId)
      .first<{ participant_id: string; task_id: string; task_kind: string; status: string; max_cost_cents: number; prompt: string }>())!;
    expect(run).toMatchObject({ participant_id: 'p-plan-on', task_id: '', task_kind: 'answer', status: 'running', max_cost_cents: 0 });
    expect(run.prompt).toContain('ask_seq ' + q.askSeq);
    expect((await db.prepare('SELECT status FROM agent_run_wakeups WHERE run_id = ?1').bind(runId).first<{ status: string }>())!.status).toBe('pending');
    const again = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: 'p-plan-on' }, { now: T + 5 });
    expect(again.created).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(q.cycle).first<{ c: number }>())!.c).toBe(1);
  });

  it('réveil de tâche : l’auteur volontaire obtient une exécution implement, le relecteur sans soumission rien (L5a)', async () => {
    const q = await seedQuestion('plan-task', 'p-plan-elsewhere');
    const view = await previewNextActions(db, q.cycle, q.owner);
    expect(view.mine.map(d => d.action)).toContain('implement');
    const out = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: q.owner + ',' + q.reviewer }, { now: T });
    expect(out.created).toBe(1);
    const runId = await taskRunId('implement', q.cycle, q.owner, 'l7', 'none');
    const run = (await db.prepare('SELECT participant_id, task_id, task_kind, status FROM agent_runs WHERE run_id = ?1').bind(runId)
      .first<{ participant_id: string; task_id: string; task_kind: string; status: string }>())!;
    expect(run).toMatchObject({ participant_id: q.owner, task_id: 'l7', task_kind: 'implement', status: 'running' });
    // Le relecteur sans soumission n’a aucune décision, et un rejeu ne crée jamais la seconde exécution.
    const again = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: q.owner + ',' + q.reviewer }, { now: T + 5 });
    expect(again.created).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(q.cycle).first<{ c: number }>())!.c).toBe(1);
  });

  it('passage activé : la création précède la livraison, le réveil part dans le même passage', async () => {
    const q = await seedQuestion('plan-pass', 'p-plan-pass');
    const woken: string[] = [];
    const pass = await agentRunPass(db, { AGENT_RUNS_ENABLED: 'true', AGENT_RUN_PARTICIPANTS: 'p-plan-pass' },
      { now: T, deliverer: 'd-' + n, wake: async (_lease, runId) => { woken.push(runId); return { accepted: true }; } });
    expect(pass.planned).toBe(1);
    expect(woken).toContain(await answerRunId(q.cycle, 'p-plan-pass', q.askSeq));
  });
});

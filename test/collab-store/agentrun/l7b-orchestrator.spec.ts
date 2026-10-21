import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import wranglerConfig from '../../../wrangler.jsonc?raw';
import {
  createRun, runStep, preemptByChat, runSummary, leaseKeyOf, type ModelOutput, type ToolHost, type AgentMessage,
} from '../../../src/collab-store/agentrun';
import {
  objectWake, objectAlarm, deliverWakeups, rescueStalledRuns, agentRunPass, consumeQuota,
  BUSY_BACKOFF_MAX_S, QUOTA_RETRY_S, ALARM_GRACE_S, WAKEUP_CLAIM_S, MAX_WAKEUP_ATTEMPTS, ROWS_PER_STEP,
  type ObjectSlot, type OrchestratorDeps, type WakeResult,
} from '../../../src/collab-store/agentrun/orchestrator';
import { wakeViaNamespace, type AgentRunObject } from '../../../src/collab-store/agentrun/object';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-5 l7 incrément 7b — orchestrateur (plan v1.1, store seq 478).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const namespace = (env as unknown as { AGENT_RUN: DurableObjectNamespace<AgentRunObject> }).AGENT_RUN;
let n = 0;

function fakeSlot() {
  const values = new Map<string, unknown>();
  const box = { alarm: null as number | null, sets: 0 };
  const slot: ObjectSlot = {
    get: (async (key: string) => values.get(key)) as ObjectSlot['get'],
    put: (async (key: string, value: unknown) => { values.set(key, value); }) as ObjectSlot['put'],
    delete: async key => values.delete(key),
    getAlarm: async () => box.alarm,
    setAlarm: async at => { box.alarm = at; box.sets += 1; },
    deleteAlarm: async () => { box.alarm = null; },
  };
  return { slot, values, box };
}

function scripted(outputs: ModelOutput[]) {
  const state = { calls: 0 };
  return {
    state,
    async complete(input: { messages: AgentMessage[] }) {
      state.calls += 1;
      const step = input.messages.filter(message => message.role === 'assistant').length;
      return { output: outputs[step] ?? { text: 'fin', tool_calls: [] }, usage: { tokens: 10, cost_cents: 0 } };
    },
  };
}

const READS: ModelOutput[] = [
  { text: 'je lis', tool_calls: [{ id: 'a', name: 'read_file', args: { path: 'a.ts' } }] },
  { text: 'je relis', tool_calls: [{ id: 'b', name: 'read_file', args: { path: 'b.ts' } }] },
  { text: 'terminé', tool_calls: [] },
];

const READ_HOST: ToolHost = {
  spec: (_kind, name) => (name === 'read_file' ? { name, effect: 'read' } : null),
  list: () => ['read_file'],
  execute: async call => 'contenu ' + String(call.args.path),
};

interface Clock { ms: number }

function deps(slot: ObjectSlot, clock: Clock, options: { enabled?: boolean; owns?: boolean; model?: ReturnType<typeof scripted>; limits?: { requests?: string; rows?: string } } = {}): OrchestratorDeps {
  const model = options.model ?? scripted(READS);
  return {
    db,
    env: { AGENT_RUNS_ENABLED: options.enabled === false ? 'false' : 'true', AGENT_RUN_DAILY_REQUESTS: options.limits?.requests, AGENT_RUN_DAILY_ROWS: options.limits?.rows },
    slot,
    ownsLease: () => options.owns ?? true,
    nowMs: () => clock.ms,
    engine: () => ({ model, tools: READ_HOST, now: () => Math.floor(clock.ms / 1000) }),
    workerId: () => 'w-' + crypto.randomUUID(),
  };
}

async function newRun(at: number, task = 'fix') {
  await ensureSchema(db);
  const id = ++n;
  const input = {
    runId: 'l7b-run-' + id + '-' + Date.now().toString(36), cycleId: 'l7b-cycle-' + id, participantId: 'vibe', taskId: task,
    taskKind: 'fix', prompt: 'Corrige.', maxSteps: 20, maxTokens: 100_000, maxCostCents: 0, deadlineAt: at + 86_400, now: at,
  };
  const created = await createRun(db, input);
  expect(created.created).toBe(true);
  return { ...input, leaseKey: leaseKeyOf(input.cycleId, input.participantId, input.taskId) };
}

/** Alarme qui se déclenche : le runtime la consomme avant d'appeler le gestionnaire. */
async function fire(d: OrchestratorDeps, box: { alarm: number | null }) {
  box.alarm = null;
  return objectAlarm(d);
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await db.prepare(sql).bind(...binds).first<{ c: number }>())!.c;
}

async function setHalt(value: '0' | '1') {
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, NULL, 0) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(value).run();
}

const T = 1_950_000_000;

describe('CC-5 l7b — configuration', () => {
  it('binding et migration dans l’env cc3-test seulement, interrupteur éteint, rien au niveau racine', () => {
    const config = JSON.parse(wranglerConfig) as Record<string, unknown> & { env: Record<string, Record<string, unknown>> };
    expect(config.durable_objects).toBeUndefined();
    expect(config.migrations).toBeUndefined();
    const cc3 = config.env['cc3-test'] as { durable_objects: { bindings: unknown[] }; migrations: unknown[]; vars: Record<string, string> };
    expect(cc3.durable_objects.bindings).toEqual([{ name: 'AGENT_RUN', class_name: 'AgentRunObject' }]);
    expect(cc3.migrations).toEqual([{ tag: 'cc5-l7b-agent-run', new_sqlite_classes: ['AgentRunObject'] }]);
    expect(cc3.vars.AGENT_RUNS_ENABLED).toBe('false');
    for (const [name, value] of Object.entries(config.env)) {
      if (name === 'cc3-test') continue;
      expect(value.durable_objects).toBeUndefined();
      expect(value.migrations).toBeUndefined();
    }
  });
});

describe('CC-5 l7b — réveil et alarmes', () => {
  it('désactivé : wake refusé sans aucune écriture ni alarme ; passage sans effet', async () => {
    const run = await newRun(T);
    const { slot, values, box } = fakeSlot();
    const before = await count('SELECT COUNT(*) AS c FROM agent_run_quota');
    expect(await objectWake(deps(slot, { ms: T * 1000 }, { enabled: false }), run.runId, run.leaseKey)).toEqual({ accepted: false, reason: 'disabled' });
    expect(await objectAlarm(deps(slot, { ms: T * 1000 }, { enabled: false }))).toEqual({ action: 'none' });
    expect(values.size).toBe(0);
    expect(box.alarm).toBeNull();
    expect(await count('SELECT COUNT(*) AS c FROM agent_run_quota')).toBe(before);
    const pass = await agentRunPass(db, { AGENT_RUNS_ENABLED: 'false' }, { now: T, deliverer: 'd', wake: async () => ({ accepted: true }) });
    expect(pass).toEqual({ delivered: 0, failed: 0, rescued: 0, skipped: 'disabled' });
    expect((await db.prepare('SELECT status FROM agent_run_wakeups WHERE run_id = ?1').bind(run.runId).first<{ status: string }>())!.status).toBe('pending');
  });

  it('double wake = une seule alarme ; mauvais objet ou exécution inconnue refusés', async () => {
    const run = await newRun(T);
    const { slot, box } = fakeSlot();
    const clock = { ms: T * 1000 };
    expect(await objectWake(deps(slot, clock), run.runId, run.leaseKey)).toEqual({ accepted: true });
    clock.ms += 500;
    expect(await objectWake(deps(slot, clock), run.runId, run.leaseKey)).toEqual({ accepted: true });
    expect(box.sets).toBe(1);
    expect(box.alarm).toBe(T * 1000);
    expect(await objectWake(deps(slot, clock, { owns: false }), run.runId, run.leaseKey)).toEqual({ accepted: false, reason: 'wrong_object' });
    expect(await objectWake(deps(slot, clock), 'inconnue', run.leaseKey)).toEqual({ accepted: false, reason: 'unknown_run' });
  });

  it('alarmes jusqu’au terme : une étape par alarme, une alarme future après chaque issue non terminale', async () => {
    const run = await newRun(T);
    const { slot, box } = fakeSlot();
    const clock = { ms: T * 1000 };
    const model = scripted(READS);
    const d = deps(slot, clock, { model });
    await objectWake(d, run.runId, run.leaseKey);
    const actions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      clock.ms += 1000;
      const result = await fire(d, box);
      actions.push(result.action);
      if (result.action === 'finished') break;
      expect(box.alarm).not.toBeNull();
      expect((await db.prepare('SELECT next_alarm_at FROM agent_run_alarms WHERE run_id = ?1').bind(run.runId).first<{ next_alarm_at: number | null }>())!.next_alarm_at).not.toBeNull();
    }
    expect(actions).toEqual(['stepped', 'stepped', 'finished']);
    expect(model.state.calls).toBe(3);
    expect(box.alarm).toBeNull();
    expect((await runSummary(db, run.runId))!.status).toBe('completed');
    expect((await db.prepare('SELECT next_alarm_at FROM agent_run_alarms WHERE run_id = ?1').bind(run.runId).first<{ next_alarm_at: number | null }>())!.next_alarm_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = ?1 AND kind = 'run_finished'", run.runId)).toBe(1);
  });

  it('étape tenue ailleurs (busy) : recul croissant et borné, alarme jamais reculée au-delà d’une plus proche', async () => {
    const run = await newRun(T);
    // Une autre réclamation fraîche, renouvelée à chaque alarme : l'étape reste busy.
    const { slot, box } = fakeSlot();
    const clock = { ms: T * 1000 };
    const d = deps(slot, clock);
    await objectWake(d, run.runId, run.leaseKey);
    const delays: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      await db.prepare([
        'INSERT INTO agent_run_steps (run_id, n, state, claimed_by, claimed_at, attempts) VALUES (?1, 0, \'claimed\', \'autre\', ?2, 1)',
        'ON CONFLICT(run_id, n) DO UPDATE SET claimed_at = excluded.claimed_at',
      ].join(' ')).bind(run.runId, Math.floor(clock.ms / 1000)).run();
      const result = await fire(d, box);
      expect(result.action).toBe('rescheduled');
      expect(box.alarm).toBe(result.next_at);
      delays.push((result.next_at! - clock.ms) / 1000);
      clock.ms = result.next_at!;
    }
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 40]);
    expect(Math.max(...delays)).toBe(BUSY_BACKOFF_MAX_S);
    // Une alarme plus proche déjà posée n'est jamais reculée.
    box.alarm = clock.ms + 1000;
    await db.prepare("UPDATE agent_run_steps SET claimed_at = ?2 WHERE run_id = ?1 AND n = 0").bind(run.runId, Math.floor(clock.ms / 1000)).run();
    await objectAlarm(d);
    expect(box.alarm).toBe(clock.ms + 1000);
  });

  it('HALT ou préemption : aucune étape, objet libéré, aucune alarme', async () => {
    const halted = await newRun(T);
    const s1 = fakeSlot();
    const c1 = { ms: T * 1000 };
    const model = scripted(READS);
    await objectWake(deps(s1.slot, c1, { model }), halted.runId, halted.leaseKey);
    await setHalt('1');
    try {
      expect(await fire(deps(s1.slot, c1, { model }), s1.box)).toMatchObject({ action: 'finished', outcome: 'halted' });
    } finally {
      await setHalt('0');
    }
    expect(model.state.calls).toBe(0);
    expect(s1.box.alarm).toBeNull();
    const pre = await newRun(T, 'fix-pre');
    const s2 = fakeSlot();
    await objectWake(deps(s2.slot, c1, { model }), pre.runId, pre.leaseKey);
    await preemptByChat(db, { cycleId: pre.cycleId, participantId: 'vibe', taskId: 'fix-pre', now: T, holdSeconds: 600 });
    expect(await fire(deps(s2.slot, c1, { model }), s2.box)).toMatchObject({ action: 'finished', outcome: 'preempted' });
    expect(model.state.calls).toBe(0);
  });

  it('copie locale périmée (bail d’un autre objet) : oubliée sans étape', async () => {
    const run = await newRun(T);
    const { slot, values, box } = fakeSlot();
    values.set('run_id', run.runId);
    const model = scripted(READS);
    expect(await fire(deps(slot, { ms: T * 1000 }, { owns: false, model }), box)).toEqual({ action: 'none' });
    expect(values.has('run_id')).toBe(false);
    expect(model.state.calls).toBe(0);
  });

  it('quotas Free : réveil refusé au-delà du plafond des requêtes, étape différée sans quota de lignes', async () => {
    const run = await newRun(T + 3 * 86_400);
    const day = { ms: (T + 3 * 86_400) * 1000 };
    const s = fakeSlot();
    expect(await objectWake(deps(s.slot, day, { limits: { requests: '1' } }), run.runId, run.leaseKey)).toEqual({ accepted: true });
    expect(await objectWake(deps(s.slot, day, { limits: { requests: '1' } }), run.runId, run.leaseKey)).toEqual({ accepted: false, reason: 'quota_exhausted' });
    const model = scripted(READS);
    const result = await fire(deps(s.slot, day, { model, limits: { rows: String(ROWS_PER_STEP - 1) } }), s.box);
    expect(result).toEqual({ action: 'quota_wait', next_at: day.ms + QUOTA_RETRY_S * 1000 });
    expect(model.state.calls).toBe(0);
    expect(s.box.alarm).toBe(day.ms + QUOTA_RETRY_S * 1000);
    expect(await count("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = ?1 AND kind = 'quota_exhausted'", run.runId)).toBe(2);
    expect(await consumeQuota(db, 'rows_written', 200_000, 100_000, T)).toBe(false);
  });
});

describe('CC-5 l7b — outbox et scan de secours', () => {
  it('outbox écrite par createRun, livrée une fois, ACK après wake accepté', async () => {
    const run = await newRun(T + 100);
    const calls: string[] = [];
    const wake = async (_lease: string, runId: string): Promise<WakeResult> => { calls.push(runId); return { accepted: true }; };
    const first = await deliverWakeups(db, { now: T + 100, deliverer: 'd1', wake, limit: 50 });
    expect(first.delivered).toBeGreaterThanOrEqual(1);
    expect(calls).toContain(run.runId);
    const row = await db.prepare('SELECT status, attempts FROM agent_run_wakeups WHERE run_id = ?1').bind(run.runId).first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: 'delivered', attempts: 1 });
    calls.length = 0;
    await deliverWakeups(db, { now: T + 200, deliverer: 'd2', wake, limit: 50 });
    expect(calls).not.toContain(run.runId);
  });

  it('livreur coupé après la réclamation et avant l’ACK : relivré après expiration, par un autre livreur', async () => {
    const run = await newRun(T + 1000);
    // Livreur mort : réclamation posée, jamais suivie d'un ACK.
    await db.prepare("UPDATE agent_run_wakeups SET claimed_by = 'mort', claimed_until = ?2, attempts = attempts + 1 WHERE run_id = ?1")
      .bind(run.runId, T + 1000 + WAKEUP_CLAIM_S).run();
    const calls: string[] = [];
    const wake = async (_lease: string, runId: string): Promise<WakeResult> => { calls.push(runId); return { accepted: true }; };
    await deliverWakeups(db, { now: T + 1010, deliverer: 'd', wake, limit: 50 });
    expect(calls).not.toContain(run.runId);
    await deliverWakeups(db, { now: T + 1000 + WAKEUP_CLAIM_S, deliverer: 'd', wake, limit: 50 });
    expect(calls).toContain(run.runId);
    expect(await db.prepare('SELECT status, attempts, claimed_by FROM agent_run_wakeups WHERE run_id = ?1').bind(run.runId).first())
      .toEqual({ status: 'delivered', attempts: 2, claimed_by: 'd' });
  });

  it('livreurs concurrents : un seul wake par réveil', async () => {
    const run = await newRun(T + 2000);
    const calls: string[] = [];
    const wake = async (_lease: string, runId: string): Promise<WakeResult> => { calls.push(runId); return { accepted: true }; };
    await Promise.all([
      deliverWakeups(db, { now: T + 2000, deliverer: 'a', wake, limit: 50 }),
      deliverWakeups(db, { now: T + 2000, deliverer: 'b', wake, limit: 50 }),
    ]);
    expect(calls.filter(id => id === run.runId)).toHaveLength(1);
  });

  it('wake toujours refusé : tentatives bornées puis échec terminal journalisé', async () => {
    const run = await newRun(T + 3000);
    const wake = async (): Promise<WakeResult> => ({ accepted: false, reason: 'quota_exhausted' });
    for (let i = 0; i <= MAX_WAKEUP_ATTEMPTS; i += 1) await deliverWakeups(db, { now: T + 3000 + i, deliverer: 'd', wake, limit: 50 });
    expect(await db.prepare('SELECT status, attempts, last_error FROM agent_run_wakeups WHERE run_id = ?1').bind(run.runId).first())
      .toEqual({ status: 'failed', attempts: MAX_WAKEUP_ATTEMPTS, last_error: 'delivery_attempts_exhausted' });
    expect(await count("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = ?1 AND kind = 'wakeup_failed'", run.runId)).toBe(1);
  });

  it('alarme perdue : rattrapée par le scan seulement après le délai de grâce, malgré un updated_at rafraîchi', async () => {
    const run = await newRun(T + 4000);
    const { slot, box } = fakeSlot();
    const clock = { ms: (T + 4000) * 1000 };
    await objectWake(deps(slot, clock), run.runId, run.leaseKey);
    await db.prepare("UPDATE agent_run_wakeups SET status = 'delivered' WHERE run_id = ?1").bind(run.runId).run();
    box.alarm = null; // alarme perdue
    // Écriture d'audit qui rafraîchit updated_at : ne doit pas masquer l'exécution morte.
    await db.prepare('UPDATE agent_runs SET updated_at = ?2 WHERE run_id = ?1').bind(run.runId, T + 4000 + 10_000).run();
    const woken: string[] = [];
    const wake = async (_lease: string, runId: string): Promise<WakeResult> => { woken.push(runId); return { accepted: true }; };
    await rescueStalledRuns(db, { now: T + 4000 + ALARM_GRACE_S - 1, wake, limit: 50 });
    expect(woken).not.toContain(run.runId);
    await rescueStalledRuns(db, { now: T + 4000 + ALARM_GRACE_S + 1, wake, limit: 50 });
    expect(woken).toContain(run.runId);
    expect(await count("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = ?1 AND kind = 'rescued'", run.runId)).toBe(1);
  });
});

/** Les alarmes réelles peuvent se déclencher seules (échéance immédiate) : on les force et on attend l'état terminal. */
async function settleObject(stub: DurableObjectStub<AgentRunObject>, runId: string): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    await runDurableObjectAlarm(stub);
    const status = (await runSummary(db, runId))!.status;
    if (status !== 'running') return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return (await runSummary(db, runId))!.status;
}

describe('CC-5 l7b — Durable Object réel', () => {
  it('wake par RPC puis alarmes jusqu’au terme (modèle simulé par défaut) ; mauvais objet refusé', async () => {
    const run = await newRun(Math.floor(Date.now() / 1000));
    const stub = namespace.get(namespace.idFromName(run.leaseKey));
    expect(await wakeViaNamespace(namespace)(run.leaseKey, run.runId)).toEqual({ accepted: true });
    const other = namespace.get(namespace.idFromName(run.leaseKey + '-autre'));
    expect(await other.wake(run.runId, run.leaseKey)).toEqual({ accepted: false, reason: 'wrong_object' });
    expect(await settleObject(stub, run.runId)).toBe('completed');
    expect((await runSummary(db, run.runId))).toMatchObject({ status: 'completed', summary: 'Exécution simulée (7b) : aucun fournisseur branché.' });
  });

  it('objet sans état local (évincé, jamais réveillé) : le passage le relance depuis D1', async () => {
    const run = await newRun(Math.floor(Date.now() / 1000), 'fix-evict');
    const stub = namespace.get(namespace.idFromName(run.leaseKey));
    // Aucun état local ni alarme dans l'objet ; le réveil initial est considéré livré (perdu en route).
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('run_id')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await db.prepare("UPDATE agent_run_wakeups SET status = 'delivered' WHERE run_id = ?1").bind(run.runId).run();
    const later = Math.floor(Date.now() / 1000) + ALARM_GRACE_S + 5;
    const pass = await agentRunPass(db, { AGENT_RUNS_ENABLED: 'true' }, { now: later, deliverer: 'pass', wake: wakeViaNamespace(namespace) });
    expect(pass.rescued).toBeGreaterThanOrEqual(1);
    expect(await settleObject(stub, run.runId)).toBe('completed');
  });
});

describe('CC-5 l7b — réserve 7a : résolution tardive d’un outil', () => {
  it('un outil qui répond après la borne : trace ambiguë, résultat jamais enregistré, jamais relancé', async () => {
    const run = await newRun(T + 5000);
    let calls = 0;
    let release: (value: unknown) => void = () => undefined;
    const tools: ToolHost = {
      spec: (_kind, name) => (name === 'commit' ? { name, effect: 'write' } : null),
      list: () => ['commit'],
      execute: () => { calls += 1; return new Promise(resolve => { release = resolve; }); },
    };
    const model = scripted([{ text: 'commit', tool_calls: [{ id: 'c', name: 'commit', args: { message: 'x', expectedHeadSha: 'h' } }] }]);
    const engine = { model, tools, now: () => T + 5001, workerId: 'w', effectTimeoutMs: 10 };
    expect((await runStep(db, run.runId, engine)).outcome).toBe('needs_reconcile');
    release({ sha: 'tardif' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await runSummary(db, run.runId))!.effects).toEqual([{ tool: 'commit', status: 'ambiguous' }]);
    expect((await runStep(db, run.runId, engine)).outcome).toBe('needs_reconcile');
    expect(calls).toBe(1);
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, leaseKeyOf, type ModelOutput, type ToolHost } from '../../../src/collab-store/agentrun';
import {
  objectWake, objectAlarm, nextStepIntervalS, IMPLEMENT_MIN_INTERVAL_S,
  IMPLEMENT_CI_PENDING_MIN_S, IMPLEMENT_CI_PENDING_MAX_S,
  type ObjectSlot, type OrchestratorDeps,
} from '../../../src/collab-store/agentrun/orchestrator';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_950_000_000;

function slotFixture() {
  const values = new Map<string, string | number>();
  const state = { alarm: null as number | null };
  const slot: ObjectSlot = {
    get: async key => values.get(key) as never,
    put: async (key, value) => { values.set(key, value); },
    delete: async key => values.delete(key),
    getAlarm: async () => state.alarm,
    setAlarm: async at => { state.alarm = at; },
    deleteAlarm: async () => { state.alarm = null; },
  };
  return { slot, state };
}

describe('CC8 S7 — cadence des appels gratuits et attente CI', () => {
  it('borne le délai selon le kind et la dernière lecture CI persistée', () => {
    expect(nextStepIntervalS('review', '{"next_action":"wait","next_poll_seconds":15}')).toBe(0);
    expect(nextStepIntervalS('implement', null)).toBe(IMPLEMENT_MIN_INTERVAL_S);
    expect(nextStepIntervalS('implement', 'invalide')).toBe(IMPLEMENT_MIN_INTERVAL_S);
    expect(nextStepIntervalS('implement', '{"next_action":"wait","next_poll_seconds":15}'))
      .toBe(IMPLEMENT_CI_PENDING_MIN_S);
    expect(nextStepIntervalS('implement', '{"next_action":"wait","next_poll_seconds":999}'))
      .toBe(IMPLEMENT_CI_PENDING_MAX_S);
    expect(nextStepIntervalS('implement', '{"next_action":"request_D12","next_poll_seconds":null}'))
      .toBe(IMPLEMENT_MIN_INTERVAL_S);
  });

  it('attend 60 s sur CI pending même après double réveil; HALT reste prioritaire', async () => {
    await ensureSchema(db);
    const runId = 'cc8-s7-cadence-' + crypto.randomUUID();
    const cycleId = 'cc8-s7-cadence-' + crypto.randomUUID();
    const taskId = 'pilot-fixture';
    const leaseKey = leaseKeyOf(cycleId, 'vibe', taskId);
    const run = await createRun(db, {
      runId, cycleId, participantId: 'vibe', taskId, taskKind: 'implement',
      prompt: 'Vérifie la CI sans relancer d’écriture.', maxSteps: 12, maxTokens: 48_000,
      maxCostCents: 0, deadlineAt: T + 900, now: T,
    });
    expect(run.created).toBe(true);
    const clock = { ms: T * 1000 };
    const { slot, state } = slotFixture();
    let modelCalls = 0;
    const output: ModelOutput = { text: 'Contrôle en cours', tool_calls: [
      { id: 'ci-1', name: 'github_check_result', args: { name: 'pilot', sha: 'a'.repeat(40), run_id: 17 } },
    ] };
    const tools: ToolHost = {
      list: () => ['github_check_result'],
      spec: (_kind, name) => name === 'github_check_result' ? { name, effect: 'write' } : null,
      execute: async () => ({ status: 'in_progress', verifiedSuccess: false, next_action: 'wait', next_poll_seconds: 15 }),
    };
    const d: OrchestratorDeps = {
      db, env: { AGENT_RUNS_ENABLED: 'true' }, slot, ownsLease: () => true,
      nowMs: () => clock.ms,
      engine: () => ({
        model: { complete: async () => {
          modelCalls++;
          return { output, usage: { tokens: 32, cost_cents: 0 } };
        } },
        tools, now: () => Math.floor(clock.ms / 1000),
      }),
      workerId: () => 'cc8-s7-cadence-worker',
    };
    expect(await objectWake(d, runId, leaseKey)).toEqual({ accepted: true });
    state.alarm = null; // Cloudflare consomme l'alarme avant de déclencher alarm()
    const step = await objectAlarm(d);
    expect(step).toMatchObject({ action: 'stepped', next_at: T * 1000 + 60_000 });
    expect(state.alarm).toBe(T * 1000 + 60_000);
    expect(modelCalls).toBe(1);
    const nextAt = await db.prepare('SELECT next_alarm_at FROM agent_run_alarms WHERE run_id = ?1')
      .bind(runId).first<{ next_alarm_at: number }>();
    expect(nextAt?.next_alarm_at).toBe(T + 60);
    clock.ms += 1000;
    expect(await objectWake(d, runId, leaseKey)).toEqual({ accepted: true });
    expect(state.alarm).toBe(T * 1000 + 60_000);
    expect(modelCalls).toBe(1);
    // Une alarme prématurée n'appelle ni le modèle ni le fournisseur CI.
    expect(await objectAlarm(d)).toMatchObject({ action: 'rescheduled', outcome: 'early_alarm' });
    expect(modelCalls).toBe(1);
    await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', '1', NULL, ?1) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .bind(T + 1).run();
    try {
      clock.ms = T * 1000 + 60_000;
      state.alarm = null;
      expect(await objectAlarm(d)).toMatchObject({ action: 'finished', outcome: 'halted' });
      expect(modelCalls).toBe(1);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
  });
});

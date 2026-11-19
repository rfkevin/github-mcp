import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { recordRunModelCall } from '../../../src/collab-store/agentrun/provider-models';
import { redactedRunSummary } from '../../../src/collab-store/agentrun/chat-continuity';
import { nominalUsd, snapshotCallPrice } from '../../../src/collab-store/agentrun/call-costs';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 generic token input/output and per-call pricing', () => {
  it('distinguishes free tier, paid standard pricing and missing billing data', () => {
    expect(snapshotCallPrice('gemini:gemini-3.8-flash', 0)).toMatchObject({
      basis: 'free', accounted_cost_cents: 0, input_rate_cents_per_m: 0, output_rate_cents_per_m: 0 });
    expect(snapshotCallPrice('gemini:gemini-3.8-flash', null)).toMatchObject({
      basis: 'unknown', accounted_cost_cents: null, input_rate_cents_per_m: null });
    expect(snapshotCallPrice('zai:glm-5.3-flash', 1)).toMatchObject({
      basis: 'api_rate', input_rate_cents_per_m: 15, output_rate_cents_per_m: 50, accounted_cost_cents: 1 });
    expect(nominalUsd(null, 15)).toBeNull();
    expect(nominalUsd(2400, 15)).toBe(0.00036);
  });

  it('records three immutable per-call snapshots and displays only safe figures', async () => {
    await ensureSchema(db);
    await ensureAgentRunSchema(db);
    const runId = 'call-cost-' + crypto.randomUUID();
    expect((await createRun(db, { runId, cycleId: runId, participantId: 'vibe',
      taskId: 't', taskKind: 'review', prompt: 'PRIVATE_NEVER_RETURN', maxSteps: 6,
      maxTokens: 48_000, maxCostCents: 2, deadlineAt: 2_000_001_000, now: 2_000_000_000 })).created).toBe(true);
    const base = { run_id: runId, n: 0, chosen_ref: 'zai:glm-5.3-flash', latency_ms: 21, at: 2_000_000_000 };
    await recordRunModelCall(db, { ...base, ref: 'zai:glm-5.3-flash', ok: true, failure: '',
      input_tokens: 2400, output_tokens: 800, cost_cents: 1 });
    await recordRunModelCall(db, { ...base, ref: 'gemini:gemini-3.8-flash', ok: true, failure: '',
      input_tokens: 900, output_tokens: 100, cost_cents: 0 });
    await recordRunModelCall(db, { ...base, ref: 'unpriced:model', ok: false, failure: 'transient' });
    const summary = await redactedRunSummary(db, runId);
    expect(summary?.model_calls).toMatchObject([
      { k: 0, input_tokens: 2400, output_tokens: 800, price_basis: 'api_rate',
        accounted_cost_cents: 1, input_rate_cents_per_m: 15, output_rate_cents_per_m: 50,
        nominal_input_usd: 0.00036, nominal_output_usd: 0.0004 },
      { k: 1, input_tokens: 900, output_tokens: 100, price_basis: 'free',
        accounted_cost_cents: 0, nominal_input_usd: 0, nominal_output_usd: 0 },
      { k: 2, input_tokens: null, output_tokens: null, price_basis: 'unknown',
        accounted_cost_cents: null, nominal_input_usd: null, nominal_output_usd: null },
    ]);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_NEVER_RETURN');
    const saved = await db.prepare('SELECT COUNT(*) AS n FROM agent_run_call_costs WHERE run_id=?1')
      .bind(runId).first<{ n: number }>();
    expect(saved?.n).toBe(3);
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { recordRunModelCall } from '../../../src/collab-store/agentrun/provider-models';
import { redactedRunSummary } from '../../../src/collab-store/agentrun/chat-continuity';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { nominalUsd, snapshotCallPrice } from '../../../src/collab-store/agentrun/call-costs';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
async function makeRun(prefix: string, maxCostCents = 0): Promise<string> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const runId = prefix + crypto.randomUUID();
  const created = await createRun(db, { runId, cycleId: runId, participantId: 'vibe',
    taskId: 't', taskKind: 'review', prompt: 'PRIVATE_NEVER_RETURN',
    maxSteps: 6, maxTokens: 48_000, maxCostCents, deadlineAt: 2_000_001_000, now: 2_000_000_000 });
  expect(created.created).toBe(true);
  return runId;
}
describe('CC8 U1 per-call token telemetry', () => {
  it('records split usage across fallback without revealing prompts', async () => {
    const runId = await makeRun('cc8-u1-usage-');
    const base = { run_id: runId, n: 0, chosen_ref: 'zai:glm-4.7-flash', latency_ms: 17, at: 2_000_000_000 };
    await recordRunModelCall(db, { ...base, ref: 'zai:glm-4.7-flash', ok: false, failure: 'transient' });
    await recordRunModelCall(db, { ...base, ref: 'workers-ai:@cf/zai-org/glm-4.7-flash',
      ok: true, failure: '', input_tokens: 1200, output_tokens: 90, estimated_input_tokens: 1350, cost_cents: 0 });
    await recordRunModelCall(db, { ...base, ref: 'zai:glm-5.3-flash', ok: true, failure: '',
      input_tokens: 2400, output_tokens: 800, cost_cents: 1 });
    const summary = await redactedRunSummary(db, runId);
    expect(summary?.model_calls).toMatchObject([
      { n: 0, k: 0, input_tokens: null, output_tokens: null, estimated_input_tokens: null,
        price_basis: 'unknown', accounted_cost_cents: null },
      { n: 0, k: 1, input_tokens: 1200, output_tokens: 90, estimated_input_tokens: 1350,
        price_basis: 'free', accounted_cost_cents: 0, nominal_input_usd: 0, nominal_output_usd: 0 },
      { n: 0, k: 2, input_tokens: 2400, output_tokens: 800, price_basis: 'api_rate',
        accounted_cost_cents: 1, input_rate_cents_per_m: 15, output_rate_cents_per_m: 50,
        nominal_input_usd: 0.00036, nominal_output_usd: 0.0004 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_NEVER_RETURN');
    const saved = await db.prepare('SELECT COUNT(*) AS n FROM agent_run_call_costs WHERE run_id=?1')
      .bind(runId).first<{ n: number }>();
    expect(saved?.n).toBe(3);
  });
  it('keeps free, paid and missing pricing facts distinct', () => {
    expect(snapshotCallPrice('gemini:gemini-3.8-flash', 0)).toMatchObject({
      basis: 'free', accounted_cost_cents: 0, input_rate_cents_per_m: 0, output_rate_cents_per_m: 0 });
    expect(snapshotCallPrice('gemini:gemini-3.8-flash', null)).toMatchObject({
      basis: 'unknown', accounted_cost_cents: null, input_rate_cents_per_m: null });
    expect(snapshotCallPrice('zai:glm-5.3-flash', 1)).toMatchObject({
      basis: 'api_rate', input_rate_cents_per_m: 15, output_rate_cents_per_m: 50, accounted_cost_cents: 1 });
    expect(nominalUsd(null, 15)).toBeNull();
    expect(nominalUsd(2400, 15)).toBe(0.00036);
  });


});

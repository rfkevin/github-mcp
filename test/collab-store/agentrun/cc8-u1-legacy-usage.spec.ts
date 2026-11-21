import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { redactedRunSummary } from '../../../src/collab-store/agentrun/chat-continuity';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { recordRunModelCall } from '../../../src/collab-store/agentrun/provider-models';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function makeRun(): Promise<string> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const runId = 'cc8-u1-legacy-' + crypto.randomUUID();
  const result = await createRun(db, {
    runId, cycleId: runId, participantId: 'gemini',
    taskId: 'telemetry-regression', taskKind: 'answer',
    prompt: 'PRIVATE_LEGACY_PROMPT_DO_NOT_DISCLOSE',
    maxSteps: 6, maxTokens: 100_000, maxCostCents: 0,
    deadlineAt: 2_000_001_000, now: 2_000_000_000,
  });
  expect(result.created).toBe(true);
  return runId;
}

describe('CC8 U1 legacy call usage compatibility', () => {
  it('keeps pre-telemetry model calls unknown, not falsely free or zero-token', async () => {
    const runId = await makeRun();
    // A historical model-call row has no matching agent_run_call_usage row.
    await db.prepare(
      'INSERT INTO agent_run_model_calls '
      + '(run_id,n,k,chosen_ref,ref,ok,failure,latency_ms,at) '
      + 'VALUES (?1,0,0,?2,?2,1,\'\',17,?3)',
    ).bind(runId, 'gemini:gemini-3.8-flash', 2_000_000_000).run();

    const summary = await redactedRunSummary(db, runId);
    expect(summary?.model_calls).toMatchObject([{
      n: 0, k: 0, ok: true, input_tokens: null, output_tokens: null,
      estimated_input_tokens: null, price_basis: 'unknown',
      accounted_cost_cents: null, input_rate_cents_per_m: null,
      output_rate_cents_per_m: null, nominal_input_usd: null,
      nominal_output_usd: null,
    }]);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_LEGACY_PROMPT_DO_NOT_DISCLOSE');
    const usage = await db.prepare(
      'SELECT COUNT(*) AS n FROM agent_run_call_usage WHERE run_id=?1',
    ).bind(runId).first<{ n: number }>();
    expect(usage?.n).toBe(0);
  });

  it('does not equate a run token total with one successful provider call after fallback', async () => {
    const runId = await makeRun();
    await db.prepare('UPDATE agent_runs SET tokens_used=?1 WHERE run_id=?2')
      .bind(48_036, runId).run();
    const base = {
      run_id: runId, n: 0, chosen_ref: 'gemini:gemini-3.8-flash',
      latency_ms: 17, at: 2_000_000_000,
    };
    await recordRunModelCall(db, {
      ...base, ref: 'gemini:gemini-3.8-flash', ok: false, failure: 'transient',
    });
    await recordRunModelCall(db, {
      ...base, ref: 'workers-ai:@cf/zai-org/glm-4.7-flash',
      ok: true, failure: '', input_tokens: 5_784, output_tokens: 134, cost_cents: 0,
    });

    const summary = await redactedRunSummary(db, runId);
    expect(summary?.tokens_used).toBe(48_036);
    expect(summary?.model_calls).toMatchObject([
      { n: 0, k: 0, ok: false, input_tokens: null, output_tokens: null,
        price_basis: 'unknown', accounted_cost_cents: null },
      { n: 0, k: 1, ok: true, input_tokens: 5_784, output_tokens: 134,
        price_basis: 'free', accounted_cost_cents: 0,
        nominal_input_usd: 0, nominal_output_usd: 0 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_LEGACY_PROMPT_DO_NOT_DISCLOSE');
  });
});

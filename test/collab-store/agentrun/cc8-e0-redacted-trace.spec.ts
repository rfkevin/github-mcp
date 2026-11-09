import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { redactedRunSummary, redactedRunSummaryFor } from '../../../src/collab-store/agentrun/chat-continuity';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 E0 — traces de pas sans données du modèle', () => {
  it('diagnostique une sortie sans outil et un résultat corrompu, sans fuite de texte ni arguments', async () => {
    await ensureSchema(db);
    const runId = 'cc8-e0-trace-' + crypto.randomUUID();
    const now = 2_000_000_000;
    const created = await createRun(db, {
      runId, cycleId: runId + '-cycle', participantId: 'trace-owner', taskId: 'task',
      taskKind: 'answer', prompt: 'NE_PAS_EXPOSER_PROMPT',
      maxSteps: 12, maxTokens: 32_000, maxCostCents: 0, deadlineAt: now + 900, now,
    });
    expect(created.created).toBe(true);

    const secret = 'NE_PAS_EXPOSER_SORTIE_MODELE';
    const output = JSON.stringify({
      text: secret, tool_calls: [{ id: 'x', name: 'pretendu_secret_' + secret, args: { token: secret } }],
    });
    await db.prepare([
      'INSERT INTO agent_run_steps (run_id,n,state,claimed_by,claimed_at,attempts,model_output,results,tokens,cost_cents)',
      'VALUES (?1,0,?2,?3,?4,1,?5,?6,10,0)',
    ].join(' ')).bind(runId, 'completed', 'worker', now, output,
      JSON.stringify([{ id: 'x', content: secret }])).run();
    await db.prepare([
      'INSERT INTO agent_run_steps (run_id,n,state,claimed_by,claimed_at,attempts,model_output,results,tokens,cost_cents)',
      'VALUES (?1,1,?2,?3,?4,1,?5,NULL,0,0)',
    ].join(' ')).bind(runId, 'claimed', 'worker', now, 'not-json').run();

    const summary = await redactedRunSummary(db, runId);
    expect(summary).toMatchObject({
      max_tokens: 32_000, max_cost_cents: 0,
      step_traces: [
        { n: 0, state: 'completed', model_output_recorded: true, tool_calls_requested: 1,
          tool_results_recorded: true, tokens: 10 },
        { n: 1, state: 'claimed', model_output_recorded: true, tool_calls_requested: null,
          tool_results_recorded: false },
      ],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('NE_PAS_EXPOSER_PROMPT');
    expect(serialized).not.toContain('pretendu_secret_');
    expect(await redactedRunSummaryFor(db, 'other-participant', runId)).toBeNull();
  });
});

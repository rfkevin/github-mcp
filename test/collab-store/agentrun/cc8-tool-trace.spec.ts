import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { redactedRunSummary, redactedRunSummaryFor } from '../../../src/collab-store/agentrun/chat-continuity';
import { redactedToolAttempts, typedToolFailure } from '../../../src/collab-store/agentrun/tool-trace';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

describe('CC8 — audit expurgé des vrais appels outils', () => {
  it('différencie reçu, refus, absence de reçu et effet D1 sans fuite de contenu', () => {
    const secret = 'PRIVATE_TOKEN_123__NEVER_EXPOSE';
    const calls = JSON.stringify({ text: secret, tool_calls: [
      { id: 'a', name: 'github_read_file', args: { path: secret, key: secret } },
      { id: 'b', name: 'store_answer', args: { answer: secret } },
      { id: 'c', name: 'tool_' + secret, args: { secret } },
      { id: 'd', name: 'store_memory', args: { page: 0 } },
    ] });
    const results = JSON.stringify([
      { id: 'a', content: secret },
      { id: 'b', content: JSON.stringify({ error: 'answer : texte de 1 à 4000 caractères requis.' }), error: true },
      { id: 'c', content: secret, error: true },
    ]);
    const attempts = redactedToolAttempts(calls, results, [
      { idx: 1, status: 'failed', result: JSON.stringify({ error: 'answer : texte de 1 à 4000 caractères requis.' }) },
    ]);
    expect(attempts).toEqual([
      { index: 0, tool: 'github_read_file', kind: 'read', status: 'receipt_ok', failure_code: null },
      { index: 1, tool: 'store_answer', kind: 'write', status: 'effect_failed', failure_code: 'answer_length_invalid' },
      { index: 2, tool: 'unknown_tool', kind: 'unknown', status: 'receipt_failed', failure_code: 'other' },
      { index: 3, tool: 'store_memory', kind: 'read', status: 'not_recorded', failure_code: null },
    ]);
    expect(JSON.stringify(attempts)).not.toContain(secret);
    expect(typedToolFailure(JSON.stringify({ error: 'LEAK_' + secret }))).toBe('other');
    expect(redactedToolAttempts('not-json', '[]')).toEqual([]);
  });

  it.each([
    'VERDICT_ARGS_INVALID', 'VERDICT_KIND_FORBIDDEN', 'VERDICT_ROLE_FORBIDDEN',
    'VERDICT_PR_UNKNOWN', 'VERDICT_COUPLE_MISMATCH', 'VERDICT_CI_NOT_GREEN',
    'VERDICT_READ_PROOF_MISSING', 'IDEMPOTENCY_CONFLICT',
  ])('rend le refus exact %s sans accepter un message libre', code => {
    const result = JSON.stringify({ error: code });
    expect(typedToolFailure(result)).toBe(code);
    const calls = JSON.stringify({ tool_calls: [
      { id: 'verdict', name: 'store_verdict', args: { review: 'PRIVATE_REVIEW' } },
    ] });
    const receipt = JSON.stringify([{ id: 'verdict', error: true, content: result }]);
    expect(redactedToolAttempts(calls, receipt)[0]).toMatchObject({
      status: 'receipt_failed', failure_code: code,
    });
    expect(redactedToolAttempts(calls, null, [{ idx: 0, status: 'failed', result }])[0])
      .toMatchObject({ status: 'effect_failed', failure_code: code });
    for (const error of [code + ': PRIVATE', 'PRIVATE ' + code, code + '\nPRIVATE']) {
      expect(typedToolFailure(JSON.stringify({ error }))).toBe('other');
    }
    expect(typedToolFailure(JSON.stringify({ error: 'VERDICT_UNKNOWN_PRIVATE' }))).toBe('other');
    expect(typedToolFailure(JSON.stringify({ error: { code } }))).toBe('other');
  });

  it('plafonne la liste mais conserve le compteur original', () => {
    const output = JSON.stringify({ tool_calls: Array.from({ length: 70 }, (_, i) =>
      ({ id: 'id-' + i, name: 'store_context', args: {} })) });
    expect(redactedToolAttempts(output, '[]')).toHaveLength(64);
  });

  it.each([
    ['store_answer', 'answer : texte de 1 à 4000 caractères requis.', 'answer_length_invalid'],
    ['store_verdict', 'VERDICT_ARGS_INVALID', 'VERDICT_ARGS_INVALID'],
    ['store_verdict', 'VERDICT_READ_PROOF_MISSING', 'VERDICT_READ_PROOF_MISSING'],
  ])('relit les effets D1 historiques %s/%s sans exposer le contenu privé', async (tool, error, code) => {
    await ensureSchema(db);
    const runId = 'cc8-proof-' + crypto.randomUUID();
    const now = 2_000_000_000;
    const created = await createRun(db, { runId, cycleId: 'cc8-proof-cycle-' + crypto.randomUUID(),
      participantId: 'gemini', taskId: 'task', taskKind: 'answer',
      prompt: 'PRIVATE_PROMPT_NEVER_EXPOSE', maxSteps: -1, maxTokens: -1,
      maxCostCents: 0, deadlineAt: now + 3600, now });
    expect(created.created).toBe(true);
    const output = JSON.stringify({ text: 'PRIVATE_OUTPUT_NEVER_EXPOSE', tool_calls: [
      { id: 'r1', name: 'github_diff', args: { token: 'PRIVATE_ARGS_NEVER_EXPOSE' } },
      { id: 'w1', name: tool, args: { answer: 'PRIVATE_ARGS_NEVER_EXPOSE' } },
    ] });
    await db.prepare([
      'INSERT INTO agent_run_steps (run_id,n,state,claimed_by,claimed_at,attempts,model_output,results,tokens,cost_cents)',
      'VALUES (?1,0,?2,?3,?4,1,?5,?6,500,0)',
    ].join(' ')).bind(runId, 'completed', 'worker', now, output, JSON.stringify([
      { id: 'r1', content: 'PRIVATE_GITHUB_RESULT_NEVER_EXPOSE' },
      { id: 'w1', content: JSON.stringify({ error }), error: true },
    ])).run();
    await db.prepare([
      'INSERT INTO agent_run_effects (effect_key,run_id,n,idx,tool,args,status,updated_at,result)',
      "VALUES (?1,?2,0,1,?6,?3,'failed',?4,?5)",
    ].join(' ')).bind('test-' + crypto.randomUUID(), runId, 'PRIVATE_ARGS_NEVER_EXPOSE', now,
      JSON.stringify({ error }), tool).run();
    const summary = await redactedRunSummary(db,runId);
    expect(summary?.step_traces[0]).toMatchObject({
      tool_calls_requested: 2, tool_results_recorded: true, tool_attempts_omitted: 0,
      tool_attempts: [
        { tool: 'github_diff', status: 'receipt_ok', kind: 'read' },
        { tool, status: 'effect_failed', failure_code: code },
      ],
    });
    expect(summary?.effects[0]).toMatchObject({ tool, status: 'failed', failure_code: code });
    const serial = JSON.stringify(summary);
    for(const s of ['PRIVATE_PROMPT_', 'PRIVATE_OUTPUT_', 'PRIVATE_ARGS_', 'PRIVATE_GITHUB_RESULT_'])
      expect(serial).not.toContain(s);
    expect(await redactedRunSummaryFor(db,'other-agent',runId)).toBeNull();
    expect(await redactedRunSummaryFor(db,'gemini',runId)).not.toBeNull();
  });
});

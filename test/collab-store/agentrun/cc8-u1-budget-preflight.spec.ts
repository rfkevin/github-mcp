import { describe, expect, it } from 'vitest';
import { ModelCallError } from '../../../src/collab-store/agentrun/engine';
import { tokenBudgetPreflight, requireTokenBudget } from '../../../src/collab-store/agentrun/budget-preflight';
import { createPaidProtocolModel } from '../../../src/collab-store/agentrun/paid-protocol';

describe('CC8 U1 total-token budget before provider calls', () => {
  it('refuses Gemini 8k budget when the upcoming request would exceed it', () => {
    const p = tokenBudgetPreflight(36_000, 2_048, 8_000);
    expect(p.allowed).toBe(false);
    expect(p.estimated_input_tokens + p.max_output_tokens).toBeGreaterThan(8_000);
    expect(() => requireTokenBudget(36_000, 2_048, 8_000)).toThrow('token_preflight_refused');
  });
  it('allows a short request, and preserves tests with legacy unbounded model input', () => {
    expect(tokenBudgetPreflight(1500, 1024, 8000).allowed).toBe(true);
    expect(tokenBudgetPreflight(36000, 1024).allowed).toBe(true);
  });
  it('never fetches from a free Gemini provider after a preflight refusal', async () => {
    let called = 0;
    const model = createPaidProtocolModel({
      ref: 'gemini:gemini-3.8-flash', free: true, provider: 'gemini', secret: 'test',
      url: 'https://example.invalid', db: {} as D1Database, runId: 'u1-preflight',
      envelope: { dayCents: 0, cycleCents: 0, dayTokens: 0, dayRequests: 0 },
      schemas: () => [], system: 'system', maxOutputTokens: 2048,
      protocol: {
        headers: () => ({}), prepare: () => ({ body: { test: true }, bound: 36000 }),
        parse: () => ({ output: { text: 'ok', tool_calls: [] }, input: 1, output_tokens: 1 }),
      },
      fetchImpl: (async () => { called++; throw new Error('provider must not be called'); }) as typeof fetch,
    });
    await expect(model.complete({ messages: [{ role: 'user', content: 'hello' }], tools: [],
      task_kind: 'answer', budget_left_tokens: 8000 })).rejects.toBeInstanceOf(ModelCallError);
    expect(called).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { modelFailureKind } from '../../../src/collab-store/agentrun/model-failure';

describe('CC8 S1b — classification fail-closed', () => {
  it.each(['HTTP 503 Service Unavailable', 'HTTP 502', 'HTTP 504', '429 Too Many Requests', 'fetch failed',
    'network error', 'ETIMEDOUT', 'AbortError', 'request timeout',
    'workers_ai_error: 8004: Internal server error', 'HTTP 500 Internal Server Error',
    'FALLBACK_AFTER_TRANSIENT: primary unavailable, fallback rejected',
    'gemini_error: Fournisseur sans réponse après 60000 ms.',
    'zai_error: Fournisseur sans réponse après 90000 ms.'])('transient : %s', message => {
    expect(modelFailureKind(new Error(message))).toBe('transient');
  });
  it.each(['MODEL_ROUTE_REFUSED : HTTP 503', 'MODEL_BUDGET_EXHAUSTED', 'PAID_ENVELOPE_NOT_FUNDED',
    'HTTP 400', 'HTTP 401', 'HTTP 403', 'HTTP 404',
    'workers_ai_error: 8004: Invalid request', 'MODEL_ROUTE_REFUSED : workers_ai_error: 8004: Internal server error',
    'invalid request', 'MODEL_ROUTE_NONE',
    'MODEL_ROUTE_REFUSED : Fournisseur sans réponse après 60000 ms.', 'Fournisseur sans JSON exploitable'])('permanent : %s', message => {
    expect(modelFailureKind(new Error(message))).toBe('permanent');
  });
});

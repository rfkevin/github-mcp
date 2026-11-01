/** CC8 S1b : seules les erreurs de transport explicitement transitoires autorisent un repli. */
export type FailureKind = 'transient' | 'permanent';
export function modelFailureKind(error: unknown): FailureKind {
  const value = error instanceof Error ? error.message : String(error);
  if (/MODEL_ROUTE_REFUSED|MODEL_BUDGET_EXHAUSTED|PAID_ENVELOPE_NOT_FUNDED|MODEL_ROUTE_NONE|MODEL_PROVIDER_UNSUPPORTED|MODEL_.*UNSUPPORTED|\b(?:400|401|403|404)\b/i.test(value)) return 'permanent';
  if (/\b(?:429|502|503|504)\b|timeout|timed out|network|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError/i.test(value)) return 'transient';
  return 'permanent';
}

/** CC8 U1 — total run tokens = input + output. Preflight is an estimate, not
 * a provider-side hard reservation: actual usage and D1 cumulative limit still apply.
 * boundBytes includes serialized context AND offered tools; no source text is logged.
 */
import { ModelCallError } from './engine';

export function tokenBudgetPreflight(boundBytes: number, maxOutputTokens: number,
  remainingTokens?: number) {
  // Provider-specific tokenizer unavailable: a cautious approximation, including framing.
  const estimated_input_tokens = Math.ceil(Math.max(0, boundBytes) / 3) + 128;
  const remaining_tokens = remainingTokens === undefined ? null : Math.max(0, Math.floor(remainingTokens));
  return { estimated_input_tokens, max_output_tokens: maxOutputTokens, remaining_tokens,
    allowed: remaining_tokens === null || estimated_input_tokens + maxOutputTokens <= remaining_tokens };
}

export function requireTokenBudget(boundBytes: number, maxOutputTokens: number, remainingTokens?: number) {
  const p = tokenBudgetPreflight(boundBytes, maxOutputTokens, remainingTokens);
  if (!p.allowed) throw new ModelCallError('token_preflight_refused: estimated_input=' + p.estimated_input_tokens
    + ', max_output=' + p.max_output_tokens + ', remaining=' + p.remaining_tokens
    + '; no provider call attempted', null);
  return p;
}

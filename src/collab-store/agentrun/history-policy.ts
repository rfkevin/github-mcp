/** Provider-neutral view policy. Never changes the persisted D1 journal or mission budgets. */
export const RECENT_HISTORY_BYTES = 48_000;

export function recentHistoryOffset(steps: readonly { model_output: string; results: string }[],
  compact: boolean): number {
  if (!compact) return 0;
  const encoder = new TextEncoder();
  let offset = steps.length;
  let used = 0;
  while (offset > 0) {
    const row = steps[offset - 1];
    const size = encoder.encode(row.model_output).length + encoder.encode(row.results).length;
    // Keep the latest complete call/result unit even when it alone exceeds the view budget.
    if (offset < steps.length && used + size > RECENT_HISTORY_BYTES) break;
    used += size;
    offset--;
  }
  return offset;
}

/** Reminder only: the model must choose and execute the existing publication tool.
 * No invented answer, verdict, effect, or automatic success. */
export function answerPublicationReminder(kind: string, prompt: string, tools: readonly string[]): string | null {
  if (kind !== 'answer' || !tools.includes('store_answer')) return null;
  const ask = /^Question #([1-9][0-9]*) du cycle /.exec(prompt);
  if (!ask || !Number.isSafeInteger(Number(ask[1]))) return null;
  return 'Publication de cette mission : répondre avec store_answer({ask_seq:' + ask[1]
    + ', answer: votre réponse étayée}). Un texte final seul ne publie rien dans le store. '
    + 'Utilisez les lectures et résultats déjà présents dans cet historique ; ne recommencez pas la préparation '
    + 'si ces preuves suffisent. Si une preuve manque, poursuivez les lectures utiles et dites ce qui reste incertain.';
}

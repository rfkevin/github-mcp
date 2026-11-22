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

/** Numéro de question référencé par le prompt d'une mission `answer` (extrait de
 * l'en-tête `Question #N du cycle …`), ou null si le prompt ne cible aucune question
 * réelle — même condition que la publication store_answer vérifiée côté store. */
export function answerAskSeq(prompt: string): number | null {
  const ask = /^Question #([1-9][0-9]*) du cycle /.exec(prompt);
  if (!ask || !Number.isSafeInteger(Number(ask[1]))) return null;
  return Number(ask[1]);
}

/** Reminder only: the model must choose and execute the existing publication tool.
 * No invented answer, verdict, effect, or automatic success. */
export function answerPublicationReminder(kind: string, prompt: string, tools: readonly string[]): string | null {
  if (kind !== 'answer' || !tools.includes('store_answer')) return null;
  const ask = answerAskSeq(prompt);
  if (ask === null) return null;
  return 'Publication de cette mission : répondre avec store_answer({ask_seq:' + ask
    + ', answer: votre réponse étayée}). Un texte final seul ne publie rien dans le store. '
    + 'Utilisez les lectures et résultats déjà présents dans cet historique ; ne recommencez pas la préparation '
    + 'si ces preuves suffisent. Si une preuve manque, poursuivez les lectures utiles et dites ce qui reste incertain.';
}

/** CC8 S9 v2 : reprise unique après une fin purement textuelle d'une mission `answer`
 * (même logique que verdictRecoveryTurn pour review/test). Rappel seul : jamais
 * d'auto-publication, jamais de succès inventé ; store_answer reste l'unique porte. */
export function answerRecoveryInstruction(kind: string, prompt: string, tools: readonly string[],
  isRecoveryTurn: boolean): string | null {
  if (!isRecoveryTurn || kind !== 'answer' || !tools.includes('store_answer')) return null;
  const ask = answerAskSeq(prompt);
  const call = ask !== null
    ? 'store_answer({ask_seq:' + ask + ', answer: votre réponse étayée})'
    : 'store_answer({ask_seq: seq de la question, answer: votre réponse étayée})';
  return 'Reprise PUBLICATION : votre dernier tour a répondu en texte SANS store_answer — la réponse n a PAS '
    + 'été publiée dans le store. Ceci est l UNIQUE tour correctif : appelez maintenant ' + call + '. '
    + 'Utilisez les lectures et résultats déjà présents dans cet historique ; ne recommencez pas la préparation. '
    + 'Si une preuve manque, dites précisément ce qui reste incertain dans la réponse publiée ; ne fabriquez jamais de succès.';
}

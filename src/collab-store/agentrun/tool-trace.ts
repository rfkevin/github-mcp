/**
 * CC8 — preuves d'appels d'outils pour l'observabilité du coordinateur.
 * UNIQUEMENT noms de catalogue stables + statuts + codes fermés.
 * Pas d'arguments, d'ID de call, de reçus, de chemins ou de texte libre.
 * Sources D1 existantes, aucune table ni seconde écriture.
 */
const READ_NAMES = new Set([
  'store_context','store_delta','store_memory','store_continuity','store_salon_read',
  'github_list_directory','github_read_file','github_pull_request','github_check_runs',
  'github_diff','github_check_result','web_fetch_official',
]);
const WRITE_NAMES = new Set([
  'store_ask','store_answer','store_task_status','store_handover',
  'store_memory_propose','store_memory_rewrite','store_verdict','store_contribute',
  'store_salon_post','store_choose_model',
  'github_create_branch','github_commit_files','github_open_draft_pr','github_open_pr',
  'github_write_scope','github_replace_text','github_run_checks',
]);

const EXACT_ERRORS = new Set([
  'HALT','STALE','QUOTA_EXHAUSTED','INVALID_OP_ID',
  'CLARIFY_ANSWER_FORBIDDEN','CLARIFY_TO_INVALID','CLARIFY_ANSWER_INVALID',
  'UNREGISTERED_PARTICIPANT','UNREGISTERED_CLIENT','CYCLE_CLOSED',
  'tool_not_allowlisted','tool_forbidden_on_api_channel',
  'd12_verdict_forbidden_on_api_channel','superseded_by_live_message',
  'api_task_not_enabled','api_task_grant_ambiguous','api_write_scope_refused',
  'api_base_head_unavailable','effect_key_required','unknown_run',
]);
const MAX_CALLS_PER_STEP = 64;

export type SafeToolAttempt = {
  index: number;
  tool: string;
  kind: 'read' | 'write' | 'unknown';
  status: 'receipt_ok' | 'receipt_failed' | 'not_recorded' |
    'effect_completed' | 'effect_failed' | 'effect_pending';
  failure_code: string | null;
};

export type StoredEffect = { idx: number; status: string; result: string | null };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function jsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try { return objectValue(JSON.parse(raw) as unknown); } catch { return null; }
}

/** Classe issue d'une chaîne d'erreur non fiable : jamais de retour du texte original. */
export function typedToolFailure(raw: string | null): string | null {
  if (raw === null) return null;
  const message = jsonObject(raw)?.error;
  if (typeof message !== 'string') return 'other';
  if (EXACT_ERRORS.has(message)) return message;
  if (message === 'answer : texte de 1 à 4000 caractères requis.'
    || message === 'store_answer : texte de 1 à 4000 caractères requis.') return 'answer_length_invalid';
  if (message === 'ask_seq : entier ≥ 1 requis.') return 'ask_seq_invalid';
  return 'other';
}

function toolIdentity(value: unknown): { tool: string; kind: SafeToolAttempt['kind'] } {
  if (typeof value === 'string' && READ_NAMES.has(value)) return { tool: value, kind: 'read' };
  if (typeof value === 'string' && WRITE_NAMES.has(value)) return { tool: value, kind: 'write' };
  return { tool: 'unknown_tool', kind: 'unknown' };
}

/** Aucun nom provenant d'un modèle ne traverse la frontière sans être classé. */
export function safeToolName(value: unknown): string { return toolIdentity(value).tool; }

/** Compare chaque appel MODELE aux reçus D1 par id, puis aux effets D1 par index. */
export function redactedToolAttempts(
  modelOutput: string | null, results: string | null, effects: readonly StoredEffect[] = [],
): SafeToolAttempt[] {
  const rawCalls = jsonObject(modelOutput)?.tool_calls;
  if (!Array.isArray(rawCalls)) return [];
  let rawReceipts: unknown = null;
  try { rawReceipts = results !== null ? JSON.parse(results) as unknown : null; } catch { /* aucun reçu prouvé */ }
  const receipts = new Map<string, Record<string, unknown>>();
  if (Array.isArray(rawReceipts)) for (const item of rawReceipts) {
    const r = objectValue(item);
    if (r && typeof r.id === 'string') receipts.set(r.id, r);
  }
  return rawCalls.slice(0, MAX_CALLS_PER_STEP).map((item: unknown, index: number): SafeToolAttempt => {
    const call = objectValue(item);
    const identity = toolIdentity(call?.name);
    const receipt = typeof call?.id === 'string' ? receipts.get(call.id) : null;
    const effect = effects.find(e => e.idx === index);
    if (effect) {
      const status: SafeToolAttempt['status'] = effect.status === 'completed' ? 'effect_completed'
        : effect.status === 'failed' ? 'effect_failed' : 'effect_pending';
      return { index, ...identity, status,
        failure_code: status === 'effect_failed' ? typedToolFailure(effect.result) : null };
    }
    if (!receipt) return { index, ...identity, status: 'not_recorded', failure_code: null };
    const failed = receipt.error === true;
    return { index, ...identity, status: failed ? 'receipt_failed' : 'receipt_ok',
      failure_code: failed && typeof receipt.content === 'string' ? typedToolFailure(receipt.content) : null };
  });
}

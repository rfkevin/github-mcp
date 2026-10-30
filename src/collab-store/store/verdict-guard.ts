/**
 * CC-7 L14 (décision de Kevin du 2026-10-30, « ça doit être obligatoire pour éviter les confusions ») —
 * un verdict D12 n'est accepté par le store que s'il est rattaché à une tâche, à un rôle et à un couple exact.
 *
 * Constat : des verdicts ont été déposés sous une tâche inexistante (« L12 »), par un participant sans
 * rôle sur la tâche, ou sans head/base structurés. Le contrôleur (controller/facts.ts) les ignorait en
 * silence ; personne ne savait qu'ils ne comptaient pas. Désormais le store les REFUSE avec un code typé,
 * avant toute écriture (aucune révision ni quota consommé).
 *
 * Un `evidence.add` est un VERDICT DE PR quand (1) son état (`verdict`, sinon `state`) commence par un
 * mot de verdict (mêmes listes que le contrôleur) ou son rôle est `reviewer` / `tester`, ET (2) il cite
 * une PR (`pr`, lien `/pull/<n>` dans evidence_ref ou le texte, « PR #<n> »). Ne sont PAS concernés :
 * les preuves d'auteur (CI_PASSED, SUBMITTED, bilans…) et les critiques et votes des phases de conception
 * (L6b : AGREE/AMEND sur une proposition ou la synthèse, sans PR ni SHA).
 */

/** Mêmes mots que controller/facts.ts : un verdict refusé ici serait aussi un verdict là-bas. */
export const VERDICT_POSITIVE_RE = /^(AGREE|PASS|APPROVE|OK)\b/i;
export const VERDICT_NEGATIVE_RE = /^(AMEND|BLOCK|CHANGES[_ ]REQUESTED|FAIL|REJECT)\b/i;
export const VERDICT_ROLES: readonly string[] = ['reviewer', 'tester'];

const SHA_RE = /^[0-9a-f]{40}$/;
/** « PR #239 », « PR 239 », « /pull/239 » — pas « github-mcp#70 » (référence d'issue ou de dépôt). */
const PR_MENTION_RE = /\bPR\s*#?\d+|\/pull\/\d+/i;
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface VerdictClaim {
  task: string;
  head: string;
  base: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function nested(value: unknown, key: string): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? text((value as Record<string, unknown>)[key]) : '';
}

/** Le payload porte-t-il un verdict (mot de verdict ou rôle) ? Payload illisible : non, comme le contrôleur. */
export function isVerdictEvidence(payload: Record<string, unknown> | null, role: string | undefined): boolean {
  if (role && VERDICT_ROLES.includes(role)) return true;
  if (!payload) return false;
  const declared = (text(payload.verdict) || text(payload.state)).trim();
  return VERDICT_POSITIVE_RE.test(declared) || VERDICT_NEGATIVE_RE.test(declared);
}

/** Le payload (ou la référence de preuve) cite-t-il une PR ? */
export function citesPullRequest(payload: Record<string, unknown> | null, evidenceRef: string | undefined): boolean {
  if (evidenceRef && PR_MENTION_RE.test(evidenceRef)) return true;
  if (!payload) return false;
  if (payload.pr !== undefined && payload.pr !== null && payload.pr !== '') return true;
  return [payload.source, payload.state, payload.review, payload.verdict].some(part => PR_MENTION_RE.test(text(part)));
}

/** Verdict de PR soumis à la règle L14 : verdict ET citation d'une PR. */
export function isPrVerdict(payload: Record<string, unknown> | null, role: string | undefined, evidenceRef: string | undefined): boolean {
  return isVerdictEvidence(payload, role) && citesPullRequest(payload, evidenceRef);
}

export type VerdictShapeError =
  | { code: 'VERDICT_TASK_REQUIRED'; message: string }
  | { code: 'VERDICT_PAIR_REQUIRED'; message: string };

/**
 * Forme exigée d'un verdict : `task` (identifiant de tâche du store) et `head` / `base` en SHA complets,
 * STRUCTURÉS (champs `head`/`base` ou `pr.head_sha`/`pr.base_sha`) — jamais déduits du texte libre.
 */
export function verdictClaimOf(payload: Record<string, unknown> | null): VerdictClaim | VerdictShapeError {
  const task = (text(payload?.task) || text(payload?.task_id)).trim();
  if (!TASK_ID_RE.test(task)) {
    return { code: 'VERDICT_TASK_REQUIRED', message: 'Un verdict D12 (evidence.add AGREE/PASS/CHANGES_REQUESTED/FAIL…, ou rôle reviewer/tester) exige « task » : l’identifiant de la tâche du store (task.claim), par exemple « pr239 ».' };
  }
  const head = (text(payload?.head) || nested(payload?.pr, 'head_sha')).trim().toLowerCase();
  const base = (text(payload?.base) || nested(payload?.pr, 'base_sha')).trim().toLowerCase();
  if (!SHA_RE.test(head) || !SHA_RE.test(base)) {
    return { code: 'VERDICT_PAIR_REQUIRED', message: 'Un verdict D12 exige « head » et « base » : les SHA complets (40 caractères hexadécimaux) du couple examiné, en champs structurés — pas seulement dans le texte.' };
  }
  return { task, head, base };
}

/**
 * CC-5 L3 — extraction des faits du contrôleur à partir des événements du store.
 *
 * Pur et défensif : un payload illisible ne produit aucun fait (jamais une
 * décision positive par défaut). Les champs structurés (`verdict`, `head`,
 * `base`) priment ; à défaut, le contrôleur lit les formes déjà utilisées par
 * les agents (« head <sha> », « base … <sha> », état commençant par AGREE…).
 */
import type { Submission, Verdict, VerdictFact } from './rules';

export interface EvidenceEvent {
  seq: number;
  participant: string;
  payload_json: string;
  evidence_ref: string;
}

const SHA = '([0-9a-f]{40})';
const HEAD_RE = new RegExp('\\bhead\\b[^\\n]{0,60}?\\b' + SHA + '\\b', 'i');
const BASE_RE = new RegExp('\\bbase\\b[^\\n]{0,80}?\\b' + SHA + '\\b', 'i');
const POSITIVE = /^(AGREE|PASS|APPROVE|OK)\b/i;
const NEGATIVE = /^(AMEND|BLOCK|CHANGES[_ ]REQUESTED|FAIL|REJECT)\b/i;
const PR_RE = /\/pull\/\d+/;

interface EvidencePayload {
  task?: unknown;
  task_id?: unknown;
  pr?: unknown;
  state?: unknown;
  source?: unknown;
  review?: unknown;
  verdict?: unknown;
  head?: unknown;
  base?: unknown;
}

function parse(json: string): EvidencePayload | null {
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as EvidencePayload : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** Champ d'un sous-objet (`pr.head_sha`…), sinon chaîne vide. */
function nested(value: unknown, key: string): string {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? text((value as Record<string, unknown>)[key]) : '';
}

function sha(structured: unknown, pattern: RegExp, haystack: string): string | null {
  const direct = text(structured).toLowerCase();
  if (/^[0-9a-f]{40}$/.test(direct)) return direct;
  const match = pattern.exec(haystack);
  return match ? match[1].toLowerCase() : null;
}

function verdictOf(payload: EvidencePayload): Verdict {
  const declared = text(payload.verdict) || text(payload.state);
  if (POSITIVE.test(declared.trim())) return 'positive';
  if (NEGATIVE.test(declared.trim())) return 'negative';
  return 'unknown';
}

export interface TaskEvidence {
  submission: Submission | null;
  verdicts: VerdictFact[];
}

/**
 * Faits d'une tâche : soumission = dernier evidence.add de l'AUTEUR citant une
 * PR avec head et base exacts ; verdicts = evidence.add du relecteur ou du
 * testeur sur cette tâche. Les autres participants ne comptent jamais (D12).
 */
export function taskEvidence(taskId: string, roles: { owner: string; reviewer: string; tester: string },
  events: EvidenceEvent[]): TaskEvidence {
  let submission: Submission | null = null;
  const verdicts: VerdictFact[] = [];
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const payload = parse(event.payload_json);
    if (!payload || (text(payload.task) || text(payload.task_id)) !== taskId) continue;
    const haystack = [text(payload.source), text(payload.state), text(payload.review)].join('\n');
    const head = sha(text(payload.head) || nested(payload.pr, 'head_sha'), HEAD_RE, haystack);
    const base = sha(text(payload.base) || nested(payload.pr, 'base_sha'), BASE_RE, haystack);
    if (event.participant === roles.owner) {
      const prNumber = typeof payload.pr === 'number' && Number.isSafeInteger(payload.pr) && payload.pr > 0;
      const citesPr = prNumber || PR_RE.test(event.evidence_ref) || PR_RE.test(haystack) || PR_RE.test(nested(payload.pr, 'url'));
      if (citesPr && head && base) submission = { head, base, seq: event.seq };
      continue;
    }
    if (event.participant === roles.reviewer || event.participant === roles.tester) {
      verdicts.push({ participant: event.participant, verdict: verdictOf(payload), head, base, seq: event.seq });
    }
  }
  return { submission, verdicts };
}

/** Dépendances d'une cellule CC-STATE-1 (« none », « l0, l1 »). */
export function parseDependencies(cell: string): string[] {
  const value = cell.trim();
  if (!value || value.toLowerCase() === 'none') return [];
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

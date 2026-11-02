/**
 * CC-8 S5 (CC-PLAN-8 §4, v0.2 seq 1270) — rejeu stratifié de vraies tâches
 * passées du store pour le canary F2. Le journal append-only est la seule
 * source : les paquets d'entrée des invocations ne sont jamais persistés
 * (CC-4 A1, hashés), le canary ne rediffuse donc jamais de paquet brut.
 *
 * Coût 0 : cette couche est pure, aucun appel fournisseur. L'appel réel passe
 * par le CanaryCaller fourni par l'appelant (simulateur déterministe en test ;
 * modèle réel gratuit uniquement sur décision de Kevin, jamais payant sans
 * plafond owner posé par /owner).
 *
 * Mapping documenté, déterministe :
 * - answer    : proposal.submit, checkpoint (travail d'auteur ; le contenu
 *   scellé des propositions n'est jamais publié avant la révélation, seules
 *   les enveloppes et les bilans checkpoint sont rejoués) ;
 * - review    : evidence.add état AGREE | AMEND | CHANGES_REQUESTED | OBJECTION ;
 * - test      : evidence.add état PASS | FAIL ;
 * - implement : manual_op.log, task.handoff (opérations et reprises réelles).
 * Sont exclus : clarify.* (questions adressées privées), memory.* (scopes
 * privés), owner.* / phase.request / task.claim / task.status / objection.*
 * (coordination et décisions, pas des tâches de travail).
 */
import { sha256Hex } from '../../store/hash';
import type { CanaryTaskKind } from '../promote';

/** Minimum d'appels par type (plan : 5 × 4 types = CANARY_MIN_CALLS = 20). */
export const CANARY_MIN_PER_KIND = 5;

/** Fenêtre bornée du journal examinée par passe (seq décroissante). */
export const CANARY_JOURNAL_WINDOW = 500;

/** Taille maximale d'un prompt de rejeu. */
export const CANARY_PROMPT_MAX = 2000;

export interface JournalEventRow {
  readonly seq: number;
  readonly type: string;
  readonly participant_id: string;
  readonly payload_json: string;
}

export interface ReplayTask {
  readonly seq: number;
  readonly kind: CanaryTaskKind;
  readonly prompt: string;
  readonly source_hash: string;
}

const REVIEW_STATES = new Set(['AGREE', 'AMEND', 'CHANGES_REQUESTED', 'OBJECTION']);
const TEST_STATES = new Set(['PASS', 'FAIL']);
const KIND_ORDER = ['answer', 'review', 'test', 'implement'] as const;

/** Type d'événement (et état evidence.add) → type canary, null si non rejouable. */
export function replayKindOf(type: string, state?: string): CanaryTaskKind | null {
  if (type === 'proposal.submit' || type === 'checkpoint') return 'answer';
  if (type === 'evidence.add') {
    if (state !== undefined && REVIEW_STATES.has(state)) return 'review';
    if (state !== undefined && TEST_STATES.has(state)) return 'test';
    return null;
  }
  if (type === 'manual_op.log' || type === 'task.handoff') return 'implement';
  return null;
}

/** État evidence.add du payload (undefined sinon, payload invalide compris). */
export function evidenceStateOf(payloadJson: string): string | undefined {
  try {
    const parsed = JSON.parse(payloadJson) as { state?: unknown };
    return typeof parsed?.state === 'string' ? parsed.state : undefined;
  } catch {
    return undefined;
  }
}

/** Événements récents du cycle pour le rejeu (fenêtre bornée, seq décroissante). */
export async function journalEventsForReplay(
  db: D1Database,
  cycleId: string,
  limit: number = CANARY_JOURNAL_WINDOW,
): Promise<JournalEventRow[]> {
  const { results } = await db.prepare([
    'SELECT seq, type, participant_id, payload_json FROM events',
    'WHERE cycle_id = ?1 ORDER BY seq DESC LIMIT ?2',
  ].join(' ')).bind(cycleId, limit).all<JournalEventRow>();
  return results ?? [];
}

/** Prompt borné et déterministe : type, état, auteur, extrait du payload.
 * Note (relecture GPT-6, non bloquant) : le journal interne peut contenir du
 * contenu scellé ou privé — vérifier son absence avant toute transmission
 * future de ces prompts à un modèle externe. */
function boundedPrompt(event: JournalEventRow, state: string | undefined): string | null {
  let normalized = '';
  try {
    normalized = JSON.stringify(JSON.parse(event.payload_json)).normalize('NFKC');
  } catch {
    return null;
  }
  if (!normalized) return null;
  const head = event.type + (state ? ' ' + state : '') + ' | ' + event.participant_id + ' | ';
  return head + normalized.slice(0, Math.max(0, CANARY_PROMPT_MAX - head.length));
}

/** Les plus récents rejouables de chaque type, ordre stable par type puis seq croissante ; insensible au sens de la liste reçue (tri interne par seq décroissante). */
export async function selectReplayTasks(
  events: readonly JournalEventRow[],
  perKind: number = CANARY_MIN_PER_KIND,
): Promise<ReplayTask[]> {
  const byKind = new Map<CanaryTaskKind, ReplayTask[]>();
  for (const kind of KIND_ORDER) byKind.set(kind, []);
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const state = evidenceStateOf(event.payload_json);
    const kind = replayKindOf(event.type, state);
    if (kind === null) continue;
    const bucket = byKind.get(kind);
    if (bucket === undefined || bucket.length >= perKind) continue;
    const prompt = boundedPrompt(event, state);
    if (prompt === null) continue;
    bucket.push({
      seq: event.seq,
      kind,
      prompt,
      source_hash: await sha256Hex(event.type + '\n' + event.payload_json),
    });
  }
  const tasks: ReplayTask[] = [];
  for (const kind of KIND_ORDER) {
    const bucket = byKind.get(kind) ?? [];
    bucket.sort((a, b) => a.seq - b.seq);
    tasks.push(...bucket);
  }
  return tasks;
}

/**
 * CC-7 L3 (incrément 1) — continuité chat/API d'un même participant (plan CC-PLAN-7 v0.2, S5).
 *
 * Lecture seule, bornée et déterministe. Trois sources, toutes déjà écrites par le serveur :
 * - les exécutions API du participant (`agent_runs`, avec `summary` = message final capturé par le
 *   moteur) : c'est la note de passation de l'API, obligatoire par construction (aucune exécution
 *   terminée sans message final) et consignée par le serveur, jamais par le modèle ;
 * - les notes de passation explicites : `checkpoint` de payload `{kind: "handover", done, todo, learned}`,
 *   déposées par le chat (ou par l'API) du participant ;
 * - la dernière visite du chat : le dernier événement du participant dont le rôle n'est pas `api-agent`.
 *
 * « Depuis ta dernière visite » = ce que l'API du participant a fait APRÈS cette visite. Une exécution
 * ou une note d'un autre participant n'est jamais rendue (identités équivalentes #126 comprises).
 */
import { ensureSchema } from '../store/schema';

export const HANDOVER_KIND = 'handover';
/** Une note : 300 mots au plus (S5) ; borne en caractères, appliquée à chaque rubrique et au total. */
export const HANDOVER_MAX_CHARS = 2400;
export const CONTINUITY_MAX_RUNS = 5;
export const CONTINUITY_MAX_NOTES = 5;
export const CONTINUITY_SUMMARY_CHARS = 1200;

export interface HandoverNote {
  seq: number;
  at: number;
  channel: 'api' | 'chat';
  done: string;
  todo: string;
  learned: string;
}

export interface ApiRunTrace {
  run_id: string;
  task_kind: string;
  status: string;
  stop_reason: string;
  created_at: number;
  updated_at: number;
  /** Message final de l'exécution (sa note de passation), tronqué à CONTINUITY_SUMMARY_CHARS. */
  summary: string;
}

export interface Continuity {
  /** seq du dernier événement du chat du participant dans ce cycle (0 = jamais). */
  last_visit_seq: number;
  last_visit_at: number;
  /** Exécutions API créées après la dernière visite, de la plus récente à la plus ancienne. */
  api_runs: ApiRunTrace[];
  /** Notes de passation du participant (chat et API), de la plus récente à la plus ancienne. */
  handovers: HandoverNote[];
  /** true = des éléments plus anciens existent au-delà des bornes (jamais une perte silencieuse). */
  truncated: { api_runs: boolean; handovers: boolean };
}

const clip = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Note de passation valide, ou null. Rubriques texte ; au moins une non vide ; total borné
 * (une note trop longue est refusée en écriture par l'appelant, tronquée ici en lecture).
 */
export function parseHandover(payloadJson: string): { done: string; todo: string; learned: string } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.kind !== HANDOVER_KIND) return null;
  const note = { done: clip(record.done, HANDOVER_MAX_CHARS), todo: clip(record.todo, HANDOVER_MAX_CHARS),
    learned: clip(record.learned, HANDOVER_MAX_CHARS) };
  if (!note.done && !note.todo && !note.learned) return null;
  return note;
}

/** Longueur totale d'une note, pour refuser en écriture au-delà de HANDOVER_MAX_CHARS. */
export function handoverLength(note: { done?: unknown; todo?: unknown; learned?: unknown }): number {
  return [note.done, note.todo, note.learned].reduce<number>((sum, part) => sum + (typeof part === 'string' ? part.length : 0), 0);
}

async function agentRunsTableExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'").first<{ name: string }>();
  return !!row;
}

export async function loadContinuity(db: D1Database, cycleId: string, participantIds: readonly string[]): Promise<Continuity> {
  await ensureSchema(db);
  const ids = [...new Set(participantIds)].filter(Boolean);
  const empty: Continuity = { last_visit_seq: 0, last_visit_at: 0, api_runs: [], handovers: [], truncated: { api_runs: false, handovers: false } };
  if (ids.length === 0) return empty;
  const placeholders = ids.map((_, index) => '?' + (index + 2)).join(',');

  const visit = await db.prepare([
    'SELECT seq, at FROM events WHERE cycle_id = ?1 AND participant_id IN (' + placeholders + ")",
    "AND COALESCE(role, '') <> 'api-agent' AND type NOT IN ('owner.decision', 'phase.advance')",
    'ORDER BY seq DESC LIMIT 1',
  ].join(' ')).bind(cycleId, ...ids).first<{ seq: number; at: number }>();
  const lastVisitSeq = visit?.seq ?? 0;
  const lastVisitAt = visit?.at ?? 0;

  const { results: noteRows } = await db.prepare([
    'SELECT seq, at, role, payload_json FROM events WHERE cycle_id = ?1 AND participant_id IN (' + placeholders + ")",
    "AND type = 'checkpoint' AND json_valid(payload_json) AND json_extract(payload_json, '$.kind') = '" + HANDOVER_KIND + "'",
    'ORDER BY seq DESC LIMIT ' + (CONTINUITY_MAX_NOTES + 1),
  ].join(' ')).bind(cycleId, ...ids).all<{ seq: number; at: number; role: string | null; payload_json: string }>();
  const handovers: HandoverNote[] = [];
  for (const row of noteRows) {
    const note = parseHandover(row.payload_json);
    if (note) handovers.push({ seq: row.seq, at: row.at, channel: row.role === 'api-agent' ? 'api' : 'chat', ...note });
  }

  let runs: ApiRunTrace[] = [];
  if (await agentRunsTableExists(db)) {
    const { results } = await db.prepare([
      'SELECT run_id, task_kind, status, stop_reason, created_at, updated_at, summary FROM agent_runs',
      'WHERE cycle_id = ?1 AND participant_id IN (' + placeholders + ') AND created_at > ?' + (ids.length + 2),
      'ORDER BY created_at DESC, run_id LIMIT ' + (CONTINUITY_MAX_RUNS + 1),
    ].join(' ')).bind(cycleId, ...ids, lastVisitAt).all<ApiRunTrace>();
    runs = results.map(run => ({ ...run, summary: clip(run.summary, CONTINUITY_SUMMARY_CHARS) }));
  }

  return {
    last_visit_seq: lastVisitSeq,
    last_visit_at: lastVisitAt,
    api_runs: runs.slice(0, CONTINUITY_MAX_RUNS),
    handovers: handovers.slice(0, CONTINUITY_MAX_NOTES),
    truncated: { api_runs: runs.length > CONTINUITY_MAX_RUNS, handovers: noteRows.length > CONTINUITY_MAX_NOTES },
  };
}

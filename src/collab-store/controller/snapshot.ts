/**
 * CC-5 L3 — instantané du contrôleur, lu en UN lot D1 (même point du store).
 *
 * Lecture seule. Les identités sont ramenées à leur famille logique (#126) :
 * gpt6 et sol comptent comme un seul principal, côté rôles comme côté
 * événements. Les dépendances viennent du dernier état importé par Kevin
 * (CC-STATE-1). Les preuves (`evidence.add`) sont lues sur TOUT le cycle,
 * indépendamment des imports : un réimport d'état ne fait disparaître ni
 * soumission ni verdict (revue R1). La validité d'un verdict reste fixée par
 * D12 (head et base exacts de la soumission courante), pas par sa date.
 */
import { parseStateDocument } from '../export/document';
import { STATE_IMPORT_KEY_PREFIX } from '../export/state-export';
import { CollabStoreError } from '../store/collab-store';
import { ensureSchema } from '../store/schema';
import { taskEvidence, parseDependencies, type EvidenceEvent } from './facts';
import type { ControllerSnapshot, CorrectionFact, QuestionFact, TaskFacts } from './rules';

interface TaskRow { task_id: string; status: string; revision: number; owner_pid: string; reviewer_pid: string; tester_pid: string }
interface ClarifyRow { seq: number; type: string; participant_id: string; payload_json: string; expected_rev: number }

/** Plafond de lecture des événements clarify par passage (paquet borné, D3). */
const CLARIFY_SCAN_LIMIT = 2000;
/** Plafond de lecture des demandes de correction par passage (2c-2). */
const CORRECTION_SCAN_LIMIT = 500;

/** Dernière demande de correction par tâche (événements écrits par le serveur seulement). Payload illisible : ignoré. */
export function latestCorrections(rows: Array<{ seq: number; payload_json: string }>): Map<string, CorrectionFact> {
  const out = new Map<string, CorrectionFact>();
  for (const row of rows) {
    const payload = payloadOf(row.payload_json);
    const task = typeof payload?.task === 'string' ? payload.task : '';
    const items = Array.isArray(payload?.items) ? payload.items.length : 0;
    if (!task || items === 0) continue;
    const known = out.get(task);
    if (!known || row.seq > known.seq) out.set(task, { seq: row.seq, items });
  }
  return out;
}

function payloadOf(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Questions ouvertes (X13) : clarify.ask sans clarify.answer liée. Le store
 * refuse déjà les réponses non autorisées (CLARIFY_ANSWER_FORBIDDEN) : toute
 * réponse enregistrée ferme sa question. Destinataire = participant nommé ou
 * titulaire du rôle sur la tâche, ramené à son identité logique.
 */
export function openQuestions(rows: ClarifyRow[], tasks: TaskRow[], logical: (pid: string) => string): QuestionFact[] {
  const answered = new Set<number>();
  for (const row of rows) {
    if (row.type !== 'clarify.answer') continue;
    const askSeq = payloadOf(row.payload_json)?.ask_seq;
    if (typeof askSeq === 'number' && Number.isInteger(askSeq)) answered.add(askSeq);
  }
  const byTask = new Map(tasks.map(task => [task.task_id, task]));
  const out: QuestionFact[] = [];
  for (const row of rows) {
    if (row.type !== 'clarify.ask' || answered.has(row.seq)) continue;
    const payload = payloadOf(row.payload_json);
    const to = typeof payload?.to === 'string' ? payload.to : '';
    let addressee: string | null = null;
    if (to === 'owner' || to === 'reviewer' || to === 'tester') {
      const task = typeof payload?.task === 'string' ? byTask.get(payload.task) : undefined;
      if (task) addressee = to === 'owner' ? task.owner_pid : to === 'reviewer' ? task.reviewer_pid : task.tester_pid;
    } else if (to) {
      addressee = to;
    }
    out.push({ seq: row.seq, author: logical(row.participant_id), addressee: addressee ? logical(addressee) : null,
      asked_at_revision: row.expected_rev });
  }
  return out;
}

function dependenciesFromState(content: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!content) return out;
  const document = parseStateDocument(content);
  const section = document.sections.find(item => item.name === 'Tasks');
  const table = section?.blocks.find(block => block.kind === 'table');
  if (!table || table.kind !== 'table') return out;
  const idIndex = table.headers.indexOf('id');
  const depIndex = table.headers.indexOf('dependencies');
  if (idIndex < 0 || depIndex < 0) return out;
  for (const row of table.rows) out.set(row[idIndex], parseDependencies(row[depIndex] ?? ''));
  return out;
}

/**
 * Lit cycle, HALT, définition de phase, tâches, familles, dernier import et
 * événements evidence.add et clarify du cycle dans un seul lot ; `outputsSatisfied`
 * est fourni par l'appelant (moteur de phase existant).
 */
export async function readControllerSnapshot(db: D1Database, cycleId: string,
  outputsSatisfied: (cycleId: string) => Promise<boolean>): Promise<ControllerSnapshot> {
  await ensureSchema(db);
  const importKey = STATE_IMPORT_KEY_PREFIX + cycleId + ':';
  const importSeq = "COALESCE((SELECT MAX(seq) FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'"
    + " AND participant_id = 'owner' AND substr(idempotency_key, 1, length(?2)) = ?2), 0)";
  const [cycle, halt, def, tasks, families, imported, evidence, clarify, corrections] = await db.batch([
    db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycleId),
    db.prepare("SELECT value FROM owner_flags WHERE name = 'halt'"),
    db.prepare('SELECT auto_advance FROM phase_definitions WHERE cycle_id = ?1 AND phase = (SELECT phase FROM cycles WHERE cycle_id = ?1)').bind(cycleId),
    db.prepare('SELECT task_id, status, revision, owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 ORDER BY task_id').bind(cycleId),
    db.prepare('SELECT participant_id, family_id FROM participant_identity_families'),
    db.prepare('SELECT payload_json FROM events WHERE seq = ' + importSeq).bind(cycleId, importKey),
    db.prepare("SELECT seq, participant_id, payload_json, evidence_ref FROM events WHERE cycle_id = ?1 AND type = 'evidence.add' ORDER BY seq")
      .bind(cycleId),
    db.prepare("SELECT seq, type, participant_id, payload_json, expected_rev FROM events WHERE cycle_id = ?1 AND type IN ('clarify.ask', 'clarify.answer') ORDER BY seq DESC LIMIT " + CLARIFY_SCAN_LIMIT)
      .bind(cycleId),
    db.prepare("SELECT seq, payload_json FROM events WHERE cycle_id = ?1 AND type = 'correction.request' ORDER BY seq DESC LIMIT " + CORRECTION_SCAN_LIMIT)
      .bind(cycleId),
  ]);
  const cycleRow = (cycle.results as Array<{ phase: string; revision: number }>)[0];
  if (!cycleRow) throw new CollabStoreError('UNKNOWN_CYCLE', 'Cycle inconnu : ' + cycleId);
  const familyOf = new Map((families.results as Array<{ participant_id: string; family_id: string }>)
    .map(row => [row.participant_id, row.family_id]));
  const logical = (pid: string): string => familyOf.get(pid) ?? pid;
  const importPayload = (imported.results as Array<{ payload_json: string }>)[0]?.payload_json;
  const content = importPayload ? (JSON.parse(importPayload) as { content?: string }).content ?? null : null;
  const deps = dependenciesFromState(content);
  const correctionByTask = latestCorrections(corrections.results as Array<{ seq: number; payload_json: string }>);
  const events: EvidenceEvent[] = (evidence.results as Array<{ seq: number; participant_id: string; payload_json: string; evidence_ref: string }>)
    .map(row => ({ seq: row.seq, participant: logical(row.participant_id), payload_json: row.payload_json, evidence_ref: row.evidence_ref ?? '' }));
  const taskFacts: TaskFacts[] = (tasks.results as TaskRow[]).map(row => {
    const roles = { owner: logical(row.owner_pid), reviewer: logical(row.reviewer_pid), tester: logical(row.tester_pid) };
    return { task_id: row.task_id, status: row.status, revision: row.revision, ...roles, dependencies: deps.get(row.task_id) ?? [],
      ...taskEvidence(row.task_id, roles, events), correction: correctionByTask.get(row.task_id) ?? null };
  });
  const autoAdvance = (def.results as Array<{ auto_advance: string }>)[0]?.auto_advance ?? 'none';
  return {
    cycle_id: cycleId,
    revision: cycleRow.revision,
    phase: cycleRow.phase,
    halted: (halt.results as Array<{ value: string }>)[0]?.value === '1',
    auto_advance: autoAdvance,
    outputs_satisfied: autoAdvance === 'none' ? false : await outputsSatisfied(cycleId),
    tasks: taskFacts,
    questions: openQuestions([...(clarify.results as ClarifyRow[])].reverse(), tasks.results as TaskRow[], logical),
  };
}

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
import type { ControllerSnapshot, TaskFacts } from './rules';

interface TaskRow { task_id: string; status: string; revision: number; owner_pid: string; reviewer_pid: string; tester_pid: string }

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
 * événements evidence.add du cycle dans un seul lot ; `outputsSatisfied`
 * est fourni par l'appelant (moteur de phase existant).
 */
export async function readControllerSnapshot(db: D1Database, cycleId: string,
  outputsSatisfied: (cycleId: string) => Promise<boolean>): Promise<ControllerSnapshot> {
  await ensureSchema(db);
  const importKey = STATE_IMPORT_KEY_PREFIX + cycleId + ':';
  const importSeq = "COALESCE((SELECT MAX(seq) FROM events WHERE cycle_id = ?1 AND type = 'owner.decision'"
    + " AND participant_id = 'owner' AND substr(idempotency_key, 1, length(?2)) = ?2), 0)";
  const [cycle, halt, def, tasks, families, imported, evidence] = await db.batch([
    db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycleId),
    db.prepare("SELECT value FROM owner_flags WHERE name = 'halt'"),
    db.prepare('SELECT auto_advance FROM phase_definitions WHERE cycle_id = ?1 AND phase = (SELECT phase FROM cycles WHERE cycle_id = ?1)').bind(cycleId),
    db.prepare('SELECT task_id, status, revision, owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 ORDER BY task_id').bind(cycleId),
    db.prepare('SELECT participant_id, family_id FROM participant_identity_families'),
    db.prepare('SELECT payload_json FROM events WHERE seq = ' + importSeq).bind(cycleId, importKey),
    db.prepare("SELECT seq, participant_id, payload_json, evidence_ref FROM events WHERE cycle_id = ?1 AND type = 'evidence.add' ORDER BY seq")
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
  const events: EvidenceEvent[] = (evidence.results as Array<{ seq: number; participant_id: string; payload_json: string; evidence_ref: string }>)
    .map(row => ({ seq: row.seq, participant: logical(row.participant_id), payload_json: row.payload_json, evidence_ref: row.evidence_ref ?? '' }));
  const taskFacts: TaskFacts[] = (tasks.results as TaskRow[]).map(row => {
    const roles = { owner: logical(row.owner_pid), reviewer: logical(row.reviewer_pid), tester: logical(row.tester_pid) };
    return { task_id: row.task_id, status: row.status, revision: row.revision, ...roles, dependencies: deps.get(row.task_id) ?? [],
      ...taskEvidence(row.task_id, roles, events) };
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
  };
}

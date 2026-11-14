/**
 * CC8 S9 — CI native terminée APRES la WorkSession : même circuit Store/contrôleur.
 * Source GitHub non fiable sans relecture API du head PR et des checks. Aucun verdict,
 * commit ou approbation fabriqués. Uniquement les corrections marquées native_ci
 * peuvent être réconciliées par une CI verte sans changement de code.
 */
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../owner/automation';
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { ensureSchema } from '../store/schema';

const SHA = /^[a-f0-9]{40}$/;
export const NATIVE_REQUIRED_CHECKS = ['ci', 'SonarCloud Code Analysis',
  'GitGuardian Security Checks', 'Workers Builds: github-mcp'] as const;
export type CiCheck = { id: number; name: string; status: string; conclusion: string | null; head_sha?: string };
export interface CiReadOnly {
  getPullRequest(repository: string, number: number): Promise<unknown>;
  listCheckRuns(repository: string, head: string): Promise<CiCheck[]>;
}
export interface CiTransitionInput {
  repository: string;
  number: number;
  head: string;
  now: number;
  reads: CiReadOnly;
  requiredChecks?: readonly string[];
}
export type CiTransitionResult =
  | { status: 'ignored'; reason: string }
  | { status: 'applied'; kind: 'correction.request' | 'run.reconcile'; task: string; cycle: string; payload_json: string };

interface Proof { seq: number; cycle_id: string; payload_json: string }
interface Correction { seq: number; payload_json: string }
interface Task { owner_pid: string; status: string }
const record = (x: unknown): Record<string, unknown> | null =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
const json = (s: string): Record<string, unknown> | null => {
  try { return record(JSON.parse(s)); } catch { return null; }
};
const validPr = (value: unknown, number: number, head: string): { base: string } | null => {
  const pr = record(value), prHead = record(pr?.head), prBase = record(pr?.base);
  if (pr?.number !== number || pr?.state !== 'open' || pr?.merged === true || prHead?.sha !== head
    || typeof prBase?.sha !== 'string' || !SHA.test(prBase.sha)) return null;
  return { base: prBase.sha };
};

/** Le dernier check par nom seul compte : un rerun vert annule un ancien timeout. */
export function nativeCiState(checks: readonly CiCheck[], head: string,
  required: readonly string[] = NATIVE_REQUIRED_CHECKS): { state: 'failed' | 'passed' | 'pending'; checkId: number } {
  const latest = new Map<string, CiCheck>();
  for (const check of checks) {
    if (!required.includes(check.name) || (check.head_sha && check.head_sha !== head)
      || !Number.isSafeInteger(check.id) || check.id <= 0) continue;
    if (!latest.has(check.name) || latest.get(check.name)!.id < check.id) latest.set(check.name, check);
  }
  const ci = latest.get('ci');
  if (!ci || ci.status !== 'completed') return { state: 'pending', checkId: 0 };
  if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(ci.conclusion ?? ''))
    return { state: 'failed', checkId: ci.id };
  if (ci.conclusion !== 'success') return { state: 'pending', checkId: ci.id };
  const passed = required.every(name => latest.get(name)?.status === 'completed'
    && latest.get(name)?.conclusion === 'success');
  return { state: passed ? 'passed' : 'pending', checkId: ci.id };
}

async function apply(db: D1Database, target: { cycle: string; task: string; owner: string; key: string;
  kind: 'correction.request' | 'run.reconcile'; payload_json: string; now: number; seenEventSeq: number }): Promise<boolean> {
  const existing = await db.prepare('SELECT seq FROM events WHERE idempotency_key=?1').bind(target.key).first();
  if (existing) return false;
  await assertAutomationRunning(db);
  const row = await db.prepare("SELECT revision FROM cycles WHERE cycle_id=?1 AND status='open'")
    .bind(target.cycle).first<{ revision: number }>();
  if (!row) return false;
  const rev = row.revision;
  // Un seul lot D1 ; un HALT, un changement d'auteur ou une autre soumission annule
  // l'intégralité de l'événement et de l'intention de réveil.
  const guard = [
    'INSERT INTO collab_store_guard(ok)',
    'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key=?2)',
    "AND EXISTS (SELECT 1 FROM cycles WHERE cycle_id=?1 AND revision=?3 AND status='open')",
    'AND NOT ' + HALT_ACTIVE_SQL,
    "AND EXISTS (SELECT 1 FROM tasks WHERE cycle_id=?1 AND task_id=?4 AND owner_pid=?5",
    "AND status NOT IN ('done','verified','blocked'))",
    // Aucun autre fait de la même tâche ne doit avoir été ajouté depuis nos lectures,
    // y compris une correction humaine ou une nouvelle soumission de l'auteur.
    "AND NOT EXISTS (SELECT 1 FROM events WHERE cycle_id=?1 AND seq>?6",
    "AND type IN ('correction.request','run.proof','run.reconcile') AND json_valid(payload_json)",
    "AND json_extract(payload_json,'$.task')=?4)",
    "AND NOT EXISTS (SELECT 1 FROM events WHERE cycle_id=?1 AND seq>?6",
    "AND type='evidence.add' AND participant_id=?5 AND json_valid(payload_json)",
    "AND json_extract(payload_json,'$.task')=?4)",
    'THEN 1 ELSE 0 END',
  ].join(' ');
  try {
    await db.batch([
      db.prepare(guard).bind(target.cycle, target.key, rev, target.task, target.owner, target.seenEventSeq),
      db.prepare([
        'INSERT INTO events(cycle_id,at,type,participant_id,session_id,role,payload_json,expected_rev,idempotency_key,evidence_ref)',
        "VALUES (?1,?2,?3,'agentrun','','server',?4,?5,?6,'')",
      ].join(' ')).bind(target.cycle,target.now,target.kind,target.payload_json,rev,target.key),
      db.prepare([
        'INSERT INTO agent_event_wake_intents',
        '(event_key,cycle_id,event_type,status,attempts,next_at,created_at,updated_at,last_error)',
        "VALUES (?1,?2,?3,'queued',0,?4,?4,?4,'')",
      ].join(' ')).bind(target.key,target.cycle,target.kind,target.now),
      db.prepare("INSERT INTO agent_event_wake_audit(event_key,at,kind) VALUES (?1,?2,'wake_queued')")
        .bind(target.key,target.now),
      db.prepare('UPDATE cycles SET revision=?2 WHERE cycle_id=?1 AND revision=?3').bind(target.cycle,rev+1,rev),
      expireDueHypotheses(db,target.cycle),
      db.prepare('DELETE FROM collab_store_guard'),
    ]);
  } catch {
    return false; // CAS ou HALT : ne jamais signaler une correction/reprise appliquée.
  }
  return true;
}

/**
 * Sur webhook GitHub signé : vérifie PR ouverte, HEAD SHA exact et checks natifs
 * relus via client GitHub read-only. Ne traite que les tâches déjà prouvées par
 * run.proof, jamais une autre tâche ou un avis D12.
 */
export async function reconcileNativeCi(db: D1Database, input: CiTransitionInput): Promise<CiTransitionResult> {
  const ignored = (reason: string): CiTransitionResult => ({ status: 'ignored', reason });
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !SHA.test(input.head)
    || !Number.isSafeInteger(input.number) || input.number < 1) return ignored('invalid_locator');
  await ensureSchema(db);
  let pr: { base: string } | null;
  let state: ReturnType<typeof nativeCiState>;
  try {
    pr = validPr(await input.reads.getPullRequest(input.repository,input.number),input.number,input.head);
    if (!pr) return ignored('pr_changed_or_closed');
    state = nativeCiState(await input.reads.listCheckRuns(input.repository,input.head),
      input.head,input.requiredChecks);
  } catch { return ignored('github_unavailable'); }
  if (state.state === 'pending') return ignored('ci_pending_or_unverified');
  const { results } = await db.prepare([
    'SELECT seq,cycle_id,payload_json FROM events WHERE type = ?1 AND participant_id = ?2',
    "AND json_valid(payload_json) AND json_extract(payload_json,'$.pr')=?3",
    "AND json_extract(payload_json,'$.head')=?4 AND json_extract(payload_json,'$.base')=?5",
    'ORDER BY seq DESC LIMIT 25',
  ].join(' ')).bind('run.proof','agentrun',input.number,input.head,pr.base).all<Proof>();
  for (const proof of results) {
    const p = json(proof.payload_json);
    if (!p || p.verified_success !== true || p.state !== 'RUN_PROVEN'
      || typeof p.task !== 'string' || typeof p.run_participant !== 'string') continue;
    const task = await db.prepare('SELECT owner_pid,status FROM tasks WHERE cycle_id=?1 AND task_id=?2')
      .bind(proof.cycle_id,p.task).first<Task>();
    if (!task || task.owner_pid !== p.run_participant
      || ['done','verified','blocked'].includes(task.status)) continue;
    const latest = await db.prepare([
      'SELECT seq,payload_json FROM events WHERE cycle_id=?1 AND type=?2',
      "AND json_valid(payload_json) AND json_extract(payload_json,'$.task')=?3 ORDER BY seq DESC LIMIT 1",
    ].join(' ')).bind(proof.cycle_id,'correction.request',p.task).first<Correction>();
    const latestSubmission = await db.prepare([
      'SELECT MAX(seq) AS seq FROM events WHERE cycle_id=?1 AND participant_id=?2',
      "AND type IN ('run.proof','run.reconcile') AND json_valid(payload_json)",
      "AND json_extract(payload_json,'$.task')=?3",
    ].join(' ')).bind(proof.cycle_id,'agentrun',p.task).first<{seq:number|null}>();
    const pending = !!latest && latest.seq > (latestSubmission?.seq ?? 0);
    const seenEventSeq = Math.max(proof.seq, latest?.seq ?? 0, latestSubmission?.seq ?? 0);
    if (state.state === 'failed') {
      if (pending) return ignored('existing_correction_pending');
      const payload = { task:p.task, origin:'github_native_ci', pr:input.number,
        head:input.head, base:pr.base, check_id:state.checkId,
        items:['La CI GitHub native a échoué au HEAD exact. Diagnostiquer puis corriger sur la branche/PR existantes, ou confirmer une CI verte au même SHA.'],
        reason:'CI native post-run échouée' };
      const result = await apply(db,{ cycle:proof.cycle_id,task:p.task,owner:task.owner_pid,
        key:['nativeci','fail',proof.cycle_id,p.task,input.head,String(state.checkId)].join(':'),
        kind:'correction.request',payload_json:JSON.stringify(payload),now:input.now,seenEventSeq });
      return result ? {status:'applied',kind:'correction.request',task:p.task,cycle:proof.cycle_id,payload_json:JSON.stringify(payload)}
        : ignored('duplicate_or_concurrent');
    }
    if (!pending) return ignored('no_pending_correction');
    const correction = json(latest!.payload_json);
    // Une correction humaine, un CHANGES_REQUESTED ou un changement de SHA ne
    // peuvent JAMAIS être clos par le seul feu vert d'une CI.
    if (correction?.origin !== 'github_native_ci' || correction.head !== input.head
      || correction.base !== pr.base || correction.pr !== input.number || latest!.seq <= proof.seq)
      return ignored('not_auto_ci_correction');
    const payload = { task:p.task,state:'CI_RECONCILED',run_participant:p.run_participant,
      pr:input.number,head:input.head,base:pr.base,verified_success:true,
      origin:'github_native_ci',prior_proof_seq:proof.seq,correction_seq:latest!.seq,
      check_id:state.checkId };
    const result = await apply(db,{cycle:proof.cycle_id,task:p.task,owner:task.owner_pid,
      key:['nativeci','green',proof.cycle_id,p.task,String(latest!.seq),input.head].join(':'),
      kind:'run.reconcile',payload_json:JSON.stringify(payload),now:input.now,seenEventSeq});
    return result ? {status:'applied',kind:'run.reconcile',task:p.task,cycle:proof.cycle_id,payload_json:JSON.stringify(payload)}
      : ignored('duplicate_or_concurrent');
  }
  return ignored('no_eligible_server_proof');
}

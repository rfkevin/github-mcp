/**
 * CC8 S7 durcissement — lot B, R4 (#282, issue mère #280) : preuve serveur d'une exécution API terminée.
 *
 * Constat (pilote Gemini n° 2, PR #279) : un run `completed/final` avec PR prête et CI verte n'écrivait
 * rien au store ; la demande de correction restait ouverte (`address_correction`) faute de soumission
 * de l'auteur. Le serveur ne doit pas pour autant écrire sous l'identité de l'auteur (D12).
 *
 * Ici, le serveur publie un événement `run.proof` :
 * - signé `participant_id = 'agentrun'`, `role = 'server'` ; type hors EVENT_TYPES : aucun agent ne
 *   peut le forger par collab_append_event (même principe que `correction.request`) ;
 * - seulement si : run implement `completed/final` sous mandat S7 ; garde de complétude #271 satisfaite
 *   sur les effets D1 et relevés serveur ; PR relue sur GitHub ouverte, non fusionnée, tête = SHA prouvé
 *   (base lue ici) ; participant du run = auteur (owner) de la tâche ; tâche non terminée ; aucune
 *   `correction.request` de la tâche postérieure à la création du run ; pas de HALT ;
 * - idempotent (`runproof:<run_id>`), sous CAS de révision du cycle, reprise bornée (agent_run_proofs).
 * Le contrôleur la compte comme SOUMISSION de l'auteur au couple head/base, jamais comme avis :
 * relecture et test restent des écritures indépendantes ; `merge_ready` exige leurs deux verdicts.
 * R3 : `scope: 'pilot_e2e_pass'` — parcours technique prouvé, pas acceptation fonctionnelle.
 */
import { expireDueHypotheses } from '../memory/hypothesis-expiry';
import { assertAutomationRunning, HALT_ACTIVE_SQL } from '../owner/automation';
import { CollabStoreError } from '../store/collab-store';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';
import { allCiPolls } from './ci-poll';
import { githubCompletionSatisfied, type GithubCompletionEffect, type ToolHost } from './engine';
import { ensureAgentRunSchema } from './schema';

export const RUN_PROOF_TYPE = 'run.proof';
export const RUN_PROOF_PARTICIPANT = 'agentrun';
export const RUN_PROOF_ROLE = 'server';
/** Tentatives de publication au plus (GitHub illisible, révision concurrente, store indisponible). */
export const RUN_PROOF_ATTEMPTS = 5;
/** Délai entre deux tentatives (alarme de l'objet). */
export const RUN_PROOF_RETRY_S = 60;
const STALE_RETRIES = 3;
const SHA = /^[a-f0-9]{40}$/;

export interface RunProofDeps {
  tools: ToolHost;
  githubCompletionGrants?: readonly { cycle: string; participant: string; task: string; branch: string }[];
  now: () => number;
}

export type RunProofOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'pending'; reason: string; attempts: number }
  | { status: 'refused'; reason: string }
  | { status: 'published'; event_seq: number };

interface RunRow { run_id: string; cycle_id: string; participant_id: string; task_id: string; task_kind: string;
  status: string; stop_reason: string; created_at: number }

/** Effets D1 et relevés de CI serveur dans l'ordre (n, idx, k), pour la garde #271. */
async function provenEffects(db: D1Database, runId: string): Promise<GithubCompletionEffect[]> {
  const { results } = await db.prepare('SELECT n, idx, tool, status, result FROM agent_run_effects WHERE run_id = ?1 ORDER BY n, idx')
    .bind(runId).all<{ n: number; idx: number; tool: string; status: string; result: string | null }>();
  const polls = await allCiPolls(db, runId);
  const ordered = [
    ...results.map(row => ({ key: [row.n, row.idx, -1], effect: { tool: row.tool, status: row.status, result: row.result } })),
    ...polls.map(poll => ({ key: [poll.n, poll.idx, poll.k], effect: { tool: 'github_check_result', status: 'completed', result: poll.result } })),
  ].sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return ordered.map(item => item.effect);
}

function lastOpenPr(effects: readonly GithubCompletionEffect[]): { number: number; head_sha: string } | null {
  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i];
    if (effect.tool !== 'github_open_pr' || effect.status !== 'completed' || !effect.result) continue;
    try {
      const value = JSON.parse(effect.result) as { number?: unknown; head_sha?: unknown };
      if (Number.isSafeInteger(value.number) && Number(value.number) > 0 && typeof value.head_sha === 'string' && SHA.test(value.head_sha)) {
        return { number: Number(value.number), head_sha: value.head_sha };
      }
    } catch { /* résultat illisible : pas une preuve */ }
    return null;
  }
  return null;
}

/** Identité logique (familles d'identités du store), comme le contrôleur. */
async function logical(db: D1Database, participantId: string): Promise<string> {
  const row = await db.prepare('SELECT family_id FROM participant_identity_families WHERE participant_id = ?1')
    .bind(participantId).first<{ family_id: string }>();
  return row?.family_id ?? participantId;
}

async function mark(db: D1Database, runId: string, status: 'pending' | 'refused' | 'published', reason: string, now: number,
  eventSeq: number | null = null, countAttempt = false): Promise<number> {
  await db.prepare([
    'INSERT INTO agent_run_proofs (run_id, status, attempts, reason, event_seq, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    'ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, event_seq = excluded.event_seq,',
    '  attempts = agent_run_proofs.attempts + ?3, updated_at = excluded.updated_at',
    "WHERE agent_run_proofs.status = 'pending'",
  ].join(' ')).bind(runId, status, countAttempt ? 1 : 0, reason.slice(0, 200), eventSeq, now).run();
  const row = await db.prepare('SELECT attempts FROM agent_run_proofs WHERE run_id = ?1').bind(runId).first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

/** Échec provisoire : une tentative de plus ; au-delà du plafond, refus définitif. */
async function retryLater(db: D1Database, runId: string, reason: string, now: number): Promise<RunProofOutcome> {
  const attempts = await mark(db, runId, 'pending', reason, now, null, true);
  if (attempts >= RUN_PROOF_ATTEMPTS) {
    await mark(db, runId, 'refused', 'attempts_exhausted:' + reason, now);
    return { status: 'refused', reason: 'attempts_exhausted:' + reason };
  }
  return { status: 'pending', reason, attempts };
}

async function refuse(db: D1Database, runId: string, reason: string, now: number): Promise<RunProofOutcome> {
  await mark(db, runId, 'refused', reason, now);
  return { status: 'refused', reason };
}

/**
 * Publie la preuve serveur d'un run terminé, ou explique pourquoi pas. Idempotent : un run déjà prouvé
 * (ou définitivement refusé) rend le même résultat sans nouvelle écriture.
 */
export async function publishRunProof(db: D1Database, runId: string, deps: RunProofDeps): Promise<RunProofOutcome> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const run = await db.prepare(
    'SELECT run_id, cycle_id, participant_id, task_id, task_kind, status, stop_reason, created_at FROM agent_runs WHERE run_id = ?1',
  ).bind(runId).first<RunRow>();
  if (!run || run.task_kind !== 'implement' || run.status !== 'completed' || run.stop_reason !== 'final') {
    return { status: 'skipped', reason: 'not_a_completed_implement_run' };
  }
  const grant = (deps.githubCompletionGrants ?? []).find(g => g.cycle === run.cycle_id && g.task === run.task_id
    && g.participant === run.participant_id);
  if (!grant) return { status: 'skipped', reason: 'no_s7_mandate' };
  const previous = await db.prepare('SELECT status, reason, event_seq FROM agent_run_proofs WHERE run_id = ?1')
    .bind(runId).first<{ status: string; reason: string; event_seq: number | null }>();
  if (previous?.status === 'published') return { status: 'published', event_seq: previous.event_seq ?? 0 };
  if (previous?.status === 'refused') return { status: 'refused', reason: previous.reason };
  const now = deps.now();

  // 1. Preuves D1 : garde #271 et dernière PR ouverte.
  const effects = await provenEffects(db, runId);
  if (!githubCompletionSatisfied(effects, grant.branch)) return refuse(db, runId, 'completion_evidence_missing', now);
  const pr = lastOpenPr(effects);
  if (!pr) return refuse(db, runId, 'pr_missing', now);

  // 2. Couple GitHub réel : PR relue maintenant (ouverte, non fusionnée, tête inchangée, base lue).
  let read: Record<string, unknown>;
  try {
    read = await deps.tools.execute({ id: 'srv-proof-' + runId, name: 'github_pull_request', args: { number: pr.number } },
      { run_id: runId }) as Record<string, unknown>;
  } catch {
    return retryLater(db, runId, 'github_unreadable', now);
  }
  const head = (read?.head ?? {}) as { sha?: unknown };
  const base = (read?.base ?? {}) as { sha?: unknown };
  if (read?.state !== 'open' || read?.merged === true) return refuse(db, runId, 'pr_not_open', now);
  if (head.sha !== pr.head_sha) return refuse(db, runId, 'pr_head_moved', now);
  if (typeof base.sha !== 'string' || !SHA.test(base.sha)) return retryLater(db, runId, 'pr_base_unreadable', now);
  const baseSha = base.sha;

  // 3. Tâche : existante, non terminée, auteur = participant du run ; aucune demande de correction postérieure.
  const task = await db.prepare('SELECT owner_pid, status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
    .bind(run.cycle_id, run.task_id).first<{ owner_pid: string; status: string }>();
  if (!task) return refuse(db, runId, 'task_unknown', now);
  if (task.status === 'done' || task.status === 'verified') return refuse(db, runId, 'task_closed', now);
  if (await logical(db, task.owner_pid) !== await logical(db, run.participant_id)) return refuse(db, runId, 'not_task_owner', now);
  const later = await db.prepare([
    "SELECT 1 AS x FROM events WHERE cycle_id = ?1 AND type = 'correction.request' AND json_valid(payload_json)",
    "AND json_extract(payload_json, '$.task') = ?2 AND at > ?3 LIMIT 1",
  ].join(' ')).bind(run.cycle_id, run.task_id, run.created_at).first();
  if (later) return refuse(db, runId, 'correction_after_run', now);
  // Époque du mandat de la demande à laquelle ce run répond (null : run sans demande de correction).
  const answered = await db.prepare([
    "SELECT json_extract(payload_json, '$.mandate_epoch') AS epoch FROM events WHERE cycle_id = ?1 AND type = 'correction.request'",
    "AND json_valid(payload_json) AND json_extract(payload_json, '$.task') = ?2 AND at <= ?3 ORDER BY seq DESC LIMIT 1",
  ].join(' ')).bind(run.cycle_id, run.task_id, run.created_at).first<{ epoch: number | null }>();
  const mandateEpoch = Number.isSafeInteger(answered?.epoch) ? Number(answered!.epoch) : null;

  // 4. Écriture gardée : HALT, révision, tâche toujours ouverte et du même auteur, pas de correction plus récente.
  const effectsHash = await sha256Hex(JSON.stringify(effects.map(e => [e.tool, e.status, e.result ?? ''])));
  const payload = { task: run.task_id, state: 'RUN_PROVEN', run_id: runId, run_participant: run.participant_id, mandate_epoch: mandateEpoch, pr: pr.number,
    head: pr.head_sha, base: baseSha, verified_success: true, effects_hash: effectsHash, scope: 'pilot_e2e_pass' };
  const key = 'runproof:' + runId;
  for (let attempt = 0; attempt < STALE_RETRIES; attempt++) {
    const existing = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
    if (existing) {
      await mark(db, runId, 'published', 'published', now, existing.seq);
      return { status: 'published', event_seq: existing.seq };
    }
    try {
      await assertAutomationRunning(db);
    } catch {
      // HALT : rien n'est écrit ; nouvel essai plus tard, sans consommer de tentative.
      await mark(db, runId, 'pending', 'halted', now);
      return { status: 'pending', reason: 'halted', attempts: 0 };
    }
    const cycle = await db.prepare("SELECT revision FROM cycles WHERE cycle_id = ?1 AND status = 'open'").bind(run.cycle_id)
      .first<{ revision: number }>();
    if (!cycle) return refuse(db, runId, 'cycle_closed', now);
    // ?1 cycle, ?2 clé, ?3 révision, ?4 tâche, ?5 auteur (brut), ?6 création du run.
    const guard = [
      'INSERT INTO collab_store_guard (ok)',
      'SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM events WHERE idempotency_key = ?2)',
      "AND EXISTS (SELECT 1 FROM cycles WHERE cycle_id = ?1 AND revision = ?3 AND status = 'open')",
      'AND NOT ' + HALT_ACTIVE_SQL,
      "AND EXISTS (SELECT 1 FROM tasks WHERE cycle_id = ?1 AND task_id = ?4 AND owner_pid = ?5 AND status NOT IN ('done', 'verified'))",
      "AND NOT EXISTS (SELECT 1 FROM events WHERE cycle_id = ?1 AND type = 'correction.request' AND json_valid(payload_json)",
      "  AND json_extract(payload_json, '$.task') = ?4 AND at > ?6)",
      'THEN 1 ELSE 0 END',
    ].join(' ');
    try {
      await db.batch([
        db.prepare(guard).bind(run.cycle_id, key, cycle.revision, run.task_id, task.owner_pid, run.created_at),
        db.prepare([
          'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
          "VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, ?7, ?8, '')",
        ].join(' ')).bind(run.cycle_id, now, RUN_PROOF_TYPE, RUN_PROOF_PARTICIPANT, RUN_PROOF_ROLE, JSON.stringify(payload), cycle.revision, key),
        db.prepare('UPDATE cycles SET revision = ?2 WHERE cycle_id = ?1 AND revision = ?3').bind(run.cycle_id, cycle.revision + 1, cycle.revision),
        expireDueHypotheses(db, run.cycle_id),
        db.prepare('DELETE FROM collab_store_guard'),
      ]);
    } catch (error) {
      if (error instanceof CollabStoreError) throw error;
      // Garde à 0 : rejeu gagnant, révision concurrente, HALT ou tâche changée — relire et réessayer (borné).
      continue;
    }
    const event = await db.prepare('SELECT seq FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number }>();
    await mark(db, runId, 'published', 'published', now, event?.seq ?? null);
    return { status: 'published', event_seq: event?.seq ?? 0 };
  }
  return retryLater(db, runId, 'store_conflict', now);
}

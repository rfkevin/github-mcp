/**
 * CC-7 L5b (S10) — `store_verdict` : dépôt de verdict D12 contrôlé serveur
 * pour les exécutions API de relecture (`review`) et de test (`test`).
 *
 * Sept contrôles serveur, dans cet ordre
 * (docs/collaboration/cc7/l5b-store-verdict.md) :
 * ① type du run (review ou test seulement) et décision du vocabulaire du type ;
 * ② participant enregistré et actif (participants.status) ;
 * ③ tâche connue du cycle (rôles relus dans tasks) ;
 * ④ identité logique de l'émetteur = vérificateur attendu du type, et distincte
 *    de celle de l'auteur (D12, SELF_REVIEW, familles #126) ;
 * ⑤ couple exact relu sur GitHub : PR connue, ouverte, head et base identiques ;
 * ⑥ CI du head entièrement verte (listCheckRuns) ;
 * ⑦ preuve de lecture `github_diff` au head dans agent_run_reads.
 *
 * L'événement evidence.add est écrit par le SERVEUR (appendEvent, rôle reviewer
 * ou tester), jamais repris depuis les arguments du modèle ; `evidence.add`
 * libre reste interdit au canal API (API_AGENT_FORBIDDEN, L3b). op_id
 * déterministe : le même verdict (type, cycle, participant, tâche, couple,
 * décision) rejoué rend duplicate ; le même tuple avec un autre texte libre est
 * IDEMPOTENCY_CONFLICT (garde du store) ; une autre décision est un verdict
 * distinct légitime.
 */
import { StateContractError } from '../../collab/contracts';
import { opIdClientFor } from '../contracts/phases';
import { CollabStore, CollabStoreError } from '../store/collab-store';
import { assertNotSelfReview, logicalIdentityOf } from '../identity/families';
import { sha256Hex } from '../store/hash';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';
import type { GitHubReads } from './read-tools';

/** Types de run autorisés à déposer un verdict (S10) ; tout autre type est refusé. */
export type VerdictTaskKind = 'review' | 'test';

/** États D12 acceptés par type : relecture (AGREE, CHANGES_REQUESTED) et test (PASS, FAIL). */
export const VERDICT_STATES: Readonly<Record<VerdictTaskKind, readonly string[]>> = Object.freeze({
  review: Object.freeze(['AGREE', 'CHANGES_REQUESTED']),
  test: Object.freeze(['PASS', 'FAIL']),
});

/** Texte libre accompagnant le verdict (constats, risques, prochaine action proposée). */
export const VERDICT_REVIEW_MAX_CHARS = 4000;

/** Réessais bornés sur STALE (rien n'est écrit sur STALE) avant un refus certain. */
const STALE_RETRIES = 3;
const SHA_RE = /^[a-f0-9]{40}$/;
const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const VERDICT_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_verdict', description: 'Déposer votre verdict de relecture ou de test sur la soumission exacte que vous avez relue (task, pr, head, base). Le serveur re-vérifie le couple, la CI et vos lectures avant d’écrire.',
    parameters: { type: 'object', properties: {
      task: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
      pr: { type: 'integer', minimum: 1, maximum: 100000000 },
      head: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      base: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      state: { type: 'string', enum: ['AGREE', 'CHANGES_REQUESTED', 'PASS', 'FAIL'] },
      review: { type: 'string', maxLength: 4000 },
    }, required: ['task', 'pr', 'head', 'base', 'state'], additionalProperties: false } },
]);

/**
 * op_id déterministe du verdict : le même tuple (type, cycle, participant,
 * tâche, couple, décision) donne la même clé d'idempotence ; le texte libre est
 * exclu (un autre texte sur le même tuple reste IDEMPOTENCY_CONFLICT au store).
 */
export async function verdictOpId(kind: VerdictTaskKind, cycleId: string, participantId: string,
  taskId: string, pr: number, head: string, base: string, decision: string): Promise<string> {
  let client: string;
  try {
    client = opIdClientFor(participantId);
  } catch {
    throw new ToolRefused('INVALID_OP_ID');
  }
  const fingerprint = (await sha256Hex([kind, cycleId, participantId, taskId, String(pr), head, base, decision].join('\u001f'))).slice(0, 32);
  return client + ':' + cycleId + ':api-verdict-' + fingerprint + ':1';
}

interface VerdictArgs { task: string; pr: number; head: string; base: string; state: string; review: string }

export interface VerdictToolHostOptions {
  db: D1Database;
  repository: string;
  github: GitHubReads;
}

export interface VerdictTools {
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown>;
  lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

function parseVerdictArgs(kind: VerdictTaskKind, args: Record<string, unknown>): VerdictArgs {
  const task = args.task;
  const pr = args.pr;
  const head = args.head;
  const base = args.base;
  const state = args.state;
  const review = args.review ?? '';
  if (typeof task !== 'string' || !TASK_RE.test(task)
    || typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1 || pr > 100_000_000
    || typeof head !== 'string' || !SHA_RE.test(head)
    || typeof base !== 'string' || !SHA_RE.test(base)
    || typeof review !== 'string' || review.length > VERDICT_REVIEW_MAX_CHARS) {
    throw new ToolRefused('VERDICT_ARGS_INVALID');
  }
  // ① : la décision doit être du vocabulaire du type du run ; hors vocabulaire = refus de type.
  if (typeof state !== 'string' || !VERDICT_STATES[kind].includes(state)) {
    throw new ToolRefused('VERDICT_KIND_FORBIDDEN');
  }
  return { task, pr, head, base, state, review };
}

export function createVerdictTools(options: VerdictToolHostOptions): VerdictTools {
  interface RunScope { cycle_id: string; participant_id: string; task_kind: string }
  async function scope(runId: string): Promise<RunScope> {
    const run = await options.db.prepare('SELECT cycle_id, participant_id, task_kind FROM agent_runs WHERE run_id = ?1')
      .bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function verdictOf(call: ToolCall, runId: string): Promise<{ seq: number; type: string; status: string }> {
    // ① Type du run : seuls review et test portent un verdict (implement, answer… refusés).
    const { cycle_id, participant_id, task_kind } = await scope(runId);
    if (task_kind !== 'review' && task_kind !== 'test') throw new ToolRefused('VERDICT_KIND_FORBIDDEN');
    const kind = task_kind;
    const args = parseVerdictArgs(kind, call.args ?? {});
    // ② Participant enregistré et actif.
    const participant = await options.db.prepare('SELECT status FROM participants WHERE participant_id = ?1')
      .bind(participant_id).first<{ status: string }>();
    if (!participant || participant.status !== 'active') throw new ToolRefused('UNREGISTERED_PARTICIPANT');
    // ③ Tâche connue du cycle ; ① rôles : l'émetteur doit être le vérificateur attendu du type (identité logique).
    const taskRow = await options.db.prepare('SELECT owner_pid, reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
      .bind(cycle_id, args.task).first<{ owner_pid: string; reviewer_pid: string; tester_pid: string }>();
    if (!taskRow) throw new ToolRefused('TASK_UNKNOWN');
    const expected = kind === 'review' ? taskRow.reviewer_pid : taskRow.tester_pid;
    if (await logicalIdentityOf(options.db, participant_id) !== await logicalIdentityOf(options.db, expected)) {
      throw new ToolRefused('VERDICT_ROLE_FORBIDDEN');
    }
    // ④ D12 : un verdict ne porte jamais sur la soumission de sa propre identité logique (familles #126).
    await assertNotSelfReview(options.db, participant_id, taskRow.owner_pid);
    // ⑤ Couple exact relu sur GitHub : PR connue, ouverte, au couple fourni, pas fusionnée.
    const pull = await options.github.getPullRequest(options.repository, args.pr) as Record<string, unknown> | null;
    if (!pull) throw new ToolRefused('VERDICT_PR_UNKNOWN');
    const prHead = ((pull.head ?? {}) as Record<string, unknown>).sha;
    const prBase = ((pull.base ?? {}) as Record<string, unknown>).sha;
    if (prHead !== args.head || prBase !== args.base || pull.merged === true || pull.state === 'closed') {
      throw new ToolRefused('VERDICT_COUPLE_MISMATCH');
    }
    // ⑥ CI du head entièrement verte : au moins un contrôle, tous terminés avec succès.
    const checks = await options.github.listCheckRuns(options.repository, args.head) as Array<Record<string, unknown>>;
    if (checks.length === 0 || checks.some(check => check.status !== 'completed' || check.conclusion !== 'success')) {
      throw new ToolRefused('VERDICT_CI_NOT_GREEN');
    }
    // ⑦ Preuve de lecture : github_diff au head par CETTE exécution (journal S10).
    const proof = await options.db.prepare(
      "SELECT effect_key FROM agent_run_reads WHERE run_id = ?1 AND tool = 'github_diff' AND ref_sha = ?2 AND status = 'completed'",
    ).bind(runId, args.head).first<{ effect_key: string }>();
    if (!proof) throw new ToolRefused('VERDICT_READ_PROOF_MISSING');
    // Écriture serveur : evidence.add avec rôle reviewer/tester, idempotence déterministe, boucle STALE bornée.
    const store = new CollabStore(options.db);
    const opId = await verdictOpId(kind, cycle_id, participant_id, args.task, args.pr, args.head, args.base, args.state);
    const payload = { task: args.task, source: 'github', pr: args.pr, head: args.head, base: args.base,
      state: args.state, ...(args.review ? { review: args.review } : {}) };
    let expected_rev = await store.currentRevision(cycle_id);
    for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
      let outcome;
      try {
        outcome = await store.appendEvent({ cycle_id, type: 'evidence.add', participant_id, expected_rev,
          payload_json: JSON.stringify(payload), op_id: opId, role: kind === 'review' ? 'reviewer' : 'tester' });
      } catch (error) {
        // Refus typé du store ou du contrat (rôles, cycle clos, idempotence, payload…) : certain, rien n'est écrit.
        if (error instanceof CollabStoreError || error instanceof StateContractError) {
          throw new ToolRefused(error.code);
        }
        throw error;
      }
      if (outcome.status === 'stale') { expected_rev = outcome.currentRevision; continue; }
      if (outcome.status === 'quota_exhausted') throw new ToolRefused('QUOTA_EXHAUSTED');
      return { seq: outcome.event.seq, type: 'evidence.add', status: outcome.status };
    }
    throw new ToolRefused('STALE');
  }
  return {
    async execute(call, ctx) {
      if (!ctx.effect_key) throw new ToolRefused('effect_key_required');
      return await verdictOf(call, ctx.run_id);
    },
    async lookup(call, ctx) {
      // Cherche l'événement par sa clé d'idempotence avant tout réessai (contrat d'hôte 7a).
      const { cycle_id, participant_id, task_kind } = await scope(ctx.run_id);
      if (task_kind !== 'review' && task_kind !== 'test') return { found: false };
      const args = call.args ?? {};
      const task = typeof args.task === 'string' && TASK_RE.test(args.task) ? args.task : null;
      const pr = typeof args.pr === 'number' && Number.isSafeInteger(args.pr) && args.pr >= 1 && args.pr <= 100_000_000 ? args.pr : null;
      const head = typeof args.head === 'string' && SHA_RE.test(args.head) ? args.head : null;
      const base = typeof args.base === 'string' && SHA_RE.test(args.base) ? args.base : null;
      const state = typeof args.state === 'string' && VERDICT_STATES[task_kind].includes(args.state) ? args.state : null;
      if (!task || !pr || !head || !base || !state) return { found: false };
      const opId = await verdictOpId(task_kind, cycle_id, participant_id, task, pr, head, base, state);
      const row = await options.db.prepare('SELECT seq, type FROM events WHERE idempotency_key = ?1')
        .bind('op:' + opId).first<{ seq: number; type: string }>();
      return row ? { found: true, result: { seq: row.seq, type: row.type, status: 'duplicate' } } : { found: false };
    },
  };
}

import { ToolRefused, type LookupResult, type ToolCall } from '../engine';
import { createGitHubWriteTools, apiBranch, type GitHubWriteToolsOptions } from '../github-tools';
import type { GitHubReads } from '../read-tools';
import type { ToolSchema } from '../workers-ai-model';
import { authorize, assertPaths, exactGrant, type WritePolicy, type WriteScope } from './authorization';
import { MAX_EDITS, normalizeEdits, replaceOnce } from './edits';
import { functionalTestCause, missionOf } from '../mission-quality';
import { PRECHECK_HINTS } from '../s7-guided';
import { reserveCommit, finishCommit, recordCheck, correctionsUsed, releaseReservation } from './progress';

export interface ApiChecks {
  start(sha: string): Promise<{ runId: number; targetSha: string; [key: string]: unknown }>;
  lookup(sha: string): Promise<LookupResult>;
  result(sha: string, runId: number): Promise<{ targetSha: string; status: string | null; conclusion: string | null; verifiedSuccess: boolean; [key: string]: unknown }>;
}
export interface S7Options { policy: WritePolicy; reads: GitHubReads | null; checks: ApiChecks | null }
const SHA = /^[a-f0-9]{40}$/;
const common = { name: { type: 'string' }, sha: { type: 'string', pattern: SHA.source } };
export const S7_SCHEMAS: readonly ToolSchema[] = [
  { name: 'github_write_scope', description: 'Lire votre mandat serveur et ses critères d’acceptation : mission, acceptance, branche, nom, chemins, SHA actuel de la base et corrections restantes. Utiliser base_sha pour github_create_branch, jamais un SHA de fichier. La mission est également lisible dans le store (task.next_action), sans accorder de nouvelles permissions.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'github_replace_text', description: 'Remplacement littéral unique au head/blob exacts, dans votre tâche. Une édition (path, expected_sha, old_text, new_text) ou un tableau edits (' + MAX_EDITS + ' au plus, fichiers distincts) appliqué en UN SEUL commit. Une correction est autorisée après une CI rouge, sans plafond de corrections par mission.',
    parameters: { type: 'object', properties: { name: common.name, expected_head_sha: common.sha, message: { type: 'string' }, path: { type: 'string' }, expected_sha: common.sha,
      old_text: { type: 'string' }, new_text: { type: 'string' },
      edits: { type: 'array', minItems: 1, maxItems: MAX_EDITS, items: { type: 'object', properties: { path: { type: 'string' }, expected_sha: common.sha, old_text: { type: 'string' }, new_text: { type: 'string' } },
        required: ['path','expected_sha','old_text','new_text'], additionalProperties: false } } },
      required: ['name','expected_head_sha','message'], additionalProperties: false } },
  { name: 'github_run_checks', description: 'Lancer le contrôleur Actions approuvé, périmètre full, au SHA actuel de votre branche. Refus contrôleur = escalade, jamais contournement.',
    parameters: { type: 'object', properties: common, required: ['name','sha'], additionalProperties: false } },
  { name: 'github_check_result', description: 'Lire la CI corrélée à votre SHA, avec diagnostics bornés. Rouge : corriger puis relancer la CI jusqu’à résolution.',
    parameters: { type: 'object', properties: { ...common, run_id: { type: 'integer', minimum: 1 } }, required: ['name','sha','run_id'], additionalProperties: false } },
];
type Context = { run_id: string; effect_key?: string };

/**
 * CC8 U2a (B1, B2) : gardes de COMMIT, communes au mode guidé et au mode libre, avant toute réservation.
 * B1 : mission fonctionnelle, même fonction que la prévalidation guidée (tests désactivés, sans import du
 *      dépôt ou tautologiques refusés). B2 : un commit sans aucun changement brûlerait une des 3 corrections.
 * ToolRefused = rien d'écrit ni réservé ; le message porte la cause typée et son indice.
 */
async function commitGuards(s: WriteScope, reads: GitHubReads | null, repository: string, sha: string,
  changes: readonly { path?: unknown; content?: unknown }[]): Promise<void> {
  const files = changes.map(change => ({ path: String(change?.path ?? ''), content: typeof change?.content === 'string' ? change.content : '' }));
  if (missionOf(s).kind === 'functional') {
    const cause = functionalTestCause(files);
    if (cause) throw new ToolRefused(cause + ' : ' + (PRECHECK_HINTS[cause] ?? ''));
  }
  // B2 is a security boundary: failed reads cannot establish a real diff.
  // Only a typed 404 from the canonical GitHub tree reader proves a new path;
  // timeouts, 403/429/503, corrupt blobs and absent readers MUST fail closed.
  if (!reads) throw new ToolRefused('api_write_read_unavailable : lecture GitHub requise avant toute réservation de commit.');
  let changed = false;
  for (const file of files) {
    try {
      if ((await reads.getTextFile(repository, file.path, sha)).content !== file.content) changed = true;
    } catch (error) {
      // A blob fetch may also return 404 for an existing path: only the
      // canonical missing-tree-entry sentinel proves a file is new.
      // No direct /github/ import from the collab store (CC3 boundary).
      // Match the canonical typed tree-miss error by its complete stable shape;
      // an HTTP 404 from a blob fetch, a different endpoint, or an ordinary
      // Error('404') must NOT authorize a write.
      const cause = error as { name?: unknown; status?: unknown; endpoint?: unknown; message?: unknown } | null;
      if (error instanceof Error && cause?.name === 'GitHubApiError' && cause.status === 404
        && cause.endpoint === '/git/trees' && cause.message === 'Fichier introuvable.') {
        changed = true; // Verified missing tree entry, not a missing blob.
        continue;
      }
      throw new ToolRefused('api_write_read_failed : comparaison au head impossible ; commit refusé sans réservation.');
    }
  }
  if (!changed) throw new ToolRefused('api_write_no_change : le commit ne change aucun fichier à la tête ' + sha + ' ; proposez un diff réel.');
}

export function createS7Tools(options: GitHubWriteToolsOptions, s7: S7Options) {
  const legacy = createGitHubWriteTools(options);
  async function scope(call: ToolCall, ctx: Context) {
    const run = await options.db.prepare('SELECT participant_id FROM agent_runs WHERE run_id=?1').bind(ctx.run_id).first<{ participant_id: string }>();
    if (!run) throw new ToolRefused('unknown_run');
    const branch = apiBranch(run.participant_id, call.args?.name);
    return authorize(options.db, s7.policy, ctx.run_id, branch);
  }
  async function head(branch: string, sha: unknown): Promise<string> {
    if (typeof sha !== 'string' || !SHA.test(sha)) throw new ToolRefused('api_write_sha_invalid');
    if (await options.writes.branchHead(options.repository, branch) !== sha) throw new ToolRefused('api_write_head_changed');
    return sha;
  }
  async function execute(call: ToolCall, ctx: Context): Promise<unknown> {
    if (!ctx.effect_key || !/^[a-f0-9]{64}$/.test(ctx.effect_key)) throw new ToolRefused('effect_key_required');
    if (call.name === 'github_write_scope') {
      const run = await options.db.prepare('SELECT participant_id,cycle_id,task_id FROM agent_runs WHERE run_id=?1').bind(ctx.run_id).first<{participant_id:string;cycle_id:string;task_id:string}>();
      if (!run) throw new ToolRefused('unknown_run');
      const grant = await exactGrant(options.db,s7.policy,run.cycle_id,run.task_id,run.participant_id);
      if (!grant) throw new ToolRefused('api_task_not_enabled');
      const allowed = await authorize(options.db, s7.policy, ctx.run_id, grant.branch);
      // Expose the authoritative base commit, not a file blob SHA. The subsequent
      // github_create_branch still applies GitHub's expected-base CAS if it moves.
      const baseSha = await options.writes.branchHead(options.repository, options.baseBranch);
      if (!baseSha || !SHA.test(baseSha)) throw new ToolRefused('api_base_head_unavailable');
      // CC8 S7 mode guidé : tête actuelle de la branche du mandat (null si elle n'existe pas encore), lue par le serveur.
      const branchHead = await options.writes.branchHead(options.repository, allowed.branch);
      return { branch: allowed.branch, name: allowed.branch.split('-api-')[1], base_branch: options.baseBranch, base_sha: baseSha,
        branch_head: branchHead && SHA.test(branchHead) ? branchHead : null,
        granted_paths: allowed.paths, task_paths: allowed.owned_paths, mission: allowed.mission ?? 'pilot',
        acceptance: allowed.acceptance ?? [], corrections_completed: await correctionsUsed(options.db, allowed) };
    }
    const s = await scope(call, ctx);
    const args = call.args ?? {};
    let target = call;
    if (call.name === 'github_replace_text') {
      if (!s7.reads) throw new ToolRefused('api_edit_unavailable');
      const edits = normalizeEdits(args);
      assertPaths(s, edits.map(edit => edit.path));
      const sha = await head(s.branch, args.expected_head_sha);
      const files: { path: string; content: string; expected_sha: string }[] = [];
      for (const edit of edits) {
        const file = await s7.reads.getTextFile(options.repository, edit.path, sha);
        if (file.sha !== edit.expected_sha) throw new ToolRefused('api_edit_blob_changed');
        files.push({ path: edit.path, content: replaceOnce(file.content, edit.old_text, edit.new_text), expected_sha: file.sha });
      }
      target = { id: call.id, name: 'github_commit_files', args: { name: args.name, expected_head_sha: sha, message: args.message, files } };
    }
    if (target.name === 'github_commit_files') {
      const changes = target.args?.files;
      if (!Array.isArray(changes)) throw new ToolRefused('api_write_files_invalid');
      assertPaths(s, changes.map(f => String(f?.path ?? '')));
      const sha = await head(s.branch, target.args?.expected_head_sha);
      await commitGuards(s, s7.reads, options.repository, sha, changes);
      await reserveCommit(options.db, s, ctx.effect_key, sha);
      let result: { commit_sha: string };
      try {
        assertPaths(await scope(call, ctx), changes.map(f => String(f?.path ?? '')));
        result = await legacy.execute(target, ctx) as { commit_sha: string };
      } catch (error) {
        // ToolRefused guarantees no external write; transport errors retain the reservation.
        if (error instanceof ToolRefused) await releaseReservation(options.db, ctx.effect_key);
        throw error;
      }
      await finishCommit(options.db, ctx.effect_key, result.commit_sha);
      return { ...result, next_action: 'github_run_checks', corrections_completed: await correctionsUsed(options.db, s) };
    }
    if (call.name === 'github_run_checks' || call.name === 'github_check_result') {
      if (!s7.checks) throw new ToolRefused('api_checks_not_enabled');
      const sha = await head(s.branch, args.sha);
      if (call.name === 'github_run_checks') {
        await scope(call, ctx);
        return s7.checks.start(sha);
      }
      if (!Number.isSafeInteger(args.run_id) || Number(args.run_id) <= 0) throw new ToolRefused('api_check_id_invalid');
      const result = await s7.checks.result(sha, Number(args.run_id));
      if (result.targetSha !== sha) throw new ToolRefused('api_check_target_mismatch');
      await head(s.branch, sha);
      await scope(call, ctx);
      const failed = result.status === 'completed' && ['failure','timed_out','action_required','startup_failure'].includes(result.conclusion ?? '');
      const state = result.verifiedSuccess ? 'passed' : failed ? 'failed' : 'pending';
      await recordCheck(options.db, s, sha, Number(args.run_id), state);
      return { ...result, next_action: failed ? 'correct' : result.verifiedSuccess ? 'request_D12' : 'wait', next_poll_seconds: state === 'pending' ? 15 : null };
    }
    return legacy.execute(call, ctx);
  }
  return {
    names(kind: string): readonly string[] { return kind === 'implement'
      ? [...legacy.names(kind), ...S7_SCHEMAS.filter(s => !['github_run_checks','github_check_result'].includes(s.name) || s7.checks !== null).map(s => s.name)]
      : []; }, // Unified C0 host derives its catalogue from verified resources and roles instead.
    execute,
    async lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult> {
      // Reconciliation is read-only externally, allowed after authorization revocation.
      if (call.name === 'github_run_checks') return s7.checks?.lookup(String(call.args?.sha ?? '')) ?? null;
      if (call.name === 'github_write_scope') return { found: false };
      if (call.name === 'github_check_result') return { found: false }; // Re-read and record idempotently on retry.
      const target = call.name === 'github_replace_text' ? { ...call, name: 'github_commit_files' } : call;
      const result = await legacy.lookup(target, ctx);
      if (result?.found && target.name === 'github_commit_files') {
        const value = result.result as { commit_sha?: string };
        if (value.commit_sha) await finishCommit(options.db, ctx.effect_key, value.commit_sha);
      }
      return result;
    },
  };
}

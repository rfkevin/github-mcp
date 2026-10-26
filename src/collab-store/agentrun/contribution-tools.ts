/**
 * CC-7 L6b (incrément 2, plan CC-PLAN-7 v0.2 S9) — `store_contribute` : le canal API
 * dépose la sortie attendue d'une phase de conception (proposition P1, critique P2,
 * synthèse P3, vote P4), exactement comme le ferait le chat du participant.
 *
 * Le serveur décide de TOUT ce qui compte, jamais le modèle :
 * - le type de l'exécution doit être `design` (réveil `contribute` du contrôleur) ;
 * - la sortie visée est relue dans la phase courante (inspectPhase) : elle doit être
 *   NON satisfaite, et l'identité logique du participant doit en être un titulaire
 *   manquant sur la tâche nommée — sinon CONTRIBUTION_NOT_EXPECTED ;
 * - le type d'événement (proposal.submit ou evidence.add) et le rôle (author,
 *   reviewer, tester) viennent de la définition de phase installée par Kevin ;
 * - une contribution evidence.add porte un état du vocabulaire de conception
 *   (AGREE, AMEND, OBJECTION) et un texte ; elle ne cite jamais de PR, de head ni de
 *   base : ce n'est pas un verdict D12 (ceux-là passent par store_verdict, L5b) ;
 * - écriture par le serveur (appendEvent), op_id dérivé de la clé d'effet du moteur
 *   (rejeu = duplicate), mêmes gardes du store (rôles, scellé P1, cycle clos, quota, CAS).
 */
import { StateContractError } from '../../collab/contracts';
import { CollabStore, CollabStoreError } from '../store/collab-store';
import { logicalIdentityOf } from '../identity/families';
import { inspectPhase } from '../phases/engine';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import { effectOpId } from './store-tools';
import type { ToolSchema } from './workers-ai-model';

/** Type d'exécution API des réveils `contribute` (proposer, critiquer, synthétiser, voter). */
export const CONTRIBUTION_TASK_KIND = 'design';
/** États d'une critique ou d'un vote de conception ; OBJECTION est toujours permise (elle bloque l'avance). */
export const CONTRIBUTION_STATES: readonly string[] = Object.freeze(['AGREE', 'AMEND', 'OBJECTION']);
export const CONTRIBUTION_CONTENT_MAX = 20_000;
export const CONTRIBUTION_REVIEW_MAX = 8_000;

const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const STALE_RETRIES = 3;

export const CONTRIBUTION_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_contribute', description: 'Déposer la sortie attendue de la phase courante sur votre tâche : proposition ou synthèse (content), ou critique / vote (state AGREE, AMEND ou OBJECTION, et review). Le serveur vérifie que cette sortie vous est bien demandée.',
    parameters: { type: 'object', properties: {
      task: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
      content: { type: 'string', maxLength: CONTRIBUTION_CONTENT_MAX },
      state: { type: 'string', enum: ['AGREE', 'AMEND', 'OBJECTION'] },
      review: { type: 'string', maxLength: CONTRIBUTION_REVIEW_MAX },
    }, required: ['task'], additionalProperties: false } },
]);

export interface ContributionTools {
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown>;
  lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

interface RunScope { cycle_id: string; participant_id: string; task_kind: string }

function textArg(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ToolRefused('CONTRIBUTION_ARGS_INVALID');
  }
  return value;
}

export function createContributionTools(db: D1Database): ContributionTools {
  async function scope(runId: string): Promise<RunScope> {
    const run = await db.prepare('SELECT cycle_id, participant_id, task_kind FROM agent_runs WHERE run_id = ?1')
      .bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function contribute(call: ToolCall, runId: string, effectKey: string) {
    const { cycle_id, participant_id, task_kind } = await scope(runId);
    if (task_kind !== CONTRIBUTION_TASK_KIND) throw new ToolRefused('CONTRIBUTION_KIND_FORBIDDEN');
    // Rejeu de la même clé d'effet : l'événement d'origine, avant toute relecture de phase
    // (la sortie est alors déjà produite et ne serait plus « attendue »).
    const opId = effectOpId(participant_id, cycle_id, effectKey);
    const prior = await db.prepare('SELECT seq, type FROM events WHERE idempotency_key = ?1').bind('op:' + opId).first<{ seq: number; type: string }>();
    if (prior) return { seq: prior.seq, type: prior.type, status: 'duplicate' };
    const args = call.args ?? {};
    const task = args.task;
    if (typeof task !== 'string' || !TASK_RE.test(task)) throw new ToolRefused('CONTRIBUTION_ARGS_INVALID');
    // La sortie demandée est relue côté serveur dans la phase courante (jamais déduite des arguments).
    const facts = await inspectPhase(db, cycle_id);
    const who = await logicalIdentityOf(db, participant_id);
    const output = facts.outputs.find(candidate => !candidate.satisfied && !candidate.producers.includes(who)
      && candidate.holders.some(holder => holder.who === who && holder.task_id === task));
    if (!output) throw new ToolRefused('CONTRIBUTION_NOT_EXPECTED');
    let type: 'proposal.submit' | 'evidence.add';
    let payload: Record<string, unknown>;
    if (output.kind === 'proposal.submit') {
      type = 'proposal.submit';
      payload = { task, content: textArg(args, 'content', CONTRIBUTION_CONTENT_MAX) };
    } else if (output.kind === 'evidence.add') {
      const state = args.state;
      if (typeof state !== 'string' || !CONTRIBUTION_STATES.includes(state)) throw new ToolRefused('CONTRIBUTION_STATE_INVALID');
      type = 'evidence.add';
      payload = { task, source: 'api-contribution:' + facts.phase, state, review: textArg(args, 'review', CONTRIBUTION_REVIEW_MAX) };
    } else {
      throw new ToolRefused('CONTRIBUTION_KIND_UNSUPPORTED');
    }
    const store = new CollabStore(db);
    let expected = await store.currentRevision(cycle_id);
    for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
      let outcome;
      try {
        outcome = await store.appendEvent({ cycle_id, type, participant_id, expected_rev: expected,
          payload_json: JSON.stringify(payload), op_id: opId, role: output.role });
      } catch (error) {
        // Refus typé du store ou du contrat : certain, rien n'est écrit.
        if (error instanceof CollabStoreError || error instanceof StateContractError) throw new ToolRefused(error.code);
        throw error;
      }
      if (outcome.status === 'stale') { expected = outcome.currentRevision; continue; }
      if (outcome.status === 'quota_exhausted') throw new ToolRefused('QUOTA_EXHAUSTED');
      return { seq: outcome.event.seq, type, phase: facts.phase, status: outcome.status };
    }
    throw new ToolRefused('STALE');
  }
  return {
    async execute(call, ctx) {
      if (!ctx.effect_key) throw new ToolRefused('effect_key_required');
      return await contribute(call, ctx.run_id, ctx.effect_key);
    },
    async lookup(_call, ctx) {
      const { cycle_id, participant_id } = await scope(ctx.run_id);
      const key = 'op:' + effectOpId(participant_id, cycle_id, ctx.effect_key);
      const row = await db.prepare('SELECT seq, type FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number; type: string }>();
      return row ? { found: true, result: { seq: row.seq, type: row.type, status: 'duplicate' } } : { found: false };
    },
  };
}

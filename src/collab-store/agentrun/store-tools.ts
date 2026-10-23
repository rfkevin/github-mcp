/**
 * CC-5 l7 (incrément 7c-2) — outils d'ÉCRITURE dans le store pour les exécutions API.
 *
 * Seules écritures autorisées au canal API (plan de clôture v1.1, amendement A2) :
 * poser une question (clarify.ask), répondre à une question (clarify.answer) et
 * signaler l'avancement d'une tâche dont le participant tient un rôle, limité à
 * in_progress / blocked (jamais review, verified ni done : ce sont des étapes D12).
 * evidence.add reste refusé au canal API (API_AGENT_FORBIDDEN, lot L3b) : 7c-2
 * n'affaiblit pas cette règle ; aucun verdict D12 ne peut passer par ces outils.
 *
 * Contrat d'hôte 7a tenu : chaque écriture porte un op_id DÉRIVÉ de la clé d'effet
 * du moteur ({participant}:{cycle}:api-{clé}:1, empreinte d'intention, jamais un
 * UUID) ; un rejeu rend l'événement original (duplicate) et `lookup` cherche
 * l'événement par sa clé d'idempotence avant tout réessai. Le cycle et le
 * participant viennent de agent_runs (run_id), jamais des arguments du modèle ;
 * les gardes du store (rôles de tâche, question adressée, cycle clos, quota, CAS)
 * restent appliquées par appendEvent.
 */
import { StateContractError } from '../../collab/contracts';
import { opIdClientFor } from '../contracts/phases';
import { CollabStore, CollabStoreError } from '../store/collab-store';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';

export type WriteToolName = 'store_ask' | 'store_answer' | 'store_task_status';

export const WRITE_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_ask', description: 'Poser une question dans le cycle, éventuellement adressée à un participant ou à un rôle d’une tâche.',
    parameters: { type: 'object', properties: { question: { type: 'string', maxLength: 2000 }, to: { type: 'string' }, task: { type: 'string' } },
      required: ['question'], additionalProperties: false } },
  { name: 'store_answer', description: 'Répondre à une question du cycle (ask_seq = seq de la question).',
    parameters: { type: 'object', properties: { ask_seq: { type: 'integer', minimum: 1 }, answer: { type: 'string', maxLength: 4000 } },
      required: ['ask_seq', 'answer'], additionalProperties: false } },
  { name: 'store_task_status', description: 'Signaler l’avancement d’une tâche où votre participant a un rôle : in_progress ou blocked seulement.',
    parameters: { type: 'object', properties: { task: { type: 'string' }, status: { type: 'string', enum: ['in_progress', 'blocked'] },
      note: { type: 'string', maxLength: 1000 } }, required: ['task', 'status'], additionalProperties: false } },
]);

/** Écritures par type de tâche, figées en code ; un type absent n'écrit rien. */
export const WRITE_TOOLS_BY_KIND: Readonly<Record<string, readonly WriteToolName[]>> = Object.freeze({
  answer: ['store_answer'],
  planning: ['store_ask'],
  status: ['store_task_status'],
});

const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TO_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const TASK_STATUS_ALLOWED = ['in_progress', 'blocked'] as const;
/** Réessais bornés sur STALE (rien n'est écrit sur STALE) avant un refus certain. */
const STALE_RETRIES = 3;

interface RunScope { cycle_id: string; participant_id: string }

function text(args: Record<string, unknown>, name: string, max: number, required = true): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ToolRefused(name + ' : texte de 1 à ' + max + ' caractères requis.');
  return value;
}

/** op_id déterministe de l'effet : le même effet rejoué donne la même clé d'idempotence. */
export function effectOpId(participantId: string, cycleId: string, effectKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(effectKey)) throw new ToolRefused('effect_key_invalid');
  // Segment client canonique du store (opIdClientFor : « : » → « . », injectif).
  let client: string;
  try {
    client = opIdClientFor(participantId);
  } catch {
    throw new ToolRefused('INVALID_OP_ID');
  }
  return client + ':' + cycleId + ':api-' + effectKey.slice(0, 32) + ':1';
}

function eventFor(call: ToolCall): { type: 'clarify.ask' | 'clarify.answer' | 'task.status'; payload: Record<string, unknown> } {
  const args = call.args ?? {};
  switch (call.name as WriteToolName) {
    case 'store_ask': {
      const question = text(args, 'question', 2000)!;
      const to = args.to === undefined ? undefined : (typeof args.to === 'string' && TO_RE.test(args.to) ? args.to : null);
      const task = args.task === undefined ? undefined : (typeof args.task === 'string' && TASK_RE.test(args.task) ? args.task : null);
      if (to === null || task === null) throw new ToolRefused('to ou task invalide.');
      return { type: 'clarify.ask', payload: { question, ...(to ? { to } : {}), ...(task ? { task } : {}) } };
    }
    case 'store_answer': {
      const askSeq = args.ask_seq;
      if (typeof askSeq !== 'number' || !Number.isSafeInteger(askSeq) || askSeq < 1) throw new ToolRefused('ask_seq : entier ≥ 1 requis.');
      return { type: 'clarify.answer', payload: { ask_seq: askSeq, answer: text(args, 'answer', 4000)! } };
    }
    case 'store_task_status': {
      const task = args.task;
      const status = args.status;
      if (typeof task !== 'string' || !TASK_RE.test(task)) throw new ToolRefused('task invalide.');
      if (!(TASK_STATUS_ALLOWED as readonly unknown[]).includes(status)) throw new ToolRefused('status : in_progress ou blocked seulement (canal API).');
      const note = text(args, 'note', 1000, false);
      // Forme du contrat store (taskStatements) : { task: { task_id, status } }.
      return { type: 'task.status', payload: { task: { task_id: task, status }, ...(note ? { note } : {}) } };
    }
    default:
      throw new ToolRefused('tool_not_allowlisted');
  }
}

export interface StoreWriteTools {
  names(taskKind: string): readonly WriteToolName[];
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown>;
  lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

export function createStoreWriteTools(db: D1Database): StoreWriteTools {
  async function scope(runId: string): Promise<RunScope> {
    const run = await db.prepare('SELECT cycle_id, participant_id FROM agent_runs WHERE run_id = ?1').bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  return {
    names(taskKind) {
      return Object.prototype.hasOwnProperty.call(WRITE_TOOLS_BY_KIND, taskKind) ? WRITE_TOOLS_BY_KIND[taskKind] : [];
    },
    async execute(call, ctx) {
      if (!ctx.effect_key) throw new ToolRefused('effect_key_required');
      const { cycle_id, participant_id } = await scope(ctx.run_id);
      const { type, payload } = eventFor(call);
      const store = new CollabStore(db);
      const opId = effectOpId(participant_id, cycle_id, ctx.effect_key);
      let expected = await store.currentRevision(cycle_id);
      for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
        let outcome;
        try {
          outcome = await store.appendEvent({ cycle_id, type, participant_id, expected_rev: expected, payload_json: JSON.stringify(payload),
            op_id: opId, role: 'api-agent' });
        } catch (error) {
          // Refus typé du store ou du contrat (rôle, question, cycle clos, payload…) : certain, rien n'est écrit.
          // Toute autre erreur (panne D1) reste incertaine : le moteur la marque ambiguous et appellera lookup.
          if (error instanceof CollabStoreError || error instanceof StateContractError) throw new ToolRefused(error.code);
          throw error;
        }
        if (outcome.status === 'stale') { expected = outcome.currentRevision; continue; }
        if (outcome.status === 'quota_exhausted') throw new ToolRefused('QUOTA_EXHAUSTED');
        return { seq: outcome.event.seq, type, status: outcome.status };
      }
      throw new ToolRefused('STALE');
    },
    async lookup(call, ctx) {
      const { cycle_id, participant_id } = await scope(ctx.run_id);
      const key = 'op:' + effectOpId(participant_id, cycle_id, ctx.effect_key);
      const row = await db.prepare('SELECT seq, type FROM events WHERE idempotency_key = ?1').bind(key).first<{ seq: number; type: string }>();
      // L'append est atomique (un lot D1) : absent = certainement pas écrit.
      return row ? { found: true, result: { seq: row.seq, type: row.type, status: 'duplicate' } } : { found: false };
    },
  };
}

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
import { MemoryStoreError } from '../memory/memory-store';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';

export type WriteToolName = 'store_ask' | 'store_answer' | 'store_task_status' | 'store_memory_propose';

/**
 * CC-7 L3 (incrément 2) : proposition de mémoire C4 par l'API (parité S4). Une proposition reste `candidate` :
 * son activation suit le cycle de vie C4 inchangé (revue par une autre identité, ou auto-revue bornée du
 * propriétaire d'un scope personnel par son chat). Jamais de kind protégé (invariant, decision) au canal API.
 * Proposée seulement par un hôte créé avec `continuity: true` (read-tools, porte AGENT_RUN_CONTINUITY).
 */
export const MEMORY_PROPOSE_KINDS = ['fact', 'lesson', 'procedure', 'observation', 'open_question'] as const;
export const MEMORY_PROPOSE_TEXT_MAX = 1000;

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
  { name: 'store_memory_propose', description: 'Proposer une entrée de mémoire C4 (candidate, à activer par revue). scope : personal (défaut, votre mémoire), common, role:<r>, task:<t> ou project:<p>.',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 },
      kind: { type: 'string', enum: ['fact', 'lesson', 'procedure', 'observation', 'open_question'] },
      scope: { type: 'string' }, confidence: { type: 'string', enum: ['hypothesis', 'observed'] },
      evidence_refs: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 5 } },
      required: ['text', 'kind'], additionalProperties: false } },
]);

/** Écritures par type de tâche, figées en code ; un type absent n'écrit rien. */
export const WRITE_TOOLS_BY_KIND: Readonly<Record<string, readonly WriteToolName[]>> = Object.freeze({
  answer: ['store_answer'],
  planning: ['store_ask'],
  status: ['store_task_status'],
  // 7c-3 : l'implémentation signale aussi son avancement (in_progress / blocked).
  implement: ['store_task_status'],
});

const TASK_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SHARED_SCOPE_RE = /^(common|project:[A-Za-z0-9_-]{1,64}|role:[A-Za-z0-9_-]{1,64}|task:[A-Za-z0-9_-]{1,64})$/;
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

/** Payload memory.propose du canal API ; `participantId` vient de agent_runs (scope personnel). */
function memoryProposal(args: Record<string, unknown>, participantId: string): Record<string, unknown> {
  const body = text(args, 'text', MEMORY_PROPOSE_TEXT_MAX)!;
  if (!(MEMORY_PROPOSE_KINDS as readonly unknown[]).includes(args.kind)) throw new ToolRefused('kind : ' + MEMORY_PROPOSE_KINDS.join(', ') + ' seulement (canal API).');
  const rawScope = args.scope === undefined ? 'personal' : args.scope;
  if (typeof rawScope !== 'string' || (rawScope !== 'personal' && !SHARED_SCOPE_RE.test(rawScope))) {
    throw new ToolRefused('scope : personal, common, role:<r>, task:<t> ou project:<p> (jamais le scope personnel d’un autre).');
  }
  const confidence = args.confidence === undefined ? 'hypothesis' : args.confidence;
  if (confidence !== 'hypothesis' && confidence !== 'observed') throw new ToolRefused('confidence : hypothesis ou observed seulement.');
  const refs = args.evidence_refs;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length === 0 || refs.length > 5
    || refs.some(ref => typeof ref !== 'string' || !ref.trim() || ref.length > 300))) {
    throw new ToolRefused('evidence_refs : 1 à 5 références de 300 caractères au plus.');
  }
  const scope = rawScope === 'personal' ? 'participant:' + participantId : rawScope;
  return { memory: { scope, kind: args.kind, text: body, confidence, ...(refs ? { evidence_refs: refs } : {}) } };
}

function eventFor(call: ToolCall, participantId: string): { type: 'clarify.ask' | 'clarify.answer' | 'task.status' | 'memory.propose'; payload: Record<string, unknown> } {
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
    case 'store_memory_propose':
      return { type: 'memory.propose', payload: memoryProposal(args, participantId) };
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
      const { type, payload } = eventFor(call, participant_id);
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
          if (error instanceof CollabStoreError || error instanceof StateContractError || error instanceof MemoryStoreError) {
            throw new ToolRefused(error.code);
          }
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

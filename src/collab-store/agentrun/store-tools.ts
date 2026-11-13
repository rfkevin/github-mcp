/**
 * CC-5 l7 (incrément 7c-2) — outils d'ÉCRITURE dans le store pour les exécutions API.
 *
 * Écritures disponibles selon rôle et mandat réel : questions, réponses,
 * avancement de tâche, mémoire C4 et passation durable.
 * Les actes du propriétaire et `evidence.add` libre sont refusés au canal API,
 * mais `store_verdict` reste la porte D12 contrôlée pour reviewer/tester autorisé.
 * Le moteur refuse également le déguisement d'un verdict dans un outil générique.
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
import { HANDOVER_MAX_CHARS, handoverLength } from '../context/continuity';
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';

export type WriteToolName = 'store_ask' | 'store_answer' | 'store_task_status' | 'store_memory_propose' | 'store_memory_rewrite' | 'store_handover';

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
  { name: 'store_answer', description: 'Répondre à une question du cycle (ask_seq = seq de la question). Même limite que collab_append_event : 65 536 caractères pour le JSON complet, sans plafond supplémentaire sur answer.',
    parameters: { type: 'object', properties: { ask_seq: { type: 'integer', minimum: 1 }, answer: { type: 'string' } },
      required: ['ask_seq', 'answer'], additionalProperties: false } },
  { name: 'store_task_status', description: 'Signaler l’avancement d’une tâche où votre participant a un rôle : in_progress ou blocked seulement.',
    parameters: { type: 'object', properties: { task: { type: 'string' }, status: { type: 'string', enum: ['in_progress', 'blocked'] },
      note: { type: 'string', maxLength: 1000 } }, required: ['task', 'status'], additionalProperties: false } },
  { name: 'store_handover', description: 'Passation durable chat ↔ API pour votre identité : Fait / Reste / Appris. Enregistre un checkpoint dans le cycle, pas un verdict D12.',
    parameters: { type: 'object', properties: {
      done: { type: 'string', maxLength: 1200 }, todo: { type: 'string', maxLength: 1200 },
      learned: { type: 'string', maxLength: 1200 } }, additionalProperties: false } },
  { name: 'store_memory_rewrite', description: 'Réviser une entrée C4 existante visible par votre identité : memory.consolidate versionné, nouveau contenu candidat avec références, soumis aux mêmes revues et protections que le chat.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', maxLength: 128 }, text: { type: 'string', maxLength: 1000 },
      evidence_refs: { type: 'array', items: { type: 'string', maxLength: 300 }, minItems: 1, maxItems: 5 } },
      required: ['id','text','evidence_refs'], additionalProperties: false } },
  { name: 'store_memory_propose', description: 'Proposer une entrée de mémoire C4 (candidate, à activer par revue). scope : personal (défaut, votre mémoire), common, role:<r>, task:<t> ou project:<p>.',
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 1000 },
      kind: { type: 'string', enum: ['fact', 'lesson', 'procedure', 'observation', 'open_question'] },
      scope: { type: 'string' }, confidence: { type: 'string', enum: ['hypothesis', 'observed'] },
      evidence_refs: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 5 } },
      required: ['text', 'kind'], additionalProperties: false } },
]);

/** Écritures par type de tâche, figées en code ; un type absent n'écrit rien. */
export const WRITE_TOOLS_BY_KIND: Readonly<Record<string, readonly WriteToolName[]>> = Object.freeze({
  // CC8 : tous les kinds API connus peuvent poser/répondre aux clarifications ;
  // le store continue de vérifier les droits du participant au point d'écriture.
  answer: ['store_answer', 'store_ask'],
  planning: ['store_ask', 'store_answer'],
  status: ['store_task_status', 'store_ask', 'store_answer'],
  implement: ['store_task_status', 'store_ask', 'store_answer'],
  review: ['store_ask', 'store_answer'],
  test: ['store_ask', 'store_answer'],
  design: ['store_ask', 'store_answer'],
  research: ['store_ask', 'store_answer'],
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

function eventFor(call: ToolCall, participantId: string): { type: 'clarify.ask' | 'clarify.answer' | 'task.status' | 'memory.propose' | 'memory.consolidate' | 'checkpoint'; payload: Record<string, unknown> } {
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
      // Parité chat/API : seul validateAgentEvent borne la longueur du JSON entier.
      // Garder la validation de forme, sans plafond propre à l'outil WorkSession.
      const answer = args.answer;
      if (typeof answer !== 'string' || !answer.trim()) throw new ToolRefused('answer_required');
      return { type: 'clarify.answer', payload: { ask_seq: askSeq, answer } };
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
    case 'store_handover': {
      const done = args.done === undefined ? '' : text(args, 'done', 1200)!;
      const todo = args.todo === undefined ? '' : text(args, 'todo', 1200)!;
      const learned = args.learned === undefined ? '' : text(args, 'learned', 1200)!;
      if (!done && !todo && !learned || handoverLength({ done, todo, learned }) > HANDOVER_MAX_CHARS)
        throw new ToolRefused('handover_empty_or_too_long');
      return { type: 'checkpoint', payload: {kind:'handover',done,todo,learned} };
    }
    case 'store_memory_rewrite': {
      const id = text(args, 'id', 128)!;
      const body = text(args, 'text', MEMORY_PROPOSE_TEXT_MAX)!;
      const refs = args.evidence_refs;
      if (!Array.isArray(refs) || refs.length < 1 || refs.length > 5
        || refs.some(ref=>typeof ref!=='string'||!ref.trim()||ref.length>300))
        throw new ToolRefused('evidence_refs_required');
      return {type:'memory.consolidate',payload:{memory:{id,text:body,evidence_refs:refs}}};
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
      // Les outils de clarification respectent HALT comme le moteur et le salon.
      // La garde d'exécution LIVE du moteur reste la protection atomique contre
      // une préemption concurrente avant cet appel API.
      if (type === 'clarify.ask' || type === 'clarify.answer') {
        const halted = await db.prepare(
          "SELECT 1 AS ok FROM owner_flags WHERE name = 'halt' AND value = '1' LIMIT 1",
        ).first<{ ok: number }>();
        if (halted) throw new ToolRefused('HALT');
      }
      const store = new CollabStore(db);
      const opId = effectOpId(participant_id, cycle_id, ctx.effect_key);
      let expected = await store.currentRevision(cycle_id);
      for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
        // S7 : l'API ne peut rouvrir une tâche bloquée, en revue ou terminée.
        // Vérifier à chaque tentative CAS, y compris après un STALE concurrent.
        if (type === 'task.status' && call.args?.status === 'in_progress') {
          const current = await db.prepare('SELECT status FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
            .bind(cycle_id, call.args.task).first<{ status: string }>();
          if (!current || !['proposed', 'accepted', 'in_progress'].includes(current.status)) {
            throw new ToolRefused('api_task_reopen_forbidden');
          }
        }
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

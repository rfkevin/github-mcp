/**
 * CC-5 l7 (incrément 7c-2) — création d'exécutions API depuis les décisions du contrôleur.
 *
 * Porte d'activation propre, vide par défaut : AGENT_RUN_PARTICIPANTS liste les
 * participants serveur (séparés par des virgules) qui acceptent le canal API ;
 * vide ou absent = aucune lecture et aucune création. En plus, l'interrupteur
 * général AGENT_RUNS_ENABLED reste requis (agentRunPass).
 *
 * Seules les décisions `answer_question` (question adressée au participant,
 * règle X13) créent une exécution, de type `answer` : aucune tâche à verdict
 * (revue, test, fusion, déblocage, phase) ne passe par le canal API (D12).
 * run_id déterministe (cycle, participant, question) : un passage rejoué ne
 * crée jamais une seconde exécution pour la même question (createRun idempotent),
 * et createRun refuse toujours si HALT, si le chat tient le bail ou si une
 * exécution est déjà active pour le participant.
 */
import { previewNextActions } from '../controller/next-actions';
import { sha256Hex } from '../store/hash';
import { createRun } from './engine';

export const PLAN_MAX_PARTICIPANTS = 8;
export const PLAN_MAX_CYCLES = 20;
export const PLAN_LIMIT = 5;
export const PLAN_MAX_STEPS = 6;
export const PLAN_MAX_TOKENS = 24_000;
export const PLAN_DEADLINE_S = 900;

const PARTICIPANT_RE = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,127}$/;
const ASK_SUBJECT_RE = /^ask#([1-9][0-9]{0,9})$/;

export interface PlanEnv { AGENT_RUN_PARTICIPANTS?: string }

/** Participants serveur volontaires ; entrée invalide ignorée, doublons retirés, au plus PLAN_MAX_PARTICIPANTS. */
export function apiParticipants(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const item of raw.split(',')) {
    const pid = item.trim();
    if (PARTICIPANT_RE.test(pid) && !out.includes(pid)) out.push(pid);
    if (out.length >= PLAN_MAX_PARTICIPANTS) break;
  }
  return out;
}

export async function answerRunId(cycleId: string, participantId: string, askSeq: number): Promise<string> {
  return 'api-answer-' + (await sha256Hex(['answer', cycleId, participantId, String(askSeq)].join('\u001f'))).slice(0, 32);
}

export interface PlanResult { considered: number; created: number }

export async function planAgentRuns(db: D1Database, env: PlanEnv, input: { now: number; limit?: number }): Promise<PlanResult> {
  const participants = apiParticipants(env.AGENT_RUN_PARTICIPANTS);
  if (!participants.length) return { considered: 0, created: 0 };
  const limit = Math.max(1, Math.min(input.limit ?? PLAN_LIMIT, 20));
  const { results: cycles } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(PLAN_MAX_CYCLES).all<{ cycle_id: string }>();
  let considered = 0;
  let created = 0;
  for (const { cycle_id: cycleId } of cycles) {
    for (const participantId of participants) {
      const view = await previewNextActions(db, cycleId, participantId);
      if (view.mode !== 'active') continue;
      for (const decision of view.mine) {
        const match = decision.action === 'answer_question' && decision.task_id === null ? ASK_SUBJECT_RE.exec(decision.subject) : null;
        if (!match) continue;
        if (created >= limit) return { considered, created };
        considered += 1;
        const askSeq = Number(match[1]);
        const result = await createRun(db, {
          runId: await answerRunId(cycleId, participantId, askSeq), cycleId, participantId, taskId: '', taskKind: 'answer',
          prompt: [
            'Question #' + askSeq + ' du cycle ' + cycleId + ' adressée à votre participant.',
            'Lisez-la avec store_delta (since_seq ' + (askSeq - 1) + ', limit 1) et le contexte avec store_context si utile,',
            'puis répondez une seule fois avec store_answer (ask_seq ' + askSeq + ').',
            'Sans réponse sûre, dites-le dans la réponse plutôt que d’inventer.',
          ].join(' '),
          maxSteps: PLAN_MAX_STEPS, maxTokens: PLAN_MAX_TOKENS, maxCostCents: 0, deadlineAt: input.now + PLAN_DEADLINE_S, now: input.now,
        });
        if (result.created) created += 1;
      }
    }
  }
  return { considered, created };
}

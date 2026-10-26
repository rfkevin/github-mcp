/**
 * CC-5 l7 (incrément 7c-2) — création d'exécutions API depuis les décisions du contrôleur.
 * CC-7 L5a (S9) — les réveils de tâche créent aussi des exécutions typées.
 *
 * Porte d'activation propre, vide par défaut : AGENT_RUN_PARTICIPANTS liste les
 * participants serveur (séparés par des virgules) qui acceptent le canal API ;
 * vide ou absent = aucune lecture et aucune création. En plus, l'interrupteur
 * général AGENT_RUNS_ENABLED reste requis (agentRunPass).
 *
 * Décisions créant une exécution : `answer_question` (type `answer`, règle X13) et,
 * depuis L5a, les réveils de tâche — `review` ou `renew_verdict` du relecteur
 * (type `review`), `test` ou `renew_verdict` du testeur (type `test`),
 * `implement`, `address_feedback` et `address_correction` de l'auteur (type
 * `implement`). Le canal API n'émet toujours aucun verdict D12 : une relecture
 * ou un test conclut dans son message final, `evidence.add` reste interdit au
 * canal API, et la fusion comme les actes du propriétaire ne passent jamais
 * par lui. run_id déterministe (cycle, participant, question ou tâche et
 * objet) : un passage rejoué ne crée jamais une seconde exécution pour la même
 * décision (createRun idempotent), et createRun refuse toujours si HALT, si le
 * chat tient le bail ou si une exécution est déjà active pour le participant.
 */
import { previewNextActions } from '../controller/next-actions';
import { logicalIdentityOf } from '../identity/families';
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
/** Sujet d'un réveil de vérificateur : le couple exact de la soumission, head..base. */
const SHA_PAIR_RE = /^([a-f0-9]{40})\.\.([a-f0-9]{40})$/;

/** CC-7 L5a : types d'exécution planifiables depuis les décisions du contrôleur. */
export type PlannedTaskKind = 'answer' | 'review' | 'test' | 'implement';
/** CC-7 L5a : types d'un réveil de tâche (`answer` garde son run_id à part, answerRunId). */
export type TaskWakeKind = Exclude<PlannedTaskKind, 'answer'>;

export interface PlanEnv { AGENT_RUN_PARTICIPANTS?: string; AGENT_RUN_CONTINUITY?: string }

/** CC-7 L3 : porte des lectures de continuité, éteinte par défaut (« true » exact seulement). */
export function continuityEnabled(env: { AGENT_RUN_CONTINUITY?: string }): boolean {
  return env.AGENT_RUN_CONTINUITY === 'true';
}

/** Fenêtre de lecture élargie autour d'une question (écarts E1-E3 de l8). */
export const ANSWER_READ_WINDOW = 20;

/**
 * Consigne d'une exécution `answer`. Sans continuité : consigne 7c-2 inchangée. Avec continuité : lecture
 * élargie (registre, mémoire, passation, 20 événements) et message final au format de passation
 * Fait / Reste / Appris, consigné par le moteur dans agent_runs.summary (note de passation de l'API, S5).
 */
export function answerPrompt(cycleId: string, askSeq: number, continuity: boolean): string {
  if (!continuity) {
    return [
      'Question #' + askSeq + ' du cycle ' + cycleId + ' adressée à votre participant.',
      'Lisez-la avec store_delta (since_seq ' + (askSeq - 1) + ', limit 1) et le contexte avec store_context si utile,',
      'puis répondez une seule fois avec store_answer (ask_seq ' + askSeq + ').',
      'Sans réponse sûre, dites-le dans la réponse plutôt que d’inventer.',
    ].join(' ');
  }
  const since = Math.max(0, askSeq - ANSWER_READ_WINDOW);
  return [
    'Question #' + askSeq + ' du cycle ' + cycleId + ' adressée à votre participant.',
    'Avant de répondre, lisez : store_context (registre complet des tâches), store_continuity (notes de passation de',
    'votre chat et vos exécutions précédentes), store_memory (mémoire visible) et store_delta (since_seq ' + since + ', limit ' + ANSWER_READ_WINDOW + ')',
    'pour la question et son contexte récent. Répondez une seule fois avec store_answer (ask_seq ' + askSeq + ').',
    'Sans réponse sûre, dites-le plutôt que d’inventer.',
    'Votre message final est votre note de passation, en trois rubriques courtes : Fait / Reste / Appris (300 mots au plus).',
  ].join(' ');
}

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

/**
 * CC-7 L5a : run_id déterministe d'un réveil de tâche — type, cycle, participant,
 * tâche et objet de la décision. Un passage rejoué retrouve le même identifiant
 * et createRun ne crée jamais la seconde exécution.
 */
export async function taskRunId(kind: TaskWakeKind, cycleId: string, participantId: string, taskId: string, subject: string): Promise<string> {
  return 'api-' + kind + '-' + (await sha256Hex([kind, cycleId, participantId, taskId, subject].join('\u001f'))).slice(0, 32);
}

/**
 * CC-7 L5a : consigne d'un réveil de tâche. Relecture et test : lecture du
 * couple head/base exact de la soumission (github_diff, github_read_file,
 * github_check_runs), conclusion dans le message final, AUCUN verdict émis
 * (D12 ; les écritures serveur de verdict sont le sujet de L5b). Implémentation :
 * branche API, commit au SHA attendu, PR prête à la revue (github_open_pr,
 * jamais de fusion), puis note de passation Fait / Reste / Appris (S5).
 */
export function taskPrompt(kind: TaskWakeKind, cycleId: string, taskId: string, subject: string): string {
  if (kind === 'implement') {
    const object = subject === 'none' ? '' : ' Objet de la décision : ' + subject + '.';
    return [
      'Tâche ' + taskId + ' du cycle ' + cycleId + ' : elle attend votre implémentation.' + object,
      'Lisez le contexte avec store_context et store_delta, puis les sources avec github_read_file.',
      'Travaillez sur VOTRE branche API : github_create_branch au besoin, github_commit_files avec expected_head_sha lu avant chaque commit.',
      'Ouvrez ensuite la PR prête à la revue avec github_open_pr : jamais de fusion, d’approbation ni de résolution de conflit.',
      'Votre message final est votre note de passation, en trois rubriques courtes : Fait / Reste / Appris (300 mots au plus).',
    ].join(' ');
  }
  const label = kind === 'review' ? 'relecture' : 'test';
  const match = SHA_PAIR_RE.exec(subject);
  const couple = match ? 'Couple exact à vérifier : head ' + match[1] + ', base ' + match[2] + '.' : 'Objet de la décision : ' + subject + '.';
  return [
    'Tâche ' + taskId + ' du cycle ' + cycleId + ' : une soumission attend votre ' + label + '.',
    couple,
    'Lisez le diff avec github_diff (head et base exacts), les fichiers concernés avec github_read_file et la CI du head avec github_check_runs.',
    'Consignez votre conclusion dans votre message final : constats, risques et prochaine action proposée.',
    'Vous n’émettez aucun verdict de ' + label + ' (D12) : aucune écriture de verdict n’existe sur ce canal.',
  ].join(' ');
}

/**
 * CC-7 L5a : type d'un réveil de tâche pour ce participant, ou null (aucune
 * exécution). `renew_verdict` suit le rôle réellement tenu sur la tâche
 * (comparaison d'identité logique, #126) : relecteur → review, testeur → test.
 * Les actes du propriétaire (fusion, déblocage, phase) ne passent jamais ici.
 */
async function plannedKindOf(db: D1Database, cycleId: string, participantId: string,
  decision: { action: string; task_id: string | null }): Promise<TaskWakeKind | null> {
  if (decision.action === 'review') return 'review';
  if (decision.action === 'test') return 'test';
  if (decision.action === 'implement' || decision.action === 'address_feedback' || decision.action === 'address_correction') return 'implement';
  if (decision.action !== 'renew_verdict' || !decision.task_id) return null;
  const row = await db.prepare('SELECT reviewer_pid, tester_pid FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
    .bind(cycleId, decision.task_id).first<{ reviewer_pid: string; tester_pid: string }>();
  if (!row) return null;
  const logical = await logicalIdentityOf(db, participantId);
  if (await logicalIdentityOf(db, row.reviewer_pid) === logical) return 'review';
  if (await logicalIdentityOf(db, row.tester_pid) === logical) return 'test';
  return null;
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
        // 7c-2 : question adressée au participant (règle X13) → exécution answer, inchangée.
        if (decision.action === 'answer_question' && decision.task_id === null) {
          const match = ASK_SUBJECT_RE.exec(decision.subject);
          if (!match) continue;
          if (created >= limit) return { considered, created };
          considered += 1;
          const askSeq = Number(match[1]);
          const result = await createRun(db, {
            runId: await answerRunId(cycleId, participantId, askSeq), cycleId, participantId, taskId: '', taskKind: 'answer',
            prompt: answerPrompt(cycleId, askSeq, continuityEnabled(env)),
            maxSteps: PLAN_MAX_STEPS, maxTokens: PLAN_MAX_TOKENS, maxCostCents: 0, deadlineAt: input.now + PLAN_DEADLINE_S, now: input.now,
          });
          if (result.created) created += 1;
          continue;
        }
        // L5a (S9) : réveil de tâche → exécution typée review / test / implement.
        const kind = await plannedKindOf(db, cycleId, participantId, decision);
        if (!kind) continue;
        if (created >= limit) return { considered, created };
        considered += 1;
        const taskId = decision.task_id ?? '';
        const result = await createRun(db, {
          runId: await taskRunId(kind, cycleId, participantId, taskId, decision.subject), cycleId, participantId,
          taskId, taskKind: kind, prompt: taskPrompt(kind, cycleId, taskId, decision.subject),
          maxSteps: PLAN_MAX_STEPS, maxTokens: PLAN_MAX_TOKENS, maxCostCents: 0, deadlineAt: input.now + PLAN_DEADLINE_S, now: input.now,
        });
        if (result.created) created += 1;
      }
    }
  }
  return { considered, created };
}

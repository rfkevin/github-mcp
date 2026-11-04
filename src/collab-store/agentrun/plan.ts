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
 * `implement`). Le canal API n'émet toujours aucun verdict D12 LIBRE : depuis
 * L5b, un verdict de relecture ou de test ne se dépose QUE par store_verdict
 * (contrôles serveur au couple exact, S10), `evidence.add` libre reste interdit
 * au canal API, et la fusion comme les actes du propriétaire ne passent jamais
 * par lui. run_id déterministe (cycle, participant, question ou tâche et
 * objet) : un passage rejoué ne crée jamais une seconde exécution pour la même
 * décision (createRun idempotent), et createRun refuse toujours si HALT, si le
 * chat tient le bail ou si une exécution est déjà active pour le participant.
 *
 * CC-7 L12 : un seul travailleur actif par agent. Aucune exécution n'est créée tant que le chat
 * de l'agent (identités équivalentes comprises) a écrit dans la fenêtre CHAT_ACTIVE_SECONDS :
 * sur le cycle pour une réponse (une réponse n'a pas de tâche, le bail par tâche ne la couvrait
 * pas), sur la tâche pour un réveil de tâche. Fenêtre glissante : sans écriture chat, l'API reprend
 * au passage suivant ; la décision n'est pas consommée, seulement différée (compteur `deferred`).
 */
import { previewNextActions } from '../controller/next-actions';
import { equivalentParticipantIds, logicalIdentityOf } from '../identity/families';
import { chatActiveWithin } from '../context/active-work';
import { sha256Hex } from '../store/hash';
import { createRun } from './engine';
import { ensureAgentRunSchema } from './schema';
import { recordCapacity, runCapacity, type RunCapacity } from './capacity';
// CC-8 S1b-2 : deadline d'exécution PAR TYPE DE TÂCHE — politique unique (v2 point 5).
import { runDeadlineS } from './run-policy';
import { decisionKey } from '../controller/journal';
import type { Decision } from '../controller/rules';

export const PLAN_MAX_PARTICIPANTS = 8;
export const PLAN_MAX_CYCLES = 20;
export const PLAN_LIMIT = 5;
export const PLAN_MAX_STEPS = 6;
export const PLAN_MAX_TOKENS = 24_000;
/** S1b : enveloppe totale de jetons par type d'exécution (jamais supérieure au plafond historique). */
export const TASK_KIND_MAX_TOKENS = Object.freeze({ answer: 8_000, review: 16_000, test: 16_000, implement: 24_000, design: 12_000 });
export function taskKindMaxTokens(kind: PlannedTaskKind): number { return TASK_KIND_MAX_TOKENS[kind]; }
/** CC-8 S1b-2 : dérivé de la politique unique (run-policy) — 900 s partout à la fusion, montée S7 après P95. */
export const PLAN_DEADLINE_S = runDeadlineS('answer');

/**
 * CC-7 L5b (N2) : plafond de coût PAR TYPE DE TÂCHE de chaque exécution API,
 * en cents US. Tout à 0 = éteint fail-closed : aucun appel payant possible
 * tant que Kevin ne lève pas une valeur par type (P5).
 */
export const TASK_KIND_COST_CENTS: Readonly<Record<PlannedTaskKind, number>> = Object.freeze({
  answer: 0,
  review: 0,
  test: 0,
  implement: 0,
  design: 0,
});

/** CC-7 L6b : plafond haut d'une variable owner de coût par exécution (cents US) — l'enveloppe par participant borne en plus. */
export const RUN_COST_CENTS_CEILING = 1_000;

/**
 * CC-7 L6b : plafond de coût d'une exécution du type `kind`, lu dans la variable owner
 * AGENT_RUN_COST_CENTS_<KIND> (entier 0 à RUN_COST_CENTS_CEILING, posé par Kevin seul sur
 * le Worker). Absente ou invalide = TASK_KIND_COST_CENTS (0, fail-closed) : aucune PR n'est
 * plus nécessaire pour financer un type, et rien n'est financé par défaut.
 */
export function taskKindCostCents(env: PlanEnv, kind: PlannedTaskKind): number {
  const raw = env[('AGENT_RUN_COST_CENTS_' + kind.toUpperCase()) as keyof PlanEnv];
  if (raw === undefined || !/^(0|[1-9][0-9]{0,9})$/.test(raw)) return TASK_KIND_COST_CENTS[kind];
  const value = Number(raw);
  return value <= RUN_COST_CENTS_CEILING ? value : TASK_KIND_COST_CENTS[kind];
}

const PARTICIPANT_RE = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,127}$/;
const ASK_SUBJECT_RE = /^ask#([1-9][0-9]{0,9})$/;
/** Sujet d'un réveil de vérificateur : le couple exact de la soumission, head..base. */
const SHA_PAIR_RE = /^([a-f0-9]{40})\.\.([a-f0-9]{40})$/;

/** CC-7 L5a : types d'exécution planifiables depuis les décisions du contrôleur. */
/** CC-7 L6b-2 : `design` = contribution de conception (proposer, critiquer, synthétiser, voter). */
export type PlannedTaskKind = 'answer' | 'review' | 'test' | 'implement' | 'design';
/** CC-7 L5a : types d'un réveil de tâche (`answer` garde son run_id à part, answerRunId). */
export type TaskWakeKind = Exclude<PlannedTaskKind, 'answer'>;

export interface PlanEnv {
  AGENT_RUN_PARTICIPANTS?: string;
  AGENT_RUN_CONTINUITY?: string;
  /** CC-7 L6b : plafonds de coût par exécution et par type (cents US, 0 à 1 000) ; absents = 0. */
  AGENT_RUN_COST_CENTS_ANSWER?: string;
  AGENT_RUN_COST_CENTS_REVIEW?: string;
  AGENT_RUN_COST_CENTS_TEST?: string;
  AGENT_RUN_COST_CENTS_IMPLEMENT?: string;
  /** CC-7 L6b-2 : contributions de conception (réveils `contribute`). */
  AGENT_RUN_COST_CENTS_DESIGN?: string;
  /**
   * CC-7 L15 : porte des écritures GitHub du canal API (object.ts). Sans « true », l'API n'a aucun
   * outil pour modifier le code : un réveil « implémenter / corriger » n'est pas confié à l'API
   * (elle ne pourrait qu'annoncer un travail qu'elle ne fait pas — seq 1157 et 1160 de cc7-api-auto).
   */
  AGENT_RUN_GITHUB_WRITES?: string;
}

/** CC-7 L15 : l'API a-t-elle les outils d'écriture GitHub nécessaires à un réveil `implement` ? */
export function apiCanImplement(env: { AGENT_RUN_GITHUB_WRITES?: string }): boolean {
  return env.AGENT_RUN_GITHUB_WRITES === 'true';
}

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

/** Variante answer : l'identité de la question, phase, ronde et tentative est stable au rejeu. */
export async function answerAttemptRunId(cycleId: string, participantId: string, askSeq: number,
  phase: string, round: number, attempt: number): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(phase) || !Number.isSafeInteger(round) || round < 0
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) throw new Error('INVALID_RUN_ATTEMPT');
  return 'api-answer-' + (await sha256Hex(
    ['answer', cycleId, participantId, String(askSeq), phase, String(round), String(attempt)].join('\u001f'),
  )).slice(0, 32);
}

/** Identité stable d'une tentative S1b : le même triplet phase/ronde/tentative ne crée jamais deux runs. */
export async function attemptRunId(kind: TaskWakeKind, cycleId: string, participantId: string, taskId: string,
  subject: string, phase: string, round: number, attempt: number): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(phase) || !Number.isSafeInteger(round) || round < 0
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new Error('INVALID_RUN_ATTEMPT : phase, ronde ou tentative invalide');
  }
  return 'api-' + kind + '-' + (await sha256Hex(
    [kind, cycleId, participantId, taskId, subject, phase, String(round), String(attempt)].join('\u001f'),
  )).slice(0, 32);
}

/**
 * CC-7 L5a : consigne d'un réveil de tâche. Relecture et test : lecture du
 * couple head/base exact de la soumission (github_diff, github_read_file,
 * github_check_runs), verdict déposé UNIQUEMENT par store_verdict (L5b, S10 :
 * contrôles serveur au couple exact) ou conclusion dans le message final.
 * Implémentation :
 * branche API, commit au SHA attendu, PR prête à la revue (github_open_pr,
 * jamais de fusion), puis note de passation Fait / Reste / Appris (S5).
 */
export function taskPrompt(kind: TaskWakeKind, cycleId: string, taskId: string, subject: string): string {
  if (kind === 'design') {
    // Sujet du réveil : <phase>:<type d'événement>:<rôle>[:<tâche>] (règle phase-output-missing).
    const [phase, eventKind, role] = subject.split(':');
    const what = eventKind === 'proposal.submit'
      ? (role === 'author' && phase === 'P3' ? 'la synthèse des propositions et des critiques' : 'votre proposition')
      : (phase === 'P4' ? 'votre vote sur la synthèse' : 'votre critique de la proposition');
    return [
      'Cycle ' + cycleId + ', phase ' + (phase ?? '?') + ' : la tâche ' + taskId + ' attend ' + what + '.',
      'Lisez le contexte avec store_context et store_delta (objectif, propositions révélées, critiques).',
      eventKind === 'proposal.submit'
        ? 'Déposez-la UNE fois avec store_contribute (task ' + taskId + ', content : texte complet et autonome).'
        : 'Déposez-la UNE fois avec store_contribute (task ' + taskId + ', state AGREE, AMEND ou OBJECTION, review : vos arguments, clause par clause si utile).',
      'Le serveur vérifie que cette sortie vous est demandée ; ce n’est jamais un verdict de PR.',
      'Votre message final est votre note de passation : Fait / Reste / Appris (300 mots au plus).',
    ].join(' ');
  }
  if (kind === 'implement') {
    const object = subject === 'none' ? '' : ' Objet de la décision : ' + subject + '.';
    return [
      'Tâche ' + taskId + ' du cycle ' + cycleId + ' : elle attend votre implémentation.' + object,
      'Lisez le contexte avec store_context et store_delta, puis les sources avec github_read_file.',
      'Appelez github_write_scope pour connaître le mandat exact et son nom de branche. Après chaque commit, github_run_checks puis github_check_result au SHA courant ; attendez si pending, corrigez si rouge, trois corrections maximum puis escalade. CI verte ne remplace pas D12.',
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
    'Votre verdict ne se dépose QUE par store_verdict (task, pr, head, base exacts, state '
    + (kind === 'review' ? 'AGREE ou CHANGES_REQUESTED' : 'PASS ou FAIL') + ', review) :',
    'le serveur relit le couple, la CI et vos lectures avant d’écrire ; sans certitude, concluez dans votre message final sans verdict.',
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
  // CC-7 L6b-2 : sortie attendue d'une phase de conception → exécution `design` (store_contribute).
  if (decision.action === 'contribute') return 'design';
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

/**
 * `deferred` n'apparaît que s'il est non nul (L12) ; `unequipped` (L15) compte les réveils « implémenter »
 * non confiés faute d'outils d'écriture GitHub ; `incapable` (CC-8 S1a) compte les réveils non confiés parce
 * que l'agent n'a, maintenant, aucun modèle abordable pour ce type d'exécution. La forme historique
 * { considered, created } reste inchangée.
 */
export interface PlanResult { considered: number; created: number; deferred?: number; unequipped?: number; incapable?: number;
  /** CC-8 S1a : motif typé de chaque refus de capacité du passage (un par agent, cycle et type), jamais de contenu privé. */
  incapable_detail?: IncapableDetail[] }

export interface IncapableDetail { participant_id: string; cycle_id: string; kind: string; reason: string }

function planResult(considered: number, created: number, deferred: number, unequipped = 0, incapable = 0,
  detail: IncapableDetail[] = []): PlanResult {
  const out: PlanResult = deferred > 0 ? { considered, created, deferred } : { considered, created };
  if (unequipped > 0) out.unequipped = unequipped;
  if (incapable > 0) out.incapable = incapable;
  if (detail.length > 0) out.incapable_detail = detail;
  return out;
}

/**
 * Une exécution prête à être créée (toutes les gardes du passage déjà franchies). `waitingSince` = première
 * écriture du réveil au journal du contrôleur (ancienneté réelle) ; `order` départage de façon déterministe.
 */
interface PlanIntent { waitingSince: number; order: number; create: () => Promise<boolean> }

/**
 * Ancienneté d'un réveil : date de sa première ligne au journal du contrôleur (même clé que le passage
 * programmé, donc stable d'un passage à l'autre). Pas encore journalisé ou journal absent : `now` (le plus récent).
 */
async function waitingSince(db: D1Database, cycleId: string, decision: Decision, now: number): Promise<number> {
  try {
    const row = await db.prepare('SELECT MIN(created_at) AS at FROM controller_decisions WHERE decision_key = ?1')
      .bind(await decisionKey(cycleId, decision)).first<{ at: number | null }>();
    return typeof row?.at === 'number' ? Math.min(row.at, now) : now;
  } catch {
    return now;
  }
}

/**
 * CC-8 S1a — capacité et équité.
 * 1. Capacité : aucune exécution n'est créée pour un agent sans modèle abordable pour ce type
 *    (runCapacity, même calcul que le choix réel d'une étape) ; le réveil reste en attente et repart
 *    dès que la capacité revient (clé, budget, modèle). Sans AUCUNE configuration de modèle (ni
 *    politique par agent ni modèle global) : refus NO_MODEL — la capacité n'est jamais supposée.
 * 2. Équité par ancienneté : chaque agent présente son réveil en attente le plus ancien (journal du
 *    contrôleur) ; à chaque tour, les agents passent du plus ancien réveil au plus récent (départage :
 *    ordre de la liste, puis ordre de découverte), une exécution par agent et par tour, jusqu'à la limite.
 *    Un agent placé en tête de liste, ou riche en réveils récents, ne peut plus prendre la place d'un
 *    réveil plus ancien d'un autre agent.
 * Les motifs typés des refus sont rendus (`incapable_detail`) pour la vue du coordinateur.
 */
export async function planAgentRuns(db: D1Database, env: PlanEnv, input: { now: number; limit?: number }): Promise<PlanResult> {
  const participants = apiParticipants(env.AGENT_RUN_PARTICIPANTS);
  if (!participants.length) return planResult(0, 0, 0);
  await ensureAgentRunSchema(db);
  const limit = Math.max(1, Math.min(input.limit ?? PLAN_LIMIT, 20));
  const { results: cycles } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(PLAN_MAX_CYCLES).all<{ cycle_id: string }>();
  let deferred = 0;
  let unequipped = 0;
  let incapable = 0;
  const nowDate = new Date(input.now * 1000);
  const capacityCache = new Map<string, RunCapacity>();
  const detail: IncapableDetail[] = [];
  const capable = async (participantId: string, cycleId: string, kind: string): Promise<boolean> => {
    const key = participantId + '\u001f' + cycleId + '\u001f' + kind;
    let value = capacityCache.get(key);
    if (value === undefined) {
      value = await runCapacity(db, env, participantId, cycleId, kind, nowDate);
      capacityCache.set(key, value);
      // CC-8 S1a 2/3 : verdict journalisé (capable ou refus typé) — lu par la vue du coordinateur.
      await recordCapacity(db, { participant_id: participantId, cycle_id: cycleId, kind, capacity: value, now: input.now });
      if (!value.capable) detail.push({ participant_id: participantId, cycle_id: cycleId, kind, reason: value.reason });
    }
    return value.capable;
  };
  // S1b : une seule relance après un passage cron (>= 15 min), trois runs au maximum.
  // Le run précédent doit être un échec explicitement transitoire, jamais un refus permanent.
  const retryAttempt = async (ids: string[]): Promise<number | null> => {
    const rows = await Promise.all(ids.map(runId => db.prepare(
      'SELECT status, stop_reason, updated_at FROM agent_runs WHERE run_id = ?1',
    ).bind(runId).first<{ status: string; stop_reason: string; updated_at: number }>()));
    const firstMissing = rows.findIndex(row => !row);
    if (firstMissing === 0) return 1;
    if (firstMissing < 0) return null;
    if (rows.slice(firstMissing + 1).some(Boolean)) return null; // fail-closed : trou dans l'historique
    const last = rows[firstMissing - 1]!;
    if (last.status !== 'failed' || !last.stop_reason.startsWith('model_transient:')) return null;
    return input.now - last.updated_at >= 900 ? firstMissing + 1 : null;
  };
  let order = 0;
  const queues = new Map<string, PlanIntent[]>(participants.map(pid => [pid, []]));
  for (const { cycle_id: cycleId } of cycles) {
    const phaseRow = await db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1').bind(cycleId).first<{ phase: string }>();
    const phase = phaseRow?.phase || 'P0';
    // Chaque événement round.add ouvre une nouvelle identité de réveil, même si le sujet reste identique.
    const roundRow = await db.prepare("SELECT COUNT(*) AS count FROM events WHERE cycle_id = ?1 AND type = 'round.add'")
      .bind(cycleId).first<{ count: number }>();
    const round = roundRow?.count ?? 0;
    for (const participantId of participants) {
      const view = await previewNextActions(db, cycleId, participantId);
      if (view.mode !== 'active') continue;
      const queue = queues.get(participantId)!;
      let identities: string[] | null = null;
      const chatActive = async (taskId: string | null): Promise<boolean> => {
        identities ??= await equivalentParticipantIds(db, participantId);
        return chatActiveWithin(db, cycleId, identities, input.now, taskId);
      };
      for (const decision of view.mine) {
        // 7c-2 : question adressée au participant (règle X13) → exécution answer, inchangée.
        if (decision.action === 'answer_question' && decision.task_id === null) {
          const match = ASK_SUBJECT_RE.exec(decision.subject);
          if (!match) continue;
          // L12 : le chat de l'agent est actif sur ce cycle — il traite lui-même la question.
          if (await chatActive(null)) {
            deferred += 1;
            continue;
          }
          if (!(await capable(participantId, cycleId, 'answer'))) {
            incapable += 1;
            continue;
          }
          const askSeq = Number(match[1]);
          queue.push({ waitingSince: await waitingSince(db, cycleId, decision, input.now), order: order++, create: async () => {
            const ids = await Promise.all([1, 2, 3].map(attempt =>
              answerAttemptRunId(cycleId, participantId, askSeq, phase, round, attempt)));
            const attempt = await retryAttempt(ids);
            if (attempt === null) return false;
            return (await createRun(db, {
              runId: ids[attempt - 1], cycleId, participantId, taskId: '', taskKind: 'answer',
            prompt: answerPrompt(cycleId, askSeq, continuityEnabled(env)),
            maxSteps: PLAN_MAX_STEPS, maxTokens: taskKindMaxTokens('answer'), maxCostCents: taskKindCostCents(env, 'answer'), deadlineAt: input.now + runDeadlineS('answer'), now: input.now,
            })).created;
          } });
          continue;
        }
        // L5a (S9) : réveil de tâche → exécution typée review / test / implement.
        const kind = await plannedKindOf(db, cycleId, participantId, decision);
        if (!kind) continue;
        // L12 : le chat de l'agent travaille sur cette tâche — pas d'exécution API en parallèle.
        if (decision.task_id && await chatActive(decision.task_id)) {
          deferred += 1;
          continue;
        }
        // L15 : sans outils d'écriture GitHub, l'API ne peut pas implémenter — on ne la réveille pas pour ça.
        if (kind === 'implement' && !apiCanImplement(env)) {
          unequipped += 1;
          continue;
        }
        // CC-8 S1a : aucun modèle abordable maintenant — on ne crée pas une exécution vouée à l'échec.
        if (!(await capable(participantId, cycleId, kind))) {
          incapable += 1;
          continue;
        }
        const taskId = decision.task_id ?? '';
        queue.push({ waitingSince: await waitingSince(db, cycleId, decision, input.now), order: order++, create: async () => {
          // La ronde est liée au sujet de la décision (incluant le couple head/base pour review/test).
          const ids = await Promise.all([1, 2, 3].map(attempt =>
            attemptRunId(kind, cycleId, participantId, taskId, decision.subject, phase, round, attempt)));
          const attempt = await retryAttempt(ids);
          if (attempt === null) return false;
          return (await createRun(db, {
            runId: ids[attempt - 1], cycleId, participantId,
            taskId, taskKind: kind, prompt: taskPrompt(kind, cycleId, taskId, decision.subject),
            maxSteps: PLAN_MAX_STEPS, maxTokens: taskKindMaxTokens(kind), maxCostCents: taskKindCostCents(env, kind),
            deadlineAt: input.now + runDeadlineS(kind), now: input.now,
          })).created;
        } });
      }
    }
  }
  // CC-8 S1a : service par ancienneté, à tour de rôle — une exécution par agent et par tour, jusqu'à la limite.
  const byAge = (a: PlanIntent, b: PlanIntent) => a.waitingSince - b.waitingSince || a.order - b.order;
  for (const queue of queues.values()) queue.sort(byAge);
  const rank = new Map(participants.map((pid, index) => [pid, index]));
  let considered = 0;
  let created = 0;
  while (created < limit) {
    const round = participants.filter(pid => queues.get(pid)!.length > 0)
      .sort((a, b) => queues.get(a)![0].waitingSince - queues.get(b)![0].waitingSince || rank.get(a)! - rank.get(b)!);
    if (!round.length) break;
    for (const participantId of round) {
      if (created >= limit) break;
      const intent = queues.get(participantId)!.shift()!;
      considered += 1;
      if (await intent.create()) created += 1;
    }
  }
  return planResult(considered, created, deferred, unequipped, incapable, detail);
}

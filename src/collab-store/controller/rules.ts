/**
 * CC-5 L3 — contrôleur déterministe : règles pures `nextActors`.
 *
 * Le contrôleur DÉCIDE qui doit agir, il n'exécute rien : aucune écriture,
 * aucun appel réseau, aucune horloge. Même instantané → mêmes décisions et
 * mêmes clés (rejouable, A3a du plan CC-PLAN-5). L'organisation (tours en
 * plus, réattribution) reste au coordinateur IA ; le code applique les
 * invariants (HALT, D12 au head/base exacts, actes protégés).
 */
import { PHASES } from '../../collab/contracts';

export type DecisionKind =
  | 'wake'            // un participant doit agir sur une tâche
  | 'merge_ready'     // deux verdicts positifs au head/base exacts : fusion à faire (Kevin tant que L4 n'existe pas)
  | 'unblock'         // dépendances terminées : le coordinateur doit ouvrir la tâche
  | 'advance_phase';  // sorties attendues satisfaites : avance par policy possible

export type WakeAction = 'implement' | 'review' | 'test' | 'renew_verdict' | 'address_feedback';

export interface Decision {
  kind: DecisionKind;
  /** Participant serveur visé, ou 'owner' / 'coordinator'. */
  actor: string;
  task_id: string | null;
  action: WakeAction | 'merge' | 'open_task' | 'advance';
  /** Règle appliquée (identifiant stable, journalisé). */
  rule: string;
  /** Objet de la décision : head soumis, phase cible… sert à la clé d'idempotence. */
  subject: string;
  reason: string;
}

export type Verdict = 'positive' | 'negative' | 'unknown';

export interface Submission { head: string; base: string; seq: number }
export interface VerdictFact { participant: string; verdict: Verdict; head: string | null; base: string | null; seq: number }

export interface TaskFacts {
  task_id: string;
  status: string;
  owner: string;
  reviewer: string;
  tester: string;
  dependencies: string[];
  /** Dernière soumission de l'auteur (PR avec head/base), null sinon. */
  submission: Submission | null;
  /** Verdicts du relecteur et du testeur, du plus ancien au plus récent. */
  verdicts: VerdictFact[];
}

export interface ControllerSnapshot {
  cycle_id: string;
  revision: number;
  phase: string;
  halted: boolean;
  auto_advance: string;
  outputs_satisfied: boolean;
  tasks: TaskFacts[];
}

export type ControllerMode = 'active' | 'halted';

const FINISHED = new Set(['done', 'verified']);
const ACTIVE = new Set(['accepted', 'in_progress', 'review', 'proposed']);

function latestFrom(verdicts: VerdictFact[], participant: string): VerdictFact | null {
  let latest: VerdictFact | null = null;
  for (const fact of verdicts) {
    if (fact.participant === participant && (!latest || fact.seq > latest.seq)) latest = fact;
  }
  return latest;
}

/** D12 : un verdict ne vaut que pour le head ET la base exacts de la soumission courante. */
function bindsTo(fact: VerdictFact | null, submission: Submission): boolean {
  return !!fact && fact.seq > submission.seq && fact.head === submission.head && fact.base === submission.base;
}

function wake(task: TaskFacts, actor: string, action: WakeAction, rule: string, subject: string, reason: string): Decision {
  return { kind: 'wake', actor, task_id: task.task_id, action, rule, subject, reason };
}

function verifierDecision(task: TaskFacts, submission: Submission, who: string, label: 'review' | 'test'): Decision | null {
  const fact = latestFrom(task.verdicts, who);
  const subject = submission.head + '..' + submission.base;
  if (bindsTo(fact, submission)) return null;
  if (fact && fact.seq > submission.seq && fact.head === null) {
    return wake(task, who, 'renew_verdict', 'verdict-without-sha', subject,
      'Verdict sans head/base exacts : à redéposer avec les SHA de la soumission.');
  }
  if (fact && fact.seq < submission.seq) {
    return wake(task, who, 'renew_verdict', 'verdict-stale', subject,
      'Nouvelle soumission après ton verdict : renouveler au head/base actuels.');
  }
  return wake(task, who, label, label === 'review' ? 'awaiting-review' : 'awaiting-test', subject,
    'Soumission en attente de ' + (label === 'review' ? 'relecture' : 'test') + ' au head/base exacts.');
}

function taskDecisions(task: TaskFacts, byId: Map<string, TaskFacts>): Decision[] {
  if (FINISHED.has(task.status)) return [];
  if (task.status === 'blocked') {
    if (task.dependencies.length === 0) return [];
    const ready = task.dependencies.every(dep => FINISHED.has(byId.get(dep)?.status ?? ''));
    return ready ? [{ kind: 'unblock', actor: 'coordinator', task_id: task.task_id, action: 'open_task',
      rule: 'dependencies-done', subject: task.dependencies.join(','), reason: 'Toutes les dépendances sont terminées.' }] : [];
  }
  if (!ACTIVE.has(task.status)) return [];
  const submission = task.submission;
  if (!submission) {
    return [wake(task, task.owner, 'implement', 'no-submission', 'none', 'Tâche ouverte sans soumission de l\'auteur.')];
  }
  const subject = submission.head + '..' + submission.base;
  const bound = [task.reviewer, task.tester].map(who => latestFrom(task.verdicts, who));
  if (bound.some(fact => bindsTo(fact, submission) && fact!.verdict === 'negative')) {
    return [wake(task, task.owner, 'address_feedback', 'changes-requested', subject,
      'Un verdict demande des corrections au head/base courants.')];
  }
  if (bound.every(fact => bindsTo(fact, submission) && fact!.verdict === 'positive')) {
    return [{ kind: 'merge_ready', actor: 'owner', task_id: task.task_id, action: 'merge', rule: 'two-positive-verdicts',
      subject, reason: 'Relecteur et testeur positifs au même head/base : fusion vers l\'intégration à faire.' }];
  }
  const out: Decision[] = [];
  const review = verifierDecision(task, submission, task.reviewer, 'review');
  const test = verifierDecision(task, submission, task.tester, 'test');
  if (review) out.push(review);
  if (test) out.push(test);
  return out;
}

function nextPhase(phase: string): string | null {
  const index = (PHASES as readonly string[]).indexOf(phase);
  return index >= 0 && index + 1 < PHASES.length ? PHASES[index + 1] : null;
}

/** Règles pures : instantané → décisions triées de façon stable. */
export function nextActors(snapshot: ControllerSnapshot): { mode: ControllerMode; decisions: Decision[] } {
  if (snapshot.halted) return { mode: 'halted', decisions: [] };
  const byId = new Map(snapshot.tasks.map(task => [task.task_id, task]));
  const decisions = snapshot.tasks.flatMap(task => taskDecisions(task, byId));
  const target = nextPhase(snapshot.phase);
  if (snapshot.auto_advance !== 'none' && snapshot.outputs_satisfied && target) {
    decisions.push({ kind: 'advance_phase', actor: 'policy:' + snapshot.auto_advance, task_id: null, action: 'advance',
      rule: 'outputs-satisfied', subject: snapshot.phase + '->' + target, reason: 'Sorties attendues satisfaites.' });
  }
  decisions.sort((a, b) => decisionOrder(a).localeCompare(decisionOrder(b)));
  return { mode: 'active', decisions };
}

function decisionOrder(decision: Decision): string {
  return [decision.task_id ?? '~', decision.kind, decision.actor, decision.action].join('|');
}

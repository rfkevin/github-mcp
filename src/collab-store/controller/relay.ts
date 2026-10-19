/**
 * CC-5 L3d (incrément 2b-2a) — lignes « à relayer » pour Kevin.
 *
 * Les agents de chat ne se réveillent pas seuls : tant qu'aucun canal API
 * n'est financé, Kevin relaie. Cette vue lit, en LECTURE SEULE, les décisions
 * courantes du contrôleur pour chaque cycle ouvert et les rend sous forme de
 * messages courts à copier, avec l'ancienneté de la décision (première ligne
 * du journal, si le passage programmé l'a déjà écrite).
 *
 * Rien n'est écrit, rien n'est exécuté. Les décisions « policy:* » (avance de
 * phase automatique) ne demandent aucun relais et sont omises. Fail-closed :
 * un cycle illisible est simplement absent de la liste (jamais d'erreur sur la
 * page owner). HALT : le contrôleur ne rend aucune décision, la liste du cycle
 * est donc vide.
 */
import { previewNextActions } from './next-actions';
import { decisionKey } from './journal';
import type { Decision } from './rules';

export const RELAY_CYCLE_LIMIT = 20;
export const RELAY_LINE_LIMIT = 50;

export interface RelayLine {
  cycle_id: string;
  /** Identifiant serveur visé, 'owner' ou titulaire du mandat de coordinateur. */
  actor: string;
  /** Libellé lisible (participants.display_label, « Kevin », « coordinateur … »). */
  label: string;
  task_id: string | null;
  action: Decision['action'];
  /** Message prêt à relayer. */
  message: string;
  /** Première écriture de la décision dans le journal (secondes), null si pas encore journalisée. */
  since: number | null;
}

const ACTION_TEXT: Record<Decision['action'], string> = {
  implement: 'implémenter la tâche',
  review: 'relire (verdict D12)',
  test: 'tester (verdict D12)',
  renew_verdict: 'renouveler son verdict au couple courant',
  address_feedback: 'traiter les corrections demandées',
  answer_question: 'répondre à une question',
  renew_or_close_question: 'renouveler ou clore sa question',
  merge: 'fusionner vers l\'intégration',
  open_task: 'ouvrir la tâche (dépendances terminées)',
  advance: 'avancer la phase',
};

const SHA = /^[0-9a-f]{40}$/;
function shortSubject(subject: string): string {
  const parts = subject.split('..');
  if (parts.length === 2 && SHA.test(parts[0]) && SHA.test(parts[1])) return parts[0].slice(0, 7) + '/' + parts[1].slice(0, 7);
  return '';
}

export function relayMessage(cycleId: string, label: string, decision: Decision): string {
  const pair = shortSubject(decision.subject);
  return label + ' — ' + ACTION_TEXT[decision.action]
    + (decision.task_id ? ' ' + decision.task_id : '')
    + (pair ? ' au couple head/base ' + pair : '')
    + ' (cycle ' + cycleId + ') : ' + decision.reason;
}

async function labels(db: D1Database): Promise<Map<string, string>> {
  const rows = await db.prepare('SELECT participant_id, display_label FROM participants')
    .all<{ participant_id: string; display_label: string }>();
  return new Map(rows.results.map(row => [row.participant_id, row.display_label]));
}

async function firstSeen(db: D1Database, key: string): Promise<number | null> {
  try {
    const row = await db.prepare('SELECT MIN(created_at) AS at FROM controller_decisions WHERE decision_key = ?1')
      .bind(key).first<{ at: number | null }>();
    return row?.at ?? null;
  } catch {
    return null; // journal pas encore créé : décision non journalisée
  }
}

export async function relayLines(db: D1Database): Promise<RelayLine[]> {
  const { results: cycles } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(RELAY_CYCLE_LIMIT).all<{ cycle_id: string }>();
  const names = await labels(db);
  const out: RelayLine[] = [];
  for (const { cycle_id } of cycles) {
    let view;
    try {
      view = await previewNextActions(db, cycle_id, 'owner', { all: true });
    } catch {
      continue;
    }
    if (view.mode !== 'active') continue;
    let holder: string | null = null;
    try {
      holder = (await db.prepare('SELECT participant_id FROM delegated_mandates WHERE cycle_id = ?1')
        .bind(cycle_id).first<{ participant_id: string | null }>())?.participant_id ?? null;
    } catch {
      holder = null;
    }
    for (const decision of view.all ?? []) {
      if (decision.actor.startsWith('policy:')) continue;
      const actor = decision.actor === 'coordinator' ? (holder ?? 'owner') : decision.actor;
      const label = actor === 'owner'
        ? (decision.actor === 'coordinator' ? 'Kevin (poste de coordinateur vacant)' : 'Kevin')
        : (names.get(actor) ?? actor) + (decision.actor === 'coordinator' ? ' (coordinateur)' : '');
      out.push({ cycle_id, actor, label, task_id: decision.task_id, action: decision.action,
        message: relayMessage(cycle_id, label, decision),
        since: await firstSeen(db, await decisionKey(cycle_id, decision)) });
      if (out.length >= RELAY_LINE_LIMIT) return out;
    }
  }
  return out;
}

/**
 * CC-5 L3d (incrément 2b-2a) — lignes « à relayer » pour Kevin.
 *
 * Les agents de chat ne se réveillent pas seuls : tant qu'aucun canal API
 * n'est financé, Kevin relaie. Cette vue lit, en LECTURE SEULE, les décisions
 * courantes du contrôleur pour chaque cycle ouvert et les rend sous forme de
 * messages courts à copier, avec l'ancienneté de la décision (première ligne
 * du journal, si le passage programmé l'a déjà écrite).
 *
 * Rien n'est écrit, rien n'est exécuté : aucune donnée n'est insérée,
 * modifiée ni supprimée. Frontière exacte (revue GPT-6 / test Vibe #174) : le
 * chemin de lecture réutilise des fonctions qui appellent `ensureSchema`
 * (amorçage idempotent `CREATE … IF NOT EXISTS`, mis en cache par isolat).
 * Sur /owner cet amorçage a déjà eu lieu avant cette section ; une fois le
 * schéma amorcé, `relayLines` n'émet que des SELECT (prouvé par test sur
 * toutes les requêtes préparées).
 *
 * Les décisions « policy:* » (avance de phase automatique) ne demandent aucun
 * relais et sont omises. Fail-closed : un cycle illisible est absent de la
 * liste (jamais d'erreur sur la page owner) ; si le mandat de coordinateur est
 * illisible, les décisions « coordinator » du cycle sont omises plutôt
 * qu'attribuées à tort (la vacance n'est retenue que si la table des mandats
 * n'existe pas encore ou ne contient pas le cycle). HALT : le contrôleur ne
 * rend aucune décision, la liste du cycle est donc vide.
 */
import { previewNextActions } from './next-actions';
import { decisionKey } from './journal';
import { RESEARCH_SCOPE, recentFailures } from './failures';
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
  action: Decision['action'] | 'check_controller';
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
  address_correction: 'traiter la demande de correction du coordinateur',
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

type MandateRead = { ok: true; holder: string | null } | { ok: false };

/** Titulaire du mandat L3c du cycle ; ok:false si la lecture échoue (aucune attribution). */
async function mandateHolder(db: D1Database, cycleId: string): Promise<MandateRead> {
  try {
    const table = await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'delegated_mandates'")
      .first<{ ok: number }>();
    if (!table) return { ok: true, holder: null };
    const row = await db.prepare('SELECT participant_id FROM delegated_mandates WHERE cycle_id = ?1')
      .bind(cycleId).first<{ participant_id: string | null }>();
    return { ok: true, holder: row?.participant_id ?? null };
  } catch {
    return { ok: false };
  }
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

/** Message pour un échec répété du passage programmé (file des échecs, 24 h). */
export function failureMessage(scope: string, error: string, hours: number, lastAt: number): string {
  const target = scope === RESEARCH_SCOPE ? 'chercheur L5' : 'cycle ' + scope;
  // `hours` = tranches horaires où un échec a été consigné (une ligne par heure), pas la durée de la panne.
  return 'Kevin — vérifier le passage programmé (' + target + ') : échec ' + error + ' consigné sur ' + hours
    + (hours > 1 ? ' heures distinctes' : ' heure') + ' (24 h glissantes), dernier à '
    + new Date(lastAt * 1000).toISOString().slice(11, 16) + ' UTC.';
}

export async function relayLines(db: D1Database, options: { now?: () => Date } = {}): Promise<RelayLine[]> {
  const { results: cycles } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(RELAY_CYCLE_LIMIT).all<{ cycle_id: string }>();
  const names = await labels(db);
  const out: RelayLine[] = [];
  // Les échecs passent en tête : ce sont des alertes d'exploitation pour Kevin.
  // l3d 2b-2b : échecs du passage programmé des dernières 24 h (lecture seule, fail-soft).
  try {
    const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
    for (const failure of await recentFailures(db, now)) {
      if (out.length >= RELAY_LINE_LIMIT) break;
      out.push({ cycle_id: failure.scope, actor: 'owner', label: 'Kevin', task_id: null, action: 'check_controller',
        message: failureMessage(failure.scope, failure.error, failure.hours, failure.last_at), since: failure.first_at });
    }
  } catch {
    // file illisible : aucune ligne d'échec, le reste de la section est conservé
  }
  for (const { cycle_id } of cycles) {
    let view;
    try {
      view = await previewNextActions(db, cycle_id, 'owner', { all: true });
    } catch {
      continue;
    }
    if (view.mode !== 'active') continue;
    const mandate = await mandateHolder(db, cycle_id);
    for (const decision of view.all ?? []) {
      if (decision.actor.startsWith('policy:')) continue;
      if (decision.actor === 'coordinator' && !mandate.ok) continue;
      const holder = mandate.ok ? mandate.holder : null;
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

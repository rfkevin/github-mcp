/**
 * CC-5 L3d — « que dois-je faire maintenant ? » pour un agent, en lecture seule.
 *
 * Calcule les décisions du contrôleur pour l'état courant du store, sans rien
 * journaliser (le journal est écrit par le passage programmé), et ne rend au
 * participant que celles qui le visent : son identité logique (famille #126),
 * plus les décisions « coordinator » s'il tient le mandat actif du cycle
 * (L3c). Un agent de chat peut ainsi reprendre sans relais de Kevin.
 * Fail-closed : instantané illisible → mode dégradé, aucune décision.
 */
import { logicalIdentityOf } from '../identity/families';
import { inspectPhase } from '../phases';
import { nextActors, type Decision } from './rules';
import { readControllerSnapshot } from './snapshot';

export interface NextActionsView {
  cycle_id: string;
  mode: 'active' | 'halted' | 'degraded';
  revision: number | null;
  error?: string;
  /** Identité logique utilisée pour le filtrage. */
  participant: string;
  /** Vrai si le participant tient le mandat de coordinateur actif du cycle. */
  coordinator: boolean;
  mine: Decision[];
  /** Nombre de décisions visant d'autres acteurs (détail seulement avec all). */
  others: number;
  all?: Decision[];
}

async function mandateHolder(db: D1Database, cycleId: string): Promise<string | null> {
  try {
    const row = await db.prepare('SELECT participant_id FROM delegated_mandates WHERE cycle_id = ?1')
      .bind(cycleId).first<{ participant_id: string | null }>();
    return row?.participant_id ?? null;
  } catch {
    return null; // table absente : aucun mandat (vacance, L3c D1)
  }
}

export async function previewNextActions(db: D1Database, cycleId: string, participantId: string,
  options: { all?: boolean } = {}): Promise<NextActionsView> {
  const participant = await logicalIdentityOf(db, participantId);
  let snapshot;
  try {
    snapshot = await readControllerSnapshot(db, cycleId, async id => (await inspectPhase(db, id)).outputsSatisfied);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return { cycle_id: cycleId, mode: 'degraded', revision: null, error: typeof code === 'string' ? code : 'CONTROLLER_SNAPSHOT_UNAVAILABLE',
      participant, coordinator: false, mine: [], others: 0 };
  }
  const holder = await mandateHolder(db, cycleId);
  const coordinator = holder !== null && await logicalIdentityOf(db, holder) === participant;
  const { mode, decisions } = nextActors(snapshot);
  const isMine = (decision: Decision) => decision.actor === participant || (coordinator && decision.actor === 'coordinator');
  const mine = decisions.filter(isMine);
  return { cycle_id: cycleId, mode, revision: snapshot.revision, participant, coordinator, mine,
    others: decisions.length - mine.length, ...(options.all ? { all: decisions } : {}) };
}

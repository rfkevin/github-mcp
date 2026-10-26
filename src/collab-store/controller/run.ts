/**
 * CC-5 L3 — un passage du contrôleur : instantané → règles → journal.
 *
 * Mode dégradé (A3c du plan) : si l'instantané ne peut pas être lu (store
 * indisponible, état illisible), le contrôleur ne décide RIEN et le signale ;
 * le fonctionnement manuel actuel (relais de Kevin, demandes owner) reste la
 * voie normale. Aucune perte d'état : le store reste la source de vérité.
 * HALT : aucune décision, mode 'halted'. Le contrôleur n'exécute jamais
 * d'action : il journalise ce qui doit être fait ; l'exécution passe par les
 * gates existantes (avance par policy, dispatch A1, demandes owner).
 */
import { inspectPhase } from '../phases';
import { sha256Hex } from '../store/hash';
import { recordDecisions } from './journal';
import { nextActors, type ControllerSnapshot, type Decision } from './rules';
import { readControllerSnapshot } from './snapshot';

export type ControllerRunResult =
  | { mode: 'active'; revision: number; decisions: Decision[]; recorded: number; reminded: number }
  | { mode: 'halted'; revision: number; decisions: []; recorded: 0 }
  | { mode: 'degraded'; error: string; decisions: []; recorded: 0 };

/** Empreinte canonique de l'instantané : rejouer le même état donne la même empreinte. */
export async function snapshotHash(snapshot: ControllerSnapshot): Promise<string> {
  const canonical = {
    ...snapshot,
    tasks: [...snapshot.tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map(task => ({ ...task, verdicts: [...task.verdicts].sort((a, b) => a.seq - b.seq) })),
  };
  return sha256Hex(JSON.stringify(canonical));
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'CONTROLLER_SNAPSHOT_UNAVAILABLE';
}

export interface ControllerRunOptions {
  now?: () => Date;
  /** Point d'injection de test : exécuté entre l'instantané et l'écriture (course HALT, R2). */
  afterSnapshot?: () => Promise<void>;
}

export async function runController(db: D1Database, cycleId: string, options: ControllerRunOptions = {}): Promise<ControllerRunResult> {
  let snapshot: ControllerSnapshot;
  try {
    snapshot = await readControllerSnapshot(db, cycleId, async id => {
      // CC-7 L6b : détail des sorties attendues pour les réveils de phase.
      const facts = await inspectPhase(db, id);
      return { satisfied: facts.outputsSatisfied, outputs: facts.outputs };
    });
  } catch (error) {
    return { mode: 'degraded', error: errorCode(error), decisions: [], recorded: 0 };
  }
  const { mode, decisions } = nextActors(snapshot);
  if (mode === 'halted') return { mode: 'halted', revision: snapshot.revision, decisions: [], recorded: 0 };
  const now = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  try {
    await options.afterSnapshot?.();
    const journal = await recordDecisions(db, {
      cycleId, revision: snapshot.revision, stateHash: await snapshotHash(snapshot), decisions, now,
    });
    // HALT posé après l'instantané : rien n'a été écrit, aucune décision n'est rendue.
    if (journal.halted) return { mode: 'halted', revision: snapshot.revision, decisions: [], recorded: 0 };
    return { mode: 'active', revision: snapshot.revision, decisions, recorded: journal.recorded.length, reminded: journal.reminded.length };
  } catch {
    // Fail-closed : une décision non journalisée n'existe pas.
    return { mode: 'degraded', error: 'CONTROLLER_JOURNAL_UNAVAILABLE', decisions: [], recorded: 0 };
  }
}

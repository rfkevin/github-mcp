/**
 * CC-5 L3d — passage programmé du contrôleur (Cron Trigger).
 *
 * Désactivé par défaut : il ne tourne que si CONTROLLER_CRON_ENABLED vaut
 * exactement « true » et que le store est monté. Un passage parcourt au plus
 * SCHEDULED_CYCLE_LIMIT cycles ouverts, l'un après l'autre ; chaque cycle est
 * isolé (une erreur sur l'un n'arrête pas les autres). Le contrôleur ne fait
 * que journaliser ses décisions (idempotent par épisode) et leurs rappels
 * bornés (2b-1) : aucun réveil réel, aucune dépense.
 *
 * 2b-1 — passage du chercheur L5 : au plus un par jour UTC pour tout le store
 * (passId déterministe, idempotent côté L5), en lecture seule sur le registre ;
 * HALT relu par L5 dans son lot d'écriture. Un échec du chercheur n'affecte
 * jamais le passage du contrôleur.
 */
import { runResearchPass, type ResearchPassStatus } from '../research/run';
import { ensureSchema } from '../store/schema';
import { runController, type ControllerRunResult } from './run';

export const SCHEDULED_CYCLE_LIMIT = 20;

export function controllerCronEnabled(value: string | undefined): boolean {
  return value === 'true';
}

/** Identifiant du passage quotidien du chercheur (jour UTC). */
export function scheduledResearchPassId(now: Date): string {
  return 'rp-daily-' + now.toISOString().slice(0, 10);
}

export interface ScheduledCycleResult { cycle_id: string; mode: ControllerRunResult['mode']; recorded: number; reminded: number; error?: string }
export interface ScheduledRunResult {
  cycles: ScheduledCycleResult[];
  research: { pass_id: string; status: ResearchPassStatus | 'failed' };
}

export async function runScheduledControllers(db: D1Database, options: { now?: () => Date } = {}): Promise<ScheduledRunResult> {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(SCHEDULED_CYCLE_LIMIT).all<{ cycle_id: string }>();
  const cycles: ScheduledCycleResult[] = [];
  for (const { cycle_id } of results) {
    try {
      const result = await runController(db, cycle_id, options);
      cycles.push({ cycle_id, mode: result.mode, recorded: result.recorded,
        reminded: result.mode === 'active' ? result.reminded : 0, ...(result.mode === 'degraded' ? { error: result.error } : {}) });
    } catch {
      cycles.push({ cycle_id, mode: 'degraded', recorded: 0, reminded: 0, error: 'CONTROLLER_RUN_FAILED' });
    }
  }
  const now = options.now ?? (() => new Date());
  const passId = scheduledResearchPassId(now());
  let status: ResearchPassStatus | 'failed';
  try {
    status = (await runResearchPass(db, { passId, now })).status;
  } catch {
    status = 'failed';
  }
  return { cycles, research: { pass_id: passId, status } };
}

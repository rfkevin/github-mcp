/**
 * CC-5 L3d — passage programmé du contrôleur (Cron Trigger).
 *
 * Désactivé par défaut : il ne tourne que si CONTROLLER_CRON_ENABLED vaut
 * exactement « true » et que le store est monté. Un passage parcourt au plus
 * SCHEDULED_CYCLE_LIMIT cycles ouverts, l'un après l'autre ; chaque cycle est
 * isolé (une erreur sur l'un n'arrête pas les autres). Le contrôleur ne fait
 * que journaliser ses décisions (idempotent par épisode) : aucun réveil réel,
 * aucune dépense.
 */
import { ensureSchema } from '../store/schema';
import { runController, type ControllerRunResult } from './run';

export const SCHEDULED_CYCLE_LIMIT = 20;

export function controllerCronEnabled(value: string | undefined): boolean {
  return value === 'true';
}

export interface ScheduledCycleResult { cycle_id: string; mode: ControllerRunResult['mode']; recorded: number; error?: string }

export async function runScheduledControllers(db: D1Database, options: { now?: () => Date } = {}): Promise<ScheduledCycleResult[]> {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(SCHEDULED_CYCLE_LIMIT).all<{ cycle_id: string }>();
  const out: ScheduledCycleResult[] = [];
  for (const { cycle_id } of results) {
    try {
      const result = await runController(db, cycle_id, options);
      out.push({ cycle_id, mode: result.mode, recorded: result.recorded, ...(result.mode === 'degraded' ? { error: result.error } : {}) });
    } catch {
      out.push({ cycle_id, mode: 'degraded', recorded: 0, error: 'CONTROLLER_RUN_FAILED' });
    }
  }
  return out;
}

import { superviseCycle } from './autonomy';
import { runResearchPass, type ResearchPassStatus } from '../research/run';
import { ensureSchema } from '../store/schema';
import { RESEARCH_SCOPE, recordFailure } from './failures';
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
  research: { pass_id: string; status: ResearchPassStatus | 'failed' | 'skipped' };
  /** l3d 2b-2b : lignes ajoutées à la file des échecs pendant ce passage. */
  failures_recorded: number;
}

/**
 * `research: false` (webhook l3d 2d) : même passage du contrôleur, sans le chercheur L5 — il reste quotidien et
 * n'est lancé que par le Cron. Par défaut (Cron), le chercheur passe au plus une fois par jour UTC.
 * 
 * CC-8 S8c : Le cron */15 agit uniquement comme un moniteur (audit, journalisation, détection d'incidents).
 * Il ne déclenche aucun run d'agent, retry ou appel de modèle de langage.
 */
export async function runScheduledControllers(db: D1Database, options: { now?: () => Date; research?: boolean; salonEnabled?: boolean } = {}): Promise<ScheduledRunResult> {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(SCHEDULED_CYCLE_LIMIT).all<{ cycle_id: string }>();
  const cycles: ScheduledCycleResult[] = [];
  for (const { cycle_id } of results) {
    try {
      const result = await runController(db, cycle_id, options);
      if (result.mode === 'active') await superviseCycle(db, cycle_id, options);
      cycles.push({ cycle_id, mode: result.mode, recorded: result.recorded,
        reminded: result.mode === 'active' ? result.reminded : 0, ...(result.mode === 'degraded' ? { error: result.error } : {}) });
    } catch {
      cycles.push({ cycle_id, mode: 'degraded', recorded: 0, reminded: 0, error: 'CONTROLLER_RUN_FAILED' });
    }
  }
  const now = options.now ?? (() => new Date());
  const passId = scheduledResearchPassId(now());
  let status: ResearchPassStatus | 'failed' | 'skipped';
  if (options.research === false) {
    status = 'skipped';
  } else {
    try {
      status = (await runResearchPass(db, { passId, now })).status;
    } catch {
      status = 'failed';
    }
  }
  // l3d 2b-2b : file des échecs (une ligne par heure et par portée/code) ; jamais bloquant.
  const at = Math.floor(now().getTime() / 1000);
  let failuresRecorded = 0;
  const failed = [
    ...cycles.filter(cycle => cycle.mode === 'degraded').map(cycle => ({ scope: cycle.cycle_id, error: cycle.error ?? 'CONTROLLER_RUN_FAILED' })),
    ...(status === 'failed' ? [{ scope: RESEARCH_SCOPE, error: 'RESEARCH_PASS_FAILED' }] : []),
  ];
  for (const failure of failed) {
    try {
      if (await recordFailure(db, { ...failure, now: at })) failuresRecorded += 1;
    } catch {
      // la file est une aide à la visibilité : son indisponibilité n'interrompt pas le passage
    }
  }
  return { cycles, research: { pass_id: passId, status }, failures_recorded: failuresRecorded };
}

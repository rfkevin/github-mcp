/**
 * CC8 S8c relay — integration auto event-first, independently gated.
 * The 15-minute cron is read-only for model/PR execution. Integration merges
 * remain possible only through already-authorized store events or signed GitHub
 * webhooks, and the existing D12 / HEAD-BASE / CI / protected-path gates.
 */
import { autoMergeGitHubFrom, type AutoMergeRootEnv } from '../../auto-merge-root';
import { announceReadyToPromote, runAutoMergePass } from './auto-merge';
import type { CollabStoreEnv } from '../store/config';

export interface IntegrationTriggerEvent { type: string; payload_json: string }
export type EventIntegrationEnv = AutoMergeRootEnv & CollabStoreEnv;

const EVIDENCE_STATES = ['SUBMITTED', 'AGREED', 'PASS'] as const;

/** Avoid an integration scan on reads, proposal chatter, and ordinary checkpoints. */
export function integrationWorthy(event: IntegrationTriggerEvent): boolean {
  if (event.type === 'owner.decision') return true;
  if (event.type !== 'evidence.add' && event.type !== 'task.status') return false;
  try {
    const payload = JSON.parse(event.payload_json) as { state?: unknown; task?: { status?: unknown } };
    if (event.type === 'task.status') return payload.task?.status === 'done' || payload.task?.status === 'verified';
    return typeof payload.state === 'string' && (EVIDENCE_STATES as readonly string[]).includes(payload.state);
  } catch { return false; }
}

/**
 * A background pass does not itself authorize a merge: the existing gates in
 * runAutoMergePass check D12, candidate PR state, CI, ownership, HALT and SHA.
 * No new ability to merge master, override D12 or change budgets is introduced.
 */
export function scheduleIntegrationPass(env: EventIntegrationEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>): boolean {
  if (!env.COLLAB_DB || (env.AUTO_MERGE_INTEGRATION !== 'true' && env.SALON_ENABLED !== 'true')) return false;
  const db = env.COLLAB_DB;
  try {
    ctx.waitUntil((async () => {
      const github = autoMergeGitHubFrom(env);
      if (github) await runAutoMergePass(db, env, github);
      await announceReadyToPromote(db, env);
    })().catch(() => undefined));
    return true;
  } catch { return false; }
}

/** Called only from a store APPLIED hook (duplicate/STALE are filtered by the store). */
export function scheduleEventIntegration(env: EventIntegrationEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>, event: IntegrationTriggerEvent): boolean {
  return integrationWorthy(event) && scheduleIntegrationPass(env, ctx);
}

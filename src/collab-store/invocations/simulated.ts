/**
 * CC-4 A1 — deterministic simulated executor. It never calls a provider.
 * Every run first rereads durable state; terminal work is never leased again.
 */
import type { InvocationRecord, InvocationUsage } from './contracts';
import { InvocationService } from './service';

export interface SimulatedRunOptions {
  worker_id?: string;
  lease_seconds?: number;
  output?: string;
  fail_with?: string;
  usage?: Partial<InvocationUsage>;
  evidence_refs?: string[];
  /** CC-4 A2 : pire cas réservé avant l'exécution (0 par défaut, chemin gratuit). */
  max_cost_cents?: number;
  /** CC-4 A2 : coût réel soldé après l'exécution (≤ réserve ; 0 pour le simulateur). */
  cost_cents?: number;
  budget_scope?: string;
}

export type SimulatedRunOutcome =
  | { status: 'succeeded' | 'attempt_failed'; invocation: InvocationRecord }
  | { status: 'terminal' | 'busy'; invocation: InvocationRecord };

export async function runSimulatedInvocation(
  service: InvocationService,
  wakeKey: string,
  options: SimulatedRunOptions = {},
): Promise<SimulatedRunOutcome> {
  await service.reconcileExpired();
  const before = await service.getByWakeKey(wakeKey);
  if (!before) throw new Error('INVOCATION_UNKNOWN');
  if (before.state === 'succeeded' || before.state === 'failed') {
    return { status: 'terminal', invocation: before };
  }
  if (before.state === 'leased' || before.state === 'running') {
    return { status: 'busy', invocation: before };
  }
  const worker = options.worker_id ?? 'simulated-a1';
  const lease = await service.lease(wakeKey, worker, options.lease_seconds ?? 300,
    { max_cost_cents: options.max_cost_cents ?? 0, scope: options.budget_scope });
  if (lease.status !== 'leased') return { status: lease.status, invocation: lease.invocation };
  await service.markRunning(wakeKey, worker);
  if (options.fail_with !== undefined) {
    const failed = await service.fail(wakeKey, worker, options.fail_with, options.usage, options.evidence_refs, options.cost_cents ?? 0);
    return { status: 'attempt_failed', invocation: failed };
  }
  const succeeded = await service.succeed(
    wakeKey,
    worker,
    options.output ?? 'simulated-ok',
    options.usage,
    options.evidence_refs,
    options.cost_cents ?? 0,
  );
  return { status: 'succeeded', invocation: succeeded };
}

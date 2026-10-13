/** CC-4 A4 (#121) — fiches exécutants pour le coordinateur. Lecture seule. */
import { ensureSchema } from '../store/schema';
import { capabilityMatrix, type CapabilityRow } from './registry';
import { DEFAULT_DAILY_CAP, DEFAULT_NEURON_BUDGET } from './run';

export interface ExecutorPerformance {
  invocations: number;
  succeeded: number;
  failed: number;
  success_rate: number;
  failures_by_code: Array<{ code: string; count: number }>;
  latency_avg_ms: number;
  latency_p95_ms: number;
}

export interface ExecutorProfile {
  endpoint_id: string;
  principal_id: string;
  provider: string;
  model: string;
  status: string;
  capability_set: CapabilityRow['capability_set'];
  token_ceiling: number | null;
  quota: {
    calls_limit: number;
    calls_used: number;
    calls_remaining: number;
    neurons_limit: number | null;
    neurons_used: number | null;
    neurons_remaining: number | null;
  };
  performance_7d: ExecutorPerformance;
  owner_notes: { strengths: string; weaknesses: string };
}

type AttemptRow = {
  attempt_state: string;
  error: string;
  running_at: number | null;
  finished_at: number | null;
};

function providerModel(attestationRef: string): { provider: string; model: string } {
  const at = attestationRef.indexOf(':');
  return at > 0
    ? { provider: attestationRef.slice(0, at), model: attestationRef.slice(at + 1) }
    : { provider: '', model: attestationRef };
}

function performance(rows: AttemptRow[]): ExecutorPerformance {
  const succeeded = rows.filter(row => row.attempt_state === 'succeeded').length;
  const failed = rows.length - succeeded;
  const errors = new Map<string, number>();
  const latencies: number[] = [];
  for (const row of rows) {
    if (row.attempt_state !== 'succeeded') {
      const code = row.error || row.attempt_state || 'EXECUTOR_ERROR';
      errors.set(code, (errors.get(code) ?? 0) + 1);
    }
    if (row.running_at !== null && row.finished_at !== null && row.finished_at >= row.running_at) {
      latencies.push((row.finished_at - row.running_at) * 1000);
    }
  }
  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0;
  const p95 = latencies.length ? (latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0) : 0;
  return {
    invocations: rows.length,
    succeeded,
    failed,
    success_rate: rows.length ? succeeded / rows.length : 0,
    failures_by_code: [...errors.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
    latency_avg_ms: avg,
    latency_p95_ms: p95,
  };
}

/**
 * Une ligne par invocation dont la dernière tentative s'est terminée dans les
 * sept derniers jours. Une invocation temporairement remise en queue apparaît
 * comme échec jusqu'à sa prochaine tentative ; elle devient succès si elle finit
 * ensuite avec succès. Les timestamps A1 sont en secondes, donc latence au ms
 * arrondie par pas de 1000 ms.
 */
async function sevenDayPerformance(db: D1Database, endpointId: string, now: Date): Promise<ExecutorPerformance> {
  const since = Math.floor(now.getTime() / 1000) - 7 * 24 * 60 * 60;
  const { results } = await db.prepare([
    'SELECT a.state AS attempt_state, a.error, a.running_at, a.finished_at',
    'FROM invocations i JOIN invocation_attempts a ON a.invocation_id = i.invocation_id AND a.attempt_no = i.attempt_count',
    'WHERE i.endpoint_id = ?1 AND a.finished_at IS NOT NULL AND a.finished_at >= ?2',
    'ORDER BY a.finished_at',
  ].join(' ')).bind(endpointId, since).all<AttemptRow>();
  return performance(results);
}

export async function listExecutorProfiles(db: D1Database, options: {
  dailyCap?: number; neuronBudget?: number; now?: () => Date;
} = {}): Promise<ExecutorProfile[]> {
  await ensureSchema(db);
  const now = options.now?.() ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const callsLimit = options.dailyCap ?? DEFAULT_DAILY_CAP;
  const neuronLimit = options.neuronBudget ?? DEFAULT_NEURON_BUDGET;
  const rows = await capabilityMatrix(db);
  const profiles: ExecutorProfile[] = [];
  for (const row of rows) {
    const { provider, model } = providerModel(row.attestation_ref);
    const calls = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
      .bind('exec:' + row.endpoint_id + ':' + day).first<{ writes: number }>();
    const callsUsed = calls?.writes ?? 0;
    let neuronsUsed: number | null = null;
    let neuronsRemaining: number | null = null;
    let neuronsLimit: number | null = null;
    if (provider === 'workers-ai') {
      const neurons = await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1')
        .bind('neurons:workers-ai:' + day).first<{ writes: number }>();
      neuronsUsed = neurons?.writes ?? 0;
      neuronsLimit = neuronLimit;
      neuronsRemaining = Math.max(0, neuronLimit - neuronsUsed);
    }
    profiles.push({
      endpoint_id: row.endpoint_id,
      principal_id: row.principal_id,
      provider,
      model,
      status: row.status,
      capability_set: row.capability_set,
      token_ceiling: row.capability_set.token_ceiling ?? null,
      quota: {
        calls_limit: callsLimit,
        calls_used: callsUsed,
        calls_remaining: Math.max(0, callsLimit - callsUsed),
        neurons_limit: neuronsLimit,
        neurons_used: neuronsUsed,
        neurons_remaining: neuronsRemaining,
      },
      performance_7d: await sevenDayPerformance(db, row.endpoint_id, now),
      owner_notes: {
        strengths: row.owner_notes?.strengths ?? '',
        weaknesses: row.owner_notes?.weaknesses ?? '',
      },
    });
  }
  return profiles;
}

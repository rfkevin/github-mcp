/**
 * CC-8 S4 — model.finding + sonde unique.
 * Identité complète (kind, candidate_ref, source_url, as_of, detail_hash).
 * probe_triggered=1 seulement si mesure live provider complétée.
 */
import { isAutomationHalted } from '../owner/automation';
import { isPinnedRef } from './promote/decision';
import { probeAttemptCompleted, runModelProbe, type ProbeEnv, type ProbeOutcome } from './probe';
import { officialUrl } from './research';

export const FINDING_KINDS = ['price_change', 'new_model', 'model_retired', 'effort_change', 'other'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const ensured = new WeakSet<D1Database>();
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

async function ensureFindingSchema(db: D1Database): Promise<void> {
  if (ensured.has(db)) return;
  await db.batch([
    db.prepare([
      'CREATE TABLE IF NOT EXISTS model_findings (',
      '  finding_id TEXT PRIMARY KEY,',
      '  at INTEGER NOT NULL,',
      '  kind TEXT NOT NULL,',
      '  candidate_ref TEXT NOT NULL,',
      '  source_url TEXT NOT NULL,',
      '  as_of TEXT NOT NULL,',
      '  detail_json TEXT NOT NULL,',
      '  detail_hash TEXT NOT NULL DEFAULT "",',
      '  probe_triggered INTEGER NOT NULL DEFAULT 0,',
      '  status TEXT NOT NULL',
      ')',
    ].join(' ')),
  ]);
  ensured.add(db);
}

export interface ModelFindingInput {
  finding_id?: string;
  kind: string;
  candidate_ref: string;
  source_url: string;
  as_of: string;
  detail?: Record<string, unknown>;
  trigger_probe?: boolean;
  allowSimulation?: boolean;
  now?: number;
}

export interface ModelFindingRecord {
  finding_id: string;
  at: number;
  kind: FindingKind;
  candidate_ref: string;
  source_url: string;
  as_of: string;
  status: 'recorded' | 'duplicate' | 'halted' | 'rejected' | 'resumed_probe';
  probe?: ProbeOutcome;
  error?: string;
}

async function detailHashOf(detailJson: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(detailJson));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function markProbeIfCompleted(db: D1Database, findingId: string, probe: ProbeOutcome): Promise<void> {
  // GPT-6 : ne pas marquer sondé après not_implemented/disabled.
  if (!probeAttemptCompleted(probe)) return;
  await db.prepare('UPDATE model_findings SET probe_triggered = 1 WHERE finding_id = ?1').bind(findingId).run();
}

export async function recordModelFinding(
  db: D1Database,
  env: ProbeEnv,
  input: ModelFindingInput,
): Promise<ModelFindingRecord> {
  await ensureFindingSchema(db);
  const at = input.now ?? Math.floor(Date.now() / 1000);
  const findingId = input.finding_id ?? 'mf-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const kindFallback: FindingKind = (FINDING_KINDS as readonly string[]).includes(input.kind)
    ? (input.kind as FindingKind) : 'other';

  if (await isAutomationHalted(db)) {
    return {
      finding_id: findingId, at, kind: kindFallback, candidate_ref: input.candidate_ref,
      source_url: String(input.source_url ?? ''), as_of: String(input.as_of ?? ''),
      status: 'halted', error: 'HALT_ACTIVE',
    };
  }
  if (!(FINDING_KINDS as readonly string[]).includes(input.kind)) {
    return {
      finding_id: findingId, at, kind: 'other', candidate_ref: input.candidate_ref,
      source_url: '', as_of: '', status: 'rejected', error: 'kind_invalid',
    };
  }
  const kind = input.kind as FindingKind;
  if (!isPinnedRef(input.candidate_ref)) {
    return {
      finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
      source_url: '', as_of: '', status: 'rejected', error: 'ref_non_epinglee',
    };
  }
  const url = officialUrl(input.source_url);
  if (!url) {
    return {
      finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
      source_url: String(input.source_url ?? ''), as_of: '', status: 'rejected', error: 'source_not_official',
    };
  }
  if (typeof input.as_of !== 'string' || !AS_OF_RE.test(input.as_of)) {
    return {
      finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
      source_url: url.toString(), as_of: String(input.as_of ?? ''), status: 'rejected', error: 'as_of_invalid',
    };
  }

  const detailJson = JSON.stringify(input.detail ?? {});
  const detailHash = await detailHashOf(detailJson);
  const sourceStr = url.toString();

  const existing = await db.prepare(
    'SELECT finding_id, kind, candidate_ref, source_url, as_of, detail_hash, probe_triggered, status FROM model_findings WHERE finding_id = ?1',
  ).bind(findingId).first<{
    finding_id: string; kind: string; candidate_ref: string; source_url: string;
    as_of: string; detail_hash: string | null; probe_triggered: number; status: string;
  }>();

  if (existing) {
    const identityMismatch =
      existing.kind !== kind
      || existing.candidate_ref !== input.candidate_ref
      || existing.source_url !== sourceStr
      || existing.as_of !== input.as_of
      || (existing.detail_hash ?? '') !== detailHash;
    if (identityMismatch) {
      return {
        finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
        source_url: sourceStr, as_of: input.as_of, status: 'rejected', error: 'finding_id_conflict',
      };
    }
    if (input.trigger_probe && existing.probe_triggered === 0) {
      const probe = await runModelProbe(db, env, {
        candidate_ref: input.candidate_ref,
        source: 'model_finding',
        finding_id: findingId,
        now: at,
        allowSimulation: input.allowSimulation,
      });
      await markProbeIfCompleted(db, findingId, probe);
      return {
        finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
        source_url: sourceStr, as_of: input.as_of, status: 'resumed_probe', probe,
      };
    }
    return {
      finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
      source_url: sourceStr, as_of: input.as_of, status: 'duplicate',
    };
  }

  await db.prepare([
    'INSERT INTO model_findings (finding_id, at, kind, candidate_ref, source_url, as_of, detail_json, detail_hash, probe_triggered, status)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)',
  ].join(' ')).bind(findingId, at, kind, input.candidate_ref, sourceStr, input.as_of, detailJson, detailHash, 'recorded').run();

  let probe: ProbeOutcome | undefined;
  if (input.trigger_probe) {
    probe = await runModelProbe(db, env, {
      candidate_ref: input.candidate_ref,
      source: 'model_finding',
      finding_id: findingId,
      now: at,
      allowSimulation: input.allowSimulation,
    });
    await markProbeIfCompleted(db, findingId, probe);
  }

  return {
    finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
    source_url: sourceStr, as_of: input.as_of, status: 'recorded',
    ...(probe ? { probe } : {}),
  };
}

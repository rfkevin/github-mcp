/**
 * CC-8 S4 — veille typée model.finding (CC-PLAN-8).
 *
 * Une trouvaille (prix/modèle, source officielle, ref épinglée, as_of) est
 * enregistrée en D1 puis peut déclencher la sonde unique (probe.ts) sans chat.
 * HALT coupe enregistrement + sonde. AGENT_RUN_RESEARCH off n’empêche pas un
 * finding manuel de test (owner/test) mais la veille auto reste sous RESEARCH.
 */
import { isAutomationHalted } from '../owner/automation';
import { isPinnedRef } from './promote/decision';
import { runModelProbe, type ProbeEnv, type ProbeOutcome } from './probe';
import { officialUrl } from './research';

export const FINDING_KINDS = ['price_change', 'new_model', 'model_retired', 'effort_change', 'other'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const ensured = new WeakSet<D1Database>();

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
  /** Date ISO YYYY-MM-DD du tarif / annonce. */
  as_of: string;
  detail?: Record<string, unknown>;
  /** Si true, enchaîne runModelProbe après enregistrement. */
  trigger_probe?: boolean;
  now?: number;
}

export interface ModelFindingRecord {
  finding_id: string;
  at: number;
  kind: FindingKind;
  candidate_ref: string;
  source_url: string;
  as_of: string;
  status: 'recorded' | 'duplicate' | 'halted' | 'rejected';
  probe?: ProbeOutcome;
  error?: string;
}

const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Enregistre un model.finding et optionnellement lance la sonde unique. */
export async function recordModelFinding(
  db: D1Database,
  env: ProbeEnv,
  input: ModelFindingInput,
): Promise<ModelFindingRecord> {
  await ensureFindingSchema(db);
  const at = input.now ?? Math.floor(Date.now() / 1000);
  const findingId = input.finding_id ?? 'mf-' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  if (await isAutomationHalted(db)) {
    return {
      finding_id: findingId,
      at,
      kind: (FINDING_KINDS as readonly string[]).includes(input.kind) ? (input.kind as FindingKind) : 'other',
      candidate_ref: input.candidate_ref,
      source_url: String(input.source_url ?? ''),
      as_of: String(input.as_of ?? ''),
      status: 'halted',
      error: 'HALT_ACTIVE',
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

  const existing = await db.prepare('SELECT finding_id, status FROM model_findings WHERE finding_id = ?1')
    .bind(findingId).first<{ finding_id: string; status: string }>();
  if (existing) {
    return {
      finding_id: findingId, at, kind, candidate_ref: input.candidate_ref,
      source_url: url.toString(), as_of: input.as_of, status: 'duplicate',
    };
  }

  const detailJson = JSON.stringify(input.detail ?? {});
  await db.prepare([
    'INSERT INTO model_findings (finding_id, at, kind, candidate_ref, source_url, as_of, detail_json, probe_triggered, status)',
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)',
  ].join(' ')).bind(findingId, at, kind, input.candidate_ref, url.toString(), input.as_of, detailJson, 'recorded').run();

  let probe: ProbeOutcome | undefined;
  if (input.trigger_probe) {
    probe = await runModelProbe(db, env, {
      candidate_ref: input.candidate_ref,
      source: 'model_finding',
      finding_id: findingId,
      now: at,
    });
    await db.prepare('UPDATE model_findings SET probe_triggered = 1 WHERE finding_id = ?1').bind(findingId).run();
  }

  return {
    finding_id: findingId,
    at,
    kind,
    candidate_ref: input.candidate_ref,
    source_url: url.toString(),
    as_of: input.as_of,
    status: 'recorded',
    ...(probe ? { probe } : {}),
  };
}

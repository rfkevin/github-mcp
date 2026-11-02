import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runModelProbe, probeEnabled } from '../../../src/collab-store/agentrun/probe';
import { recordModelFinding } from '../../../src/collab-store/agentrun/model-finding';
import { isPinnedRef } from '../../../src/collab-store/agentrun/promote/decision';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_993_000_000;

describe('CC-8 S4 — sonde unique + model.finding', () => {
  it('probeEnabled fail-closed sauf exact true', () => {
    expect(probeEnabled(undefined)).toBe(false);
    expect(probeEnabled({})).toBe(false);
    expect(probeEnabled({ AGENT_RUN_PROBE: '1' })).toBe(false);
    expect(probeEnabled({ AGENT_RUN_PROBE: 'true' })).toBe(true);
  });

  it('runModelProbe : ref non épinglée rejetée', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, {}, {
      candidate_ref: 'gemini:latest',
      source: 'test',
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.mode).toBe('rejected');
    expect(out.error).toBe('ref_non_epinglee');
  });

  it('runModelProbe : mock coût 0 quand PROBE off', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, {}, {
      candidate_ref: 'google:gemini-3.6-flash',
      source: 'owner_button',
      now: NOW,
    });
    expect(isPinnedRef('google:gemini-3.6-flash')).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.tools_ok).toBe(true);
    expect(out.mode).toBe('mock');
    expect(out.cost_micro_cents).toBe(0);
    expect(out.efforts_ok.length).toBeGreaterThan(0);
  });

  it('recordModelFinding : source non officielle refusée', async () => {
    await ensureSchema(db);
    const out = await recordModelFinding(db, {}, {
      finding_id: 'mf-test-bad-src',
      kind: 'price_change',
      candidate_ref: 'google:gemini-3.6-flash',
      source_url: 'https://evil.example/pricing',
      as_of: '2026-11-02',
      now: NOW,
    });
    expect(out.status).toBe('rejected');
    expect(out.error).toBe('source_not_official');
  });

  it('recordModelFinding + trigger_probe : enregistré et sonde mock', async () => {
    await ensureSchema(db);
    const id = 'mf-test-ok-' + NOW;
    const out = await recordModelFinding(db, {}, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.8-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      detail: { note: 'test S4' },
      trigger_probe: true,
      now: NOW,
    });
    expect(out.status).toBe('recorded');
    expect(out.probe?.ok).toBe(true);
    expect(out.probe?.mode).toBe('mock');
    expect(out.probe?.finding_id).toBe(id);

    const row = await db.prepare('SELECT probe_triggered, status FROM model_findings WHERE finding_id = ?1')
      .bind(id).first<{ probe_triggered: number; status: string }>();
    expect(row?.status).toBe('recorded');
    expect(row?.probe_triggered).toBe(1);

    const dup = await recordModelFinding(db, {}, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.8-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      now: NOW + 1,
    });
    expect(dup.status).toBe('duplicate');
  });
});

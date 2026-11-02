import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runModelProbe, probeEnabled, probeUsableForPromotion } from '../../../src/collab-store/agentrun/probe';
import { recordModelFinding } from '../../../src/collab-store/agentrun/model-finding';
import { isPinnedRef } from '../../../src/collab-store/agentrun/promote/decision';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 1_993_100_000;

describe('CC-8 S4 — sonde fail-closed + model.finding', () => {
  it('probeEnabled fail-closed sauf exact true', () => {
    expect(probeEnabled(undefined)).toBe(false);
    expect(probeEnabled({})).toBe(false);
    expect(probeEnabled({ AGENT_RUN_PROBE: '1' })).toBe(false);
    expect(probeEnabled({ AGENT_RUN_PROBE: 'true' })).toBe(true);
  });

  it('ref non épinglée rejetée', async () => {
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

  it('PROBE off → disabled ok=false (pas de faux succès)', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, {}, {
      candidate_ref: 'google:gemini-3.6-flash',
      source: 'owner_button',
      now: NOW,
    });
    expect(isPinnedRef('google:gemini-3.6-flash')).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.mode).toBe('disabled');
    expect(out.error).toBe('PROBE_DISABLED');
    expect(probeUsableForPromotion(out)).toBe(false);
  });

  it('PROBE on sans provider → not_implemented ok=false', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, { AGENT_RUN_PROBE: 'true' }, {
      candidate_ref: 'google:nonexistent-model-2099',
      source: 'test',
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.mode).toBe('not_implemented');
    expect(out.error).toBe('PROBE_NOT_IMPLEMENTED');
    expect(probeUsableForPromotion(out)).toBe(false);
  });

  it('allowSimulation : ok test-only, non utilisable promotion', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, {}, {
      candidate_ref: 'google:gemini-3.6-flash',
      source: 'test',
      allowSimulation: true,
      now: NOW,
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('simulated');
    expect(out.provenance).toBe('simulation');
    expect(probeUsableForPromotion(out)).toBe(false);
  });

  it('recordModelFinding : source non officielle refusée', async () => {
    await ensureSchema(db);
    const out = await recordModelFinding(db, {}, {
      finding_id: 'mf-test-bad-src2',
      kind: 'price_change',
      candidate_ref: 'google:gemini-3.6-flash',
      source_url: 'https://evil.example/pricing',
      as_of: '2026-11-02',
      now: NOW,
    });
    expect(out.status).toBe('rejected');
    expect(out.error).toBe('source_not_official');
  });

  it('finding + trigger_probe sans simu → probe disabled ok=false', async () => {
    await ensureSchema(db);
    const id = 'mf-test-ok2-' + NOW;
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
    expect(out.probe?.ok).toBe(false);
    expect(out.probe?.mode).toBe('disabled');
    expect(out.probe?.finding_id).toBe(id);
  });
});

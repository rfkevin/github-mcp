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

  it('PROBE on fournisseur non câblé → not_implemented', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, { AGENT_RUN_PROBE: 'true' }, {
      candidate_ref: 'xai:grok-4.5',
      source: 'test',
      now: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.mode).toBe('not_implemented');
    expect(out.error).toBe('PROBE_NOT_IMPLEMENTED');
  });

  it('PROBE on gemini sans clé → live mesuré NO_GEMINI_KEY', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, { AGENT_RUN_PROBE: 'true' }, {
      candidate_ref: 'gemini:gemini-3.6-flash',
      source: 'test',
      now: NOW,
    });
    expect(out.mode).toBe('live');
    expect(out.provenance).toBe('provider');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('NO_GEMINI_KEY');
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

  it('finding + trigger_probe → disabled, probe_triggered reste 0', async () => {
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
    expect(out.probe?.mode).toBe('disabled');
    const row = await db.prepare('SELECT probe_triggered FROM model_findings WHERE finding_id = ?1')
      .bind(id).first<{ probe_triggered: number }>();
    expect(row?.probe_triggered).toBe(0);
  });

  it('finding_id même détail, candidat différent → conflict', async () => {
    await ensureSchema(db);
    const id = 'mf-id-conflict-' + NOW;
    await recordModelFinding(db, {}, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.6-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      detail: { x: 1 },
      now: NOW,
    });
    const conflict = await recordModelFinding(db, {}, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.8-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      detail: { x: 1 },
      now: NOW + 1,
    });
    expect(conflict.status).toBe('rejected');
    expect(conflict.error).toBe('finding_id_conflict');
  });
});

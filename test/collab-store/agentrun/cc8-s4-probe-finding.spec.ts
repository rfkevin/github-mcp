import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { runModelProbe, probeEnabled, probeUsableForPromotion, probeAttemptCompleted } from '../../../src/collab-store/agentrun/probe';
import { recordModelFinding } from '../../../src/collab-store/agentrun/model-finding';
import { tryRecordFindingFromResearchNote } from '../../../src/collab-store/agentrun/research';
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

  it('PROBE on gemini sans clé → not_implemented, sonde non consommée', async () => {
    await ensureSchema(db);
    const out = await runModelProbe(db, { AGENT_RUN_PROBE: 'true' }, {
      candidate_ref: 'gemini:gemini-3.6-flash',
      source: 'test',
      now: NOW,
    });
    expect(out.mode).toBe('not_implemented');
    expect(out.provenance).toBe('none');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('NO_GEMINI_KEY');
    expect(probeAttemptCompleted(out)).toBe(false);
  });

  it('functionCall null / nom invalide → tools_ok false', async () => {
    await ensureSchema(db);
    const mockNull = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: null }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const outNull = await runModelProbe(db, {
      AGENT_RUN_PROBE: 'true',
      LLM_KEY_GEMINI: 'test-key',
      probeFetch: mockNull as typeof fetch,
    }, { candidate_ref: 'gemini:gemini-3.6-flash', source: 'test', now: NOW });
    expect(outNull.mode).toBe('live');
    expect(outNull.ok).toBe(false);
    expect(outNull.tools_ok).toBe(false);
    expect(probeUsableForPromotion(outNull)).toBe(false);

    const mockBad = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'other', args: { ok: true } } }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const outBad = await runModelProbe(db, {
      AGENT_RUN_PROBE: 'true',
      LLM_KEY_GEMINI: 'test-key',
      probeFetch: mockBad as typeof fetch,
    }, { candidate_ref: 'gemini:gemini-3.6-flash', source: 'test', now: NOW + 1 });
    expect(outBad.tools_ok).toBe(false);
    expect(probeUsableForPromotion(outBad)).toBe(false);
  });

  it('finding sans clé → probe_triggered=0 puis reprise avec clé mock', async () => {
    await ensureSchema(db);
    const id = 'mf-nokey-resume-' + NOW;
    const first = await recordModelFinding(db, { AGENT_RUN_PROBE: 'true' }, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.6-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      detail: { n: 1 },
      trigger_probe: true,
      now: NOW,
    });
    expect(first.status).toBe('recorded');
    expect(first.probe?.error).toBe('NO_GEMINI_KEY');
    const row1 = await db.prepare('SELECT probe_triggered FROM model_findings WHERE finding_id = ?1')
      .bind(id).first<{ probe_triggered: number }>();
    expect(row1?.probe_triggered).toBe(0);

    const mockFetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'probe_ping', args: { ok: true } } }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const second = await recordModelFinding(db, {
      AGENT_RUN_PROBE: 'true',
      LLM_KEY_GEMINI: 'test-key',
      probeFetch: mockFetch as typeof fetch,
    }, {
      finding_id: id,
      kind: 'new_model',
      candidate_ref: 'google:gemini-3.6-flash',
      source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      as_of: '2026-11-02',
      detail: { n: 1 },
      trigger_probe: true,
      now: NOW + 1,
    });
    expect(second.status).toBe('resumed_probe');
    expect(second.probe?.ok).toBe(true);
    const row2 = await db.prepare('SELECT probe_triggered FROM model_findings WHERE finding_id = ?1')
      .bind(id).first<{ probe_triggered: number }>();
    expect(row2?.probe_triggered).toBe(1);
  });

  it('PROBE on gemini + mock fetch functionCall → live tools_ok, usable promotion', async () => {
    await ensureSchema(db);
    const mockFetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'probe_ping', args: { ok: true } } }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const out = await runModelProbe(db, {
      AGENT_RUN_PROBE: 'true',
      LLM_KEY_GEMINI: 'test-key-not-real',
      probeFetch: mockFetch as typeof fetch,
    }, {
      candidate_ref: 'gemini:gemini-3.6-flash',
      source: 'test',
      now: NOW,
    });
    expect(out.mode).toBe('live');
    expect(out.provenance).toBe('provider');
    expect(out.ok).toBe(true);
    expect(out.tools_ok).toBe(true);
    expect(probeUsableForPromotion(out)).toBe(true);
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

  it('FINDING salon veille-prix → record puis resumed_probe (probeEnv vide)', async () => {
    await ensureSchema(db);
    const body = 'FINDING google:gemini-3.6-flash https://ai.google.dev/gemini-api/docs/pricing 2026-11-02 new_model';
    const first = await tryRecordFindingFromResearchNote(db, 'veille-prix-2026-11-02', body, NOW, {});
    expect(first).not.toBeNull();
    expect(first!.status).toBe('recorded');
    // trigger_probe=true + probe_triggered=0 + probeEnv {} → resumed_probe (déterministe)
    const second = await tryRecordFindingFromResearchNote(db, 'veille-prix-2026-11-02', body, NOW + 1, {});
    expect(second!.status).toBe('resumed_probe');
    expect(second!.finding_id).toBe(first!.finding_id);
  });

  it('sans ligne FINDING → null (outbox none)', async () => {
    await ensureSchema(db);
    const out = await tryRecordFindingFromResearchNote(db, 'veille-prix-2026-11-02', 'aucun finding ici', NOW, {});
    expect(out).toBeNull();
  });
});

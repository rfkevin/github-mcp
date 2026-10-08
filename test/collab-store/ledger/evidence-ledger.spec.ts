import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EvidenceLedger } from '../../../src/collab-store/ledger/evidence-ledger';
import { StateContractError } from '../../../src/collab/contracts';

const bindings = env as unknown as { COLLAB_DB_C2: D1Database };

describe('CC-3 C4 — evidence ledger (I11)', () => {
  it('appends and lists by subject', async () => {
    const ledger = new EvidenceLedger(bindings.COLLAB_DB_C2, () => new Date('2026-10-08T00:00:00Z'));
    const row = await ledger.append({
      subject_pid: 'agent:a',
      producer: 'agent:b',
      kind: 'test',
      payload_json: JSON.stringify({ verdict: 'PASS', lot: 'C4' }),
      evidence_ref: 'pr:c4#test',
    });
    expect(row.seq).toBeGreaterThan(0);
    expect(row.subject_pid).toBe('agent:a');
    const list = await ledger.listBySubject('agent:a');
    expect(list.some((r) => r.seq === row.seq)).toBe(true);
  });

  it('rejects producer = subject unless system', async () => {
    const ledger = new EvidenceLedger(bindings.COLLAB_DB_C2);
    await expect(
      ledger.append({
        subject_pid: 'agent:a',
        producer: 'agent:a',
        kind: 'metric',
        payload_json: '{"n":1}',
      }),
    ).rejects.toBeInstanceOf(StateContractError);

    const sys = await ledger.append({
      subject_pid: 'agent:a',
      producer: 'system',
      kind: 'metric',
      payload_json: '{"n":1}',
    });
    expect(sys.producer).toBe('system');
  });

  it('has no update path — second append is a new seq', async () => {
    const ledger = new EvidenceLedger(bindings.COLLAB_DB_C2);
    const a = await ledger.append({
      subject_pid: 'agent:x',
      producer: 'agent:y',
      kind: 'review_verdict',
      payload_json: '{"v":"agree"}',
    });
    const b = await ledger.append({
      subject_pid: 'agent:x',
      producer: 'agent:y',
      kind: 'review_verdict',
      payload_json: '{"v":"agree"}',
    });
    expect(b.seq).toBeGreaterThan(a.seq);
  });
});

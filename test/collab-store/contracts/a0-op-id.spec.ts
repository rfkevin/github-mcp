import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { parseOpId, validateOpId } from '../../../src/collab-store/contracts';
import { StateContractError } from '../../../src/collab/contracts';
import { countEvents, expectRejected, makeDatedStore } from '../a0-helpers';

// CC-4 A0 (point 1, github-mcp#110) — grammaire stricte de l'op_id
// {client}:{cycle}:{op}:{n} : exactement quatre segments, aucun deux-points
// interne. Les ids réels fautifs du cycle cc4-design (seq 103/104 :
// « op:op:vibe:cc4-design:p2-review:1 », « op:vibe:cc4-design:p2-review:1 »)
// étaient acceptés par l'ancienne grammaire relâchée : ils sont maintenant un
// INVALID_OP_ID dur, jugé avant toute écriture (le rejeu reste prioritaire).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;

function uniq(label: string): string {
  counter += 1;
  return ('a0op-' + label + '-' + counter).slice(0, 64);
}

/** Checkpoint d'ouverture typique, au participant et à l'op_id donnés. */
function checkpoint(cycle: string, participant: string, opId: string, expectedRev = 0) {
  return { cycle_id: cycle, type: 'checkpoint' as const, participant_id: participant,
    expected_rev: expectedRev, payload_json: '{"n":1}', op_id: opId };
}

describe('CC-4 A0 (point 1) — op_id strict {client}:{cycle}:{op}:{n}', () => {
  it('parseOpId : quatre segments exacts, chacun sans deux-points', async () => {
    expect(parseOpId('vibe:cc4-design:p2-review:1'))
      .toEqual({ client: 'vibe', cycle: 'cc4-design', op: 'p2-review', n: '1' });
    expect(validateOpId('grok:cc4-design:source-check:12')).toBe('grok:cc4-design:source-check:12');
    for (const bad of [
      'vibe:cc4-design:p2-review',            // 3 segments
      'vibe:cc4-design:p2-review:1:2',        // 5 segments
      'op:op:vibe:cc4-design:p2-review:1',    // 6 segments (seq 103 réel)
      'op:vibe:cc4-design:p2-review:1',       // préfixe op: (seq 104 réel)
      'vibe:cc4-design:rev.iew:1',            // point interdit dans un segment
      ':vibe:cc4-design:review:1',            // segment client vide
      'vibe::review:1',                       // segment cycle vide
    ]) {
      await expectRejected(() => parseOpId(bad), StateContractError, 'INVALID_OP_ID', bad);
    }
  });

  it('les ids réels fautifs du cycle cc4-design : INVALID_OP_ID dur, rien écrit', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('faulty');
    for (const opId of ['op:op:vibe:cc4-design:p2-review:1', 'op:vibe:cc4-design:p2-review:1']) {
      await expectRejected(() => store.appendEvent(checkpoint(cycle, 'vibe', opId)), StateContractError, 'INVALID_OP_ID', opId);
    }
    expect(await countEvents(db, cycle)).toBe(0);
  });

  it('segment client = participant serveur (pid sans deux-points) : applied', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('client');
    const applied = await store.appendEvent(checkpoint(cycle, 'vibe', 'vibe:' + cycle + ':cp:1'));
    expect(applied.status).toBe('applied');
  });

  it('segment client ≠ participant sans deux-points : INVALID_OP_ID (CollabStoreError)', async () => {
    const cycle = uniq('mismatch');
    const imposture = checkpoint(cycle, 'grok', 'vibe:' + cycle + ':cp:1');
    await expectRejected(() => makeDatedStore(db).appendEvent(imposture), CollabStoreError, 'INVALID_OP_ID', 'client ≠ participant');
    expect(await countEvents(db, cycle)).toBe(0);
  });

  it('exemption documentée : ids legacy avec deux-points (agent:a, pseudonymes unregistered:)', async () => {
    const legacyPid = 'agent:a';
    const cycle = uniq('legacy');
    const applied = await makeDatedStore(db).appendEvent(checkpoint(cycle, legacyPid, 't:' + cycle + ':cp:1'));
    expect(applied.status).toBe('applied');
  });

  it('segment cycle erroné : INVALID_OP_ID même pour un participant exempté (compat A05)', async () => {
    const exempted = 'agent:a';
    const cycle = uniq('cycle');
    const wrongCycle = checkpoint(cycle, exempted, 't:autre-cycle:cp:1');
    const store = makeDatedStore(db);
    await expectRejected(() => store.appendEvent(wrongCycle), CollabStoreError, 'INVALID_OP_ID', 'segment cycle erroné');
    expect(await countEvents(db, cycle)).toBe(0);
  });

  it('rejeu du même op_id : duplicate, jugé avant les égalités (réponse perdue)', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('replay');
    const input = checkpoint(cycle, 'vibe', 'vibe:' + cycle + ':cp:1');
    const first = await store.appendEvent(input);
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(input);
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
  });
});

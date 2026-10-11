import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { countEvents, countSealed, expectRejected, insertEventRow, makeDatedStore } from '../a0-helpers';

// CC-4 A0 (point 5, github-mcp#110) — une seule sortie par participant et par
// phase : le 2e proposal.submit du même participant dans la MÊME ronde (depuis
// la dernière (re)entrée dans cette phase, CR-F01) est refusé
// PROPOSAL_ALREADY_SUBMITTED, réponse perdue ou pas (cas réel GPT-6, seq 95/96
// du cycle cc4-design). La garde a deux étages : pré-check en lecture seule
// puis clause NOT EXISTS dans le batch CAS (fail-closed sous concurrence).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let counter = 0;

function uniq(label: string): string {
  counter += 1;
  return ('a0pg-' + label + '-' + counter).slice(0, 64);
}

/** Ouverture du cycle par checkpoint (rev 0 → 1), sous le participant vibe. */
async function openCycle(store: ReturnType<typeof makeDatedStore>, cycle: string): Promise<void> {
  expect((await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: 'vibe',
    expected_rev: 0, payload_json: '{"n":1}', op_id: 'vibe:' + cycle + ':cp:1' })).status).toBe('applied');
}

function propose(cycle: string, pid: string, expectedRev: number, opN: number, content: string) {
  return { cycle_id: cycle, type: 'proposal.submit' as const, participant_id: pid,
    expected_rev: expectedRev, payload_json: JSON.stringify({ content }),
    op_id: pid + ':' + cycle + ':prop:' + opN };
}

describe('CC-4 A0 (point 5) — une seule proposition par participant et par ronde', () => {
  it('2e proposal.submit du même participant : PROPOSAL_ALREADY_SUBMITTED, rien écrit', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('round');
    await openCycle(store, cycle);
    const first = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(first.status).toBe('applied');
    await expectRejected(() => store.appendEvent(propose(cycle, 'vibe', 2, 2, 'plan-b')),
      CollabStoreError, 'PROPOSAL_ALREADY_SUBMITTED', 'second proposal.submit');
    expect(await countEvents(db, cycle, 'proposal.submit')).toBe(1);
    expect(await countSealed(db, cycle)).toBe(1);
  });

  it('rejeu du même op_id : duplicate, la garde ne masque jamais un rejeu', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('replay');
    await openCycle(store, cycle);
    const first = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(first.status).toBe('applied');
    const retry = await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'));
    expect(retry.status).toBe('duplicate');
    expect((retry as { event: { seq: number } }).event.seq).toBe((first as { event: { seq: number } }).event.seq);
    expect(await countEvents(db, cycle, 'proposal.submit')).toBe(1);
  });

  it('un autre participant peut proposer dans la même ronde', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('other');
    await openCycle(store, cycle);
    expect((await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'))).status).toBe('applied');
    const second = await store.appendEvent(propose(cycle, 'grok', 2, 1, 'plan-g'));
    expect(second.status).toBe('applied');
    expect(await countSealed(db, cycle)).toBe(2);
  });

  it('ronde suivante : après une (re)entrée dans la phase, le même participant peut proposer à nouveau', async () => {
    const store = makeDatedStore(db);
    const cycle = uniq('nextround');
    await openCycle(store, cycle);
    expect((await store.appendEvent(propose(cycle, 'vibe', 1, 1, 'plan-a'))).status).toBe('applied');
    // (Re)entrée dans P1 (CR-F01) : phase.advance inséré hors du chemin agent.
    await insertEventRow(db, { cycle, type: 'phase.advance', participant: 'policy:a0-policy',
      role: 'policy', payload: { to: 'P1' }, key: 'seed-advance-' + cycle, expectedRev: 2 });
    const again = await store.appendEvent(propose(cycle, 'vibe', 2, 2, 'plan-a2'));
    expect(again.status).toBe('applied');
    expect(await countSealed(db, cycle)).toBe(2);
  });
});

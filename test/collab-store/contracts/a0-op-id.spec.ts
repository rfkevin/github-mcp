import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';
import { MAX_OP_ID_LENGTH, opIdClientFor, opIdToIdempotencyKey, parseOpId, validateOpId } from '../../../src/collab-store/contracts';
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

  it('participant avec deux-points : segment client canonique « : » → « . » (agent:a → agent.a), sans exemption', async () => {
    const legacyPid = 'agent:a';
    const cycle = uniq('legacy');
    const store = makeDatedStore(db);
    await expectRejected(() => store.appendEvent(checkpoint(cycle, legacyPid, 't:' + cycle + ':cp:1')),
      CollabStoreError, 'INVALID_OP_ID', 'client arbitraire pour un id à deux-points');
    expect(await countEvents(db, cycle)).toBe(0);
    const applied = await store.appendEvent(checkpoint(cycle, legacyPid, opIdClientFor(legacyPid) + ':' + cycle + ':cp:1'));
    expect(applied.status).toBe('applied');
    expect(opIdClientFor('unregistered:0123456789abcdef')).toBe('unregistered.0123456789abcdef');
  });

  it('review GPT-6 R1 : un pseudonyme unregistered ne peut pas réserver le namespace d’un autre (gpt6), rien n’est écrit', async () => {
    const squatter = 'unregistered:0123456789abcdef';
    const cycle = uniq('squat');
    const store = makeDatedStore(db);
    const squat = { cycle_id: cycle, type: 'owner.request' as const, participant_id: squatter, expected_rev: 0,
      payload_json: '{"request_id":"r1"}', op_id: 'gpt6:' + cycle + ':req:1' };
    await expectRejected(() => store.appendEvent(squat), CollabStoreError, 'INVALID_OP_ID', 'squat du namespace gpt6');
    expect(await countEvents(db, cycle)).toBe(0);
    // Le vrai titulaire écrit ensuite sous sa clé, sans IDEMPOTENCY_CONFLICT.
    const owned = await store.appendEvent(checkpoint(cycle, 'gpt6', 'gpt6:' + cycle + ':req:1'));
    expect(owned.status).toBe('applied');
    // Rejeu prioritaire : la même clé rejouée par un autre auteur reste un conflit d'intention, sans écriture.
    await expectRejected(() => store.appendEvent({ ...squat, expected_rev: 1 }), CollabStoreError, 'IDEMPOTENCY_CONFLICT', 'rejeu par un autre auteur');
    expect(await countEvents(db, cycle)).toBe(1);
  });

  it('review GPT-6 R3 : deux op_id de 256 caractères partageant 253 caractères ne collisionnent plus (refus, jamais de troncature)', async () => {
    const client = 'c'.repeat(128);
    const cycle = 'y'.repeat(64);
    const prefix = client + ':' + cycle + ':' + 'o'.repeat(52) + ':';
    expect(prefix.length).toBe(247);
    const a = prefix + '1'.repeat(9);
    const b = prefix + '1'.repeat(8) + '2';
    expect(a.length).toBe(256);
    expect(a.slice(0, 253)).toBe(b.slice(0, 253));
    for (const opId of [a, b]) {
      expect(() => opIdToIdempotencyKey(opId)).toThrow(StateContractError);
      await expectRejected(() => makeDatedStore(db).appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: client,
        expected_rev: 0, payload_json: '{}', op_id: opId }), StateContractError, 'INVALID_OP_ID', 'op_id > 253');
    }
    expect(await countEvents(db, cycle)).toBe(0);
    // Limite exacte : 253 accepté, clé = « op: » + op_id intégral (256), aucune troncature.
    const atLimit = prefix + '123456';
    expect(atLimit.length).toBe(MAX_OP_ID_LENGTH);
    expect(opIdToIdempotencyKey(atLimit)).toBe('op:' + atLimit);
    expect(() => validateOpId(atLimit + '7')).toThrow(StateContractError);
  });

  it('opIdClientFor : un id contenant « . » n’est pas représentable (injectivité)', async () => {
    expect(() => opIdClientFor('a.b')).toThrow(StateContractError);
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

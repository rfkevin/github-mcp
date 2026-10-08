import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authorizeAppend, resolveParticipant, unregisteredParticipantId } from '../../../src/collab-store/identity';
import { mapClient, registerParticipant, unmapClient } from '../../../src/collab-store/owner/decisions';
import { CollabStoreError } from '../../../src/collab-store/store/collab-store';

// CC-3 C5 — identité dérivée du serveur (I8), résultats attendus 4, 5 et 6.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `c5i-${label}-${++n}`;

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return (error as CollabStoreError).code; }
  return 'NO_ERROR';
}

describe('CC-3 C5 — identité des participants', () => {
  it('un client non associé est unregistered, avec un pseudonyme stable et non réversible (R4)', async () => {
    const clientId = uniq('client-CANARY');
    const first = await resolveParticipant(db, clientId);
    const again = await resolveParticipant(db, clientId);
    expect(first.status).toBe('unregistered');
    expect(first.participant_id).toBe(again.participant_id);
    expect(first.participant_id).toMatch(/^unregistered:[0-9a-f]{16}$/);
    expect(first.participant_id).not.toContain('CANARY');
    expect(await unregisteredParticipantId(clientId + 'x')).not.toBe(first.participant_id);
  });

  it('un client non enregistré peut seulement déposer owner.request (R4)', async () => {
    const identity = await resolveParticipant(db, uniq('client'));
    expect(authorizeAppend(identity, identity.participant_id, 'owner.request')).toBe(identity.participant_id);
    for (const type of ['checkpoint', 'task.claim', 'memory.propose', 'phase.request']) {
      expect(codeOf(() => authorizeAppend(identity, identity.participant_id, type)), type).toBe('UNREGISTERED_CLIENT');
    }
  });

  it('deux clients associés obtiennent deux identités distinctes et ne peuvent pas écrire l’un pour l’autre (R5)', async () => {
    const a = uniq('pa');
    const b = uniq('pb');
    const clientA = uniq('client-a');
    const clientB = uniq('client-b');
    await registerParticipant(db, { participant_id: a, display_label: 'Agent A', proof, op: uniq('op') });
    await registerParticipant(db, { participant_id: b, display_label: 'Agent B', proof, op: uniq('op') });
    await mapClient(db, { oauth_client_id: clientA, participant_id: a, proof, op: uniq('op') });
    await mapClient(db, { oauth_client_id: clientB, participant_id: b, proof, op: uniq('op') });
    const idA = await resolveParticipant(db, clientA);
    const idB = await resolveParticipant(db, clientB);
    expect(idA).toMatchObject({ status: 'registered', participant_id: a });
    expect(idB).toMatchObject({ status: 'registered', participant_id: b });
    expect(authorizeAppend(idA, a, 'memory.propose')).toBe(a);
    expect(codeOf(() => authorizeAppend(idA, b, 'memory.propose'))).toBe('PARTICIPANT_MISMATCH');
    expect(codeOf(() => authorizeAppend(idB, a, 'checkpoint'))).toBe('PARTICIPANT_MISMATCH');
  });

  it('un libellé usurpé n’a aucun effet : seule l’association du client compte (R6)', async () => {
    const real = uniq('real');
    const client = uniq('client');
    await registerParticipant(db, { participant_id: real, display_label: 'Grok', proof, op: uniq('op') });
    await mapClient(db, { oauth_client_id: client, participant_id: real, proof, op: uniq('op') });
    const identity = await resolveParticipant(db, client);
    // Se déclarer « Claude », « owner » ou utiliser le libellé d'un autre ne change pas l'identité.
    for (const spoof of ['Claude', 'owner', 'Grok', 'unregistered:0000000000000000']) {
      expect(codeOf(() => authorizeAppend(identity, spoof, 'checkpoint')), spoof).toBe('PARTICIPANT_MISMATCH');
    }
    expect(identity.participant_id).toBe(real);
  });

  it('un client désassocié redevient unregistered à l’appel suivant', async () => {
    const pid = uniq('p');
    const client = uniq('client');
    await registerParticipant(db, { participant_id: pid, display_label: 'P', proof, op: uniq('op') });
    await mapClient(db, { oauth_client_id: client, participant_id: pid, proof, op: uniq('op') });
    expect((await resolveParticipant(db, client)).status).toBe('registered');
    await unmapClient(db, { oauth_client_id: client, proof, op: uniq('op') });
    expect((await resolveParticipant(db, client)).status).toBe('unregistered');
  });
});

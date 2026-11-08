import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition } from '../a0-helpers';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { OWNER_PROOF } from '../coordinator-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_990_000_000;
let n = 0;
async function cycleOf(): Promise<string> {
  await ensureSchema(db);
  const cycle = 's8b-intent-' + (++n) + '-' + Date.now().toString(36);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await registerParticipant(db, { participant_id: 'vibe', display_label: 'vibe', proof: OWNER_PROOF,
    op: 's8b-register-' + cycle }).catch(() => undefined);
  return cycle;
}
async function rowsOf(cycle: string) {
  const { results } = await db.prepare(
    'SELECT event_key,event_type,status,attempts,next_at FROM agent_event_wake_intents WHERE cycle_id=?1 ORDER BY event_key'
  ).bind(cycle).all<{ event_key: string; event_type: string; status: string; attempts: number; next_at: number }>();
  return results;
}
describe('CC8 S8 B — intention de réveil atomique dans CAS store', () => {
  it('APPLIED événement pertinent → intention + audit; duplicate et STALE jamais une seconde', async () => {
    const cycle = await cycleOf();
    const store = new CollabStore(db, { now: () => new Date(T * 1000) });
    const payload = JSON.stringify({ task: 't', source: 'test', state: 'ok' });
    const event = { cycle_id: cycle, type: 'evidence.add' as const, participant_id: 'vibe',
      payload_json: payload, op_id: 'vibe:' + cycle + ':s8b:1' };
    const revision = await store.currentRevision(cycle);
    expect((await store.appendEvent({ ...event, expected_rev: revision })).status).toBe('applied');
    expect(await rowsOf(cycle)).toEqual([{ event_key: event.op_id, event_type: 'evidence.add',
      status: 'queued', attempts: 0, next_at: T }]);
    expect((await store.appendEvent({ ...event, expected_rev: revision + 1 })).status).toBe('duplicate');
    expect((await store.appendEvent({ ...event, op_id: 'vibe:' + cycle + ':s8b:2',
      expected_rev: revision + 10 })).status).toBe('stale');
    expect(await rowsOf(cycle)).toHaveLength(1);
    const { results } = await db.prepare("SELECT kind FROM agent_event_wake_audit WHERE event_key=?1")
      .bind(event.op_id).all<{ kind: string }>();
    expect(results.map(r => r.kind)).toEqual(['wake_queued']);
  });
  it('question adressée seule → intention; refus de type tranquille et question sans destinataire', async () => {
    const cycle = await cycleOf();
    const store = new CollabStore(db, { now: () => new Date(T * 1000) });
    const send = async (type: 'checkpoint' | 'clarify.ask', data: object, suffix: string) => store.appendEvent({
      cycle_id: cycle, type, participant_id: 'vibe',
      expected_rev: await store.currentRevision(cycle),
      payload_json: JSON.stringify(data), op_id: 'vibe:' + cycle + ':s8b' + suffix + ':1',
    });
    expect((await send('checkpoint', {}, 'quiet')).status).toBe('applied');
    expect((await send('clarify.ask', { question: 'Sans to' }, 'anon')).status).toBe('applied');
    expect(await rowsOf(cycle)).toEqual([]);
    expect((await send('clarify.ask', { question: 'Salut', to: 'gemini' }, 'to')).status).toBe('applied');
    expect((await rowsOf(cycle)).map(r => r.event_type)).toEqual(['clarify.ask']);
  });
});

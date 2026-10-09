import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { StoredStoreEvent } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { redactEventsFor } from '../../../src/collab-store/store/visibility';

// CC-3 CR-C (GPT6-01) — règles fail-closed du rendu des événements memory.* par lecteur.
// Unitaire : des événements synthétiques ; memory_entries n'est écrit que pour simuler des
// données anciennes incohérentes (un même id dans deux scopes, antérieur à CR-D).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SECRET = 'SECRET-VISIBILITY';
let seq = 0;

function event(type: string, participant: string, payload: unknown): StoredStoreEvent & { model_meta: string } {
  return { seq: ++seq, cycle_id: 'crc-unit', at: 1, type, participant_id: participant, session_id: SECRET, role: SECRET,
    payload_json: typeof payload === 'string' ? payload : JSON.stringify(payload), expected_rev: seq - 1,
    idempotency_key: 'op:k' + seq, evidence_ref: SECRET, model_meta: SECRET };
}

beforeAll(async () => {
  await ensureSchema(db);
  const insert = (id: string, version: number, scope: string) => db.prepare([
    'INSERT INTO memory_entries (id, version, scope, kind, text, evidence_refs, confidence, status, author_pid, reviewer_pid)',
    "VALUES (?1, ?2, ?3, 'fact', ?4, '[]', 'observed', 'candidate', 'alpha', '')",
  ].join(' ')).bind(id, version, scope, SECRET).run();
  await insert('crc-unit-shared', 1, 'common');
  await insert('crc-unit-private', 1, 'participant:alpha');
  // Donnée ancienne : un id présent dans un scope commun ET privé (GPT6-02 avant CR-D).
  await insert('crc-unit-mixed', 1, 'participant:alpha');
  await insert('crc-unit-mixed', 2, 'common');
});

describe('CC-3 CR-C — redactEventsFor', () => {
  it('masque la mémoire privée d’autrui, garde seq/type/clé, vide tous les champs libres', async () => {
    const source = event('memory.propose', 'alpha', { memory: { id: 'crc-unit-private', scope: 'participant:alpha', text: SECRET,
      evidence_refs: [SECRET], extra: SECRET } });
    const [out] = await redactEventsFor(db, 'beta', [source]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ seq: source.seq, type: 'memory.propose', participant_id: 'alpha', idempotency_key: source.idempotency_key,
      session_id: '', role: '', evidence_ref: '', model_meta: '' });
    expect(JSON.parse(out.payload_json)).toEqual({ memory: { id: 'crc-unit-private' }, redacted: 'private_scope' });
  });

  it('l’auteur et le propriétaire voient l’original ; un lecteur anonyme (null) jamais', async () => {
    const own = event('memory.propose', 'alpha', { memory: { scope: 'participant:alpha', text: SECRET } });
    expect(await redactEventsFor(db, 'alpha', [own])).toEqual([own]);
    expect(JSON.stringify(await redactEventsFor(db, null, [own]))).not.toContain(SECRET);
    // Revue par gamma d'une mémoire privée d'alpha : gamma voit sa revue, alpha aussi (son scope), beta non.
    const review = event('memory.review', 'gamma', { memory: { id: 'crc-unit-private', version: 1, note: SECRET } });
    expect(await redactEventsFor(db, 'gamma', [review])).toEqual([review]);
    expect(await redactEventsFor(db, 'alpha', [review])).toEqual([review]);
    expect(JSON.parse((await redactEventsFor(db, 'beta', [review]))[0].payload_json))
      .toEqual({ memory: { id: 'crc-unit-private', version: 1 }, redacted: 'private_scope' });
  });

  it('fail-closed : id présent dans un scope privé (données anciennes), id inconnu, payload illisible', async () => {
    const cases = [
      event('memory.review', 'gamma', { memory: { id: 'crc-unit-mixed', version: 2, note: SECRET } }),
      event('memory.propose', 'beta', { memory: { id: 'crc-unit-mixed', scope: 'common', text: SECRET } }),
      event('memory.retire', 'gamma', { memory: { id: 'crc-unit-unknown', note: SECRET } }),
      event('memory.consolidate', 'gamma', '{' + SECRET),
      event('memory.consolidate', 'gamma', { memory: SECRET }),
    ];
    const out = await redactEventsFor(db, 'delta', cases);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.map(item => JSON.parse(item.payload_json).redacted)).toEqual(Array(cases.length).fill('private_scope'));
  });

  it('scopes partagés et événements hors mémoire inchangés', async () => {
    const shared = event('memory.review', 'gamma', { memory: { id: 'crc-unit-shared', version: 1 } });
    const proposal = event('memory.propose', 'beta', { memory: { scope: 'role:reviewer', text: 'partagé' } });
    const other = event('evidence.add', 'beta', { source: 'x', state: SECRET });
    expect(await redactEventsFor(db, null, [shared, proposal, other])).toEqual([shared, proposal, other]);
  });
});

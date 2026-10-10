import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/collab-store/memory/memory-store';
import { MEMORY_ALARM_CYCLE, occurrenceKey, pauseKey, pauseRequestId } from '../../../src/collab-store/memory/pause-resume';
import { recordOwnerDecision } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-3 CR-F02 (github-mcp#93) — dépôt de la demande owner par les alarmes et reprise
// atomique par décision. Le parcours HTTP complet (/collab/mcp + /owner) est couvert par
// test/collab-store/mcp/memory-pause-resume-e2e.spec.ts.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };

const counter = async (day: string): Promise<number> =>
  (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(day).first<{ writes: number }>())?.writes ?? 0;

async function alarmRequests(scope: string) {
  return (await db.prepare([
    "SELECT seq, expected_rev, json_extract(payload_json, '$.request_id') AS request_id,",
    "  json_extract(payload_json, '$.occurrence') AS occurrence, json_extract(payload_json, '$.reason') AS reason",
    "FROM events WHERE cycle_id = ?1 AND type = 'owner.request' AND participant_id = 'system'",
    "AND json_extract(payload_json, '$.scope') = ?2 ORDER BY seq",
  ].join(' ')).bind(MEMORY_ALARM_CYCLE, scope).all<{ seq: number; expected_rev: number; request_id: string; occurrence: number; reason: string }>()).results;
}

/** Deux faits activés dans un scope neuf : la 2e activation pose la pause de croissance (occurrence 1). */
async function pauseByGrowth(scope: string): Promise<void> {
  const mem = new MemoryStore(db);
  for (const n of [1, 2]) {
    const p = await mem.propose({ scope, kind: 'fact', text: `fait ${n} de ${scope}`, evidence_refs: [`ev:${n}`], confidence: 'observed', author_pid: 'agent:a' });
    await mem.activate(p.id, 1, 'agent:b');
  }
}

describe('CC-3 CR-F02 — demandes owner déposées par les alarmes', () => {
  it('croissance : une seule demande, exacte, dans la transaction qui pose la pause ; aucune sans alarme', async () => {
    const scope = 'role:crf2-growth';
    const mem = new MemoryStore(db);
    const first = await mem.propose({ scope, kind: 'fact', text: 'premier fait', evidence_refs: ['ev:1'], confidence: 'observed', author_pid: 'agent:a' });
    await mem.activate(first.id, 1, 'agent:b');
    expect(await alarmRequests(scope)).toEqual([]);
    const second = await mem.propose({ scope, kind: 'fact', text: 'second fait', evidence_refs: ['ev:2'], confidence: 'observed', author_pid: 'agent:a' });
    await mem.activate(second.id, 1, 'agent:b');
    const requests = await alarmRequests(scope);
    expect(requests).toEqual([expect.objectContaining({ occurrence: 1, reason: 'growth', request_id: await pauseRequestId(scope, 1) })]);
    // Le cycle memory-alarms suit la règle de révision du journal : une révision par événement.
    const cycle = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(MEMORY_ALARM_CYCLE).first<{ revision: number }>();
    const events = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(MEMORY_ALARM_CYCLE).first<{ n: number }>();
    expect(cycle?.revision).toBe(events?.n);
  });

  it('réfutations : l’alarme hors batch dépose aussi la demande de son occurrence', async () => {
    const scope = 'project:crf2-refute';
    const mem = new MemoryStore(db);
    const p = await mem.propose({ scope, kind: 'fact', text: 'affirmation contestée', evidence_refs: ['e0'], author_pid: 'agent:a' });
    await mem.activate(p.id, 1, 'agent:b');
    for (let i = 0; i < 6; i++) await mem.recordRefute(p.id, 'agent:r' + i);
    expect(await counter(pauseKey(scope))).toBe(1);
    expect(await alarmRequests(scope)).toEqual([
      expect.objectContaining({ occurrence: 1, reason: 'refute', request_id: await pauseRequestId(scope, 1) }),
    ]);
  });
});

describe('CC-3 CR-F02 — reprise par décision owner', () => {
  it('approbation exacte : pause levée et base de croissance = taille approuvée, dans la transaction', async () => {
    const scope = 'role:crf2-resume';
    await pauseByGrowth(scope);
    const [request] = await alarmRequests(scope);
    const result = await recordOwnerDecision(db, { request_id: request.request_id, request_seq: request.seq, decision: 'approve', proof });
    expect(result).toMatchObject({ status: 'applied', decision: 'approve', memory_resume: { scope, occurrence: 1 } });
    expect(await counter(pauseKey(scope))).toBe(0);
    expect(await counter(`mem:base:${scope}`)).toBe(2);
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(false);
  });

  it('course : une nouvelle occurrence committée entre la lecture et la décision annule tout, refus typé', async () => {
    const scope = 'role:crf2-race';
    await pauseByGrowth(scope);
    const [request] = await alarmRequests(scope);
    // D1 instrumentée : juste avant le batch de la décision, une alarme concurrente ouvre l'occurrence 2.
    let armed = false;
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (armed) {
              armed = false;
              await target.prepare('UPDATE quota_counters SET writes = writes + 1 WHERE day = ?1').bind(occurrenceKey(scope)).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(racing);
    armed = true;
    await expect(recordOwnerDecision(racing, { request_id: request.request_id, request_seq: request.seq, decision: 'approve', proof }))
      .rejects.toMatchObject({ code: 'MEMORY_PAUSE_NOT_CURRENT' });
    expect(armed).toBe(false);
    expect(await counter(pauseKey(scope))).toBe(1);
    const decided = await db.prepare('SELECT COUNT(*) AS n FROM owner_decisions WHERE request_id = ?1').bind(request.request_id).first<{ n: number }>();
    expect(decided?.n).toBe(0);
  });

  it('refus : enregistré, la pause reste ; une demande hors pause n’est jamais approuvée', async () => {
    const scope = 'role:crf2-deny';
    await pauseByGrowth(scope);
    const [request] = await alarmRequests(scope);
    expect(await recordOwnerDecision(db, { request_id: request.request_id, request_seq: request.seq, decision: 'deny', proof }))
      .toMatchObject({ status: 'applied', decision: 'deny' });
    expect(await counter(pauseKey(scope))).toBe(1);
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(true);
  });
});

describe('CC-3 CR-F02-R1 — une alarme retardée ouvre une NOUVELLE occurrence (contre-revue Codex #79/6099400915)', () => {
  it('A et B lisent l’occurrence 0, B suspendu ; A + approbation owner ; B committe → occurrence 2, demande exacte, #1 inutilisable', async () => {
    const scope = 'role:crf2r1-race';
    const mem = new MemoryStore(db);
    const p = await mem.propose({ scope, kind: 'fact', text: 'affirmation disputée R1', evidence_refs: ['e0'], author_pid: 'agent:a' });
    await mem.activate(p.id, 1, 'agent:b');
    for (let i = 0; i < 5; i++) await mem.recordRefute(p.id, 'agent:r' + i); // 5 réfutations : pas encore d'alarme
    expect(await alarmRequests(scope)).toEqual([]);

    // D1 instrumentée pour B : son batch d'alarme est suspendu jusqu'au signal.
    let armed = false;
    let reached!: () => void;
    let release!: () => void;
    const atBatch = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const suspended = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (armed) {
              armed = false;
              reached();
              await gate;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await ensureSchema(suspended);
    armed = true;
    // B : 6e réfutation, lit l'occurrence 0 puis attend devant son batch.
    const late = new MemoryStore(suspended).recordRefute(p.id, 'agent:late');
    await atBatch;
    // A : 7e réfutation, lit aussi l'occurrence 0 et committe : pause + occurrence 1 + demande #1.
    await mem.recordRefute(p.id, 'agent:early');
    const [first] = await alarmRequests(scope);
    expect(first).toMatchObject({ occurrence: 1, reason: 'refute', request_id: await pauseRequestId(scope, 1) });
    // Le propriétaire approuve #1 : la pause est levée.
    expect(await recordOwnerDecision(db, { request_id: first.request_id, request_seq: first.seq, decision: 'approve', proof }))
      .toMatchObject({ status: 'applied', memory_resume: { scope, occurrence: 1 } });
    expect(await counter(pauseKey(scope))).toBe(0);

    // B committe enfin : nouvelle occurrence (2) et sa propre demande, jamais la réécriture de #1.
    release();
    await late;
    expect(await counter(occurrenceKey(scope))).toBe(2);
    expect(await counter(pauseKey(scope))).toBe(1);
    const requests = await alarmRequests(scope);
    expect(requests.map(r => r.occurrence)).toEqual([1, 2]);
    expect(requests[1]).toMatchObject({ reason: 'refute', request_id: await pauseRequestId(scope, 2) });

    // L'approbation #1 ne lève pas la pause #2 : rejeu = duplicate, pause maintenue.
    expect(await recordOwnerDecision(db, { request_id: first.request_id, request_seq: first.seq, decision: 'approve', proof }))
      .toMatchObject({ status: 'duplicate' });
    expect(await counter(pauseKey(scope))).toBe(1);
    // L'approbation #2 reprend réellement les activations.
    expect(await recordOwnerDecision(db, { request_id: requests[1].request_id, request_seq: requests[1].seq, decision: 'approve', proof }))
      .toMatchObject({ status: 'applied', memory_resume: { scope, occurrence: 2 } });
    expect(await counter(pauseKey(scope))).toBe(0);
    expect(await new MemoryStore(db).isActivationPaused(scope)).toBe(false);
    // Le cycle memory-alarms garde sa règle de révision : une révision par événement.
    const cycle = await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(MEMORY_ALARM_CYCLE).first<{ revision: number }>();
    const events = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(MEMORY_ALARM_CYCLE).first<{ n: number }>();
    expect(cycle?.revision).toBe(events?.n);
  });

  it('alarmes successives sans course : chaque alarme ouvre l’occurrence suivante avec sa demande', async () => {
    const scope = 'project:crf2r1-seq';
    const mem = new MemoryStore(db);
    const p = await mem.propose({ scope, kind: 'fact', text: 'affirmation R1 séquentielle', evidence_refs: ['e0'], author_pid: 'agent:a' });
    await mem.activate(p.id, 1, 'agent:b');
    for (let i = 0; i < 8; i++) await mem.recordRefute(p.id, 'agent:s' + i); // alarmes aux 6e, 7e, 8e réfutations
    expect(await counter(occurrenceKey(scope))).toBe(3);
    const requests = await alarmRequests(scope);
    expect(requests.map(r => r.occurrence)).toEqual([1, 2, 3]);
    for (const [index, request] of requests.entries()) {
      expect(request.request_id).toBe(await pauseRequestId(scope, index + 1));
    }
  });
});

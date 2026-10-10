import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { pauseRequestId } from '../../../src/collab-store/memory/memory-store';
import { e2eScenario, toolCode as code, type E2eClient } from './e2e-harness';

// CC-3 CR-F02 (github-mcp#93, contre-revue Codex #79/6096598889) par le vrai chemin HTTP :
// OAuth + /collab/mcp pour les agents, /owner (secret) pour Kevin, D1 local. Aucune ligne
// memory_entries, quota ou décision écrite en SQL : les SELECT ne servent qu'à prouver l'état.
// Parcours exigé : alarme → owner.request lié à l'occurrence → décision /owner → reprise effective.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const ALARM_CYCLE = 'memory-alarms';

type Agent = E2eClient & { pid: string };

async function revision(cycle: string): Promise<number> {
  return (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())?.revision ?? 0;
}

async function append(agent: Agent, cycle: string, op: string, type: string, payload: Record<string, unknown>) {
  return agent.call('collab_append_event', { cycle, expected_rev: await revision(cycle), op_id: `${agent.pid}:${cycle}:${op}:1`,
    type, participant_id: agent.pid, payload_json: JSON.stringify(payload) });
}

const counter = async (day: string): Promise<number> =>
  (await db.prepare('SELECT writes FROM quota_counters WHERE day = ?1').bind(day).first<{ writes: number }>())?.writes ?? 0;

/** Pause, occurrence et base de croissance du scope, décisions owner enregistrées. */
async function pauseState(scope: string) {
  const decisions = await db.prepare('SELECT COUNT(*) AS n FROM owner_decisions').first<{ n: number }>();
  return { paused: await counter(`mem:pause:${scope}`), occurrence: await counter(`mem:occ:${scope}`),
    baseline: await counter(`mem:base:${scope}`), decisions: decisions?.n ?? 0 };
}

/** Demandes owner déposées par l'alarme pour ce scope, plus récente en dernier. */
async function alarmRequests(scope: string) {
  return (await db.prepare([
    "SELECT seq, cycle_id, type, participant_id, json_extract(payload_json, '$.request_id') AS request_id,",
    "  json_extract(payload_json, '$.occurrence') AS occurrence, json_extract(payload_json, '$.reason') AS reason",
    "FROM events WHERE cycle_id = ?1 AND type = 'owner.request' AND json_extract(payload_json, '$.scope') = ?2 ORDER BY seq",
  ].join(' ')).bind(ALARM_CYCLE, scope).all<{ seq: number; cycle_id: string; type: string; participant_id: string;
    request_id: string; occurrence: number; reason: string }>()).results;
}

const fact = (id: string, scope: string, n: number) =>
  ({ memory: { id, scope, kind: 'fact', text: `fait partage numero ${n}`, evidence_refs: [`ev:crf2-${n}`], confidence: 'observed' } });

describe('CC-3 CR-F02 — pause mémoire reprenable par décision owner (HTTP)', () => {
  it('alarme → demande exacte → refus sans décision, autre occurrence, rejeu → approbation /owner → reprise', async () => {
    const { owner, agent, uniq } = e2eScenario(db, 'crf2', 'owner-secret-CRF2-0123456789abcdefghijklm');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'role:' + uniq('pause');
    const ids = [0, 1, 2, 3].map(n => uniq('mem' + n));
    for (const [n, id] of ids.entries()) {
      expect((await append(alpha, cycle, 'p' + n, 'memory.propose', fact(id, scope, n))).structuredContent.status).toBe('applied');
    }
    const review = (n: number) => append(beta, cycle, 'r' + n, 'memory.review', { memory: { id: ids[n], version: 1 } });
    expect((await review(0)).structuredContent.status).toBe('applied');
    // 2e activation : +100 % > 25 % → pause posée dans le batch d'activation, occurrence 1.
    expect((await review(1)).structuredContent.status).toBe('applied');
    expect(await pauseState(scope)).toMatchObject({ paused: 1, occurrence: 1, baseline: 1 });

    // L'alarme a déposé, dans la même transaction, la demande owner exacte de cette occurrence.
    const [request] = await alarmRequests(scope);
    expect(request).toMatchObject({ cycle_id: ALARM_CYCLE, type: 'owner.request', participant_id: 'system', occurrence: 1, reason: 'growth' });
    expect(request.request_id).toBe(await pauseRequestId(scope, 1));
    expect(await alarmRequests(scope)).toHaveLength(1);

    // Sans décision : refus, rien d'écrit.
    const blocked = await pauseState(scope);
    expect(code(await review(2))).toBe('ACTIVATION_PAUSED');
    expect(await pauseState(scope)).toEqual(blocked);

    // Une demande visant un autre scope (ou une autre occurrence) ne peut pas lever cette pause :
    // refus MEMORY_PAUSE_NOT_CURRENT, aucune décision enregistrée.
    const forged = await pauseRequestId('role:autre-scope', 1);
    expect((await append(alpha, cycle, 'forge', 'owner.request', { request_id: forged, summary: 'reprise forgee' })).structuredContent.status).toBe('applied');
    const forgedSeq = (await db.prepare("SELECT seq FROM events WHERE type = 'owner.request' AND json_extract(payload_json, '$.request_id') = ?1")
      .bind(forged).first<{ seq: number }>())!.seq;
    const refused = await owner({ action: 'decide', request_id: forged, decision: 'approve', request_seq: String(forgedSeq), cycle_id: cycle });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('MEMORY_PAUSE_NOT_CURRENT');
    expect(await pauseState(scope)).toEqual(blocked);

    // Approbation exacte via /owner : reprise atomique, nouvelle base = taille approuvée (2).
    const decide = { action: 'decide', request_id: request.request_id, decision: 'approve', request_seq: String(request.seq), cycle_id: ALARM_CYCLE };
    const approved = await owner(decide);
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('reprises');
    expect(await pauseState(scope)).toEqual({ paused: 0, occurrence: 1, baseline: 2, decisions: blocked.decisions + 1 });

    // Rejeu du même formulaire : idempotent, aucun second effet.
    const replay = await owner(decide);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('Déjà enregistré');
    expect(await pauseState(scope)).toEqual({ paused: 0, occurrence: 1, baseline: 2, decisions: blocked.decisions + 1 });

    // Reprise effective : la 3e activation est appliquée. Sa croissance (3 > 125 % de 2) pose
    // une nouvelle occurrence (2) et dépose sa propre demande.
    expect((await review(2)).structuredContent.status).toBe('applied');
    expect(await pauseState(scope)).toMatchObject({ paused: 1, occurrence: 2 });
    const requests = await alarmRequests(scope);
    expect(requests.map(item => item.occurrence)).toEqual([1, 2]);
    expect(requests[1].request_id).toBe(await pauseRequestId(scope, 2));

    // L'approbation de l'occurrence 1 n'est jamais réutilisable pour l'occurrence 2.
    const reused = await owner(decide);
    expect(await reused.text()).toContain('Déjà enregistré');
    const refiled = await append(alpha, cycle, 'refile', 'owner.request', { request_id: request.request_id, summary: 'rejouer occurrence 1' });
    expect(refiled.structuredContent.status).toBe('applied');
    const refiledSeq = (await db.prepare("SELECT MAX(seq) AS seq FROM events WHERE type = 'owner.request' AND json_extract(payload_json, '$.request_id') = ?1")
      .bind(request.request_id).first<{ seq: number }>())!.seq;
    const again = await owner({ action: 'decide', request_id: request.request_id, decision: 'approve', request_seq: String(refiledSeq), cycle_id: cycle });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('ALREADY_DECIDED');
    const stillPaused = await pauseState(scope);
    expect(stillPaused).toMatchObject({ paused: 1, occurrence: 2 });
    expect(code(await review(3))).toBe('ACTIVATION_PAUSED');

    // Refus owner de l'occurrence 2 : enregistré, la pause reste, rien d'autre ne bouge.
    const denied = await owner({ action: 'decide', request_id: requests[1].request_id, decision: 'deny', request_seq: String(requests[1].seq), cycle_id: ALARM_CYCLE });
    expect(denied.status).toBe(200);
    expect(await pauseState(scope)).toEqual({ ...stillPaused, decisions: stillPaused.decisions + 1 });
    expect(code(await review(3))).toBe('ACTIVATION_PAUSED');
  });

  it('approbations concurrentes de la même demande : un seul effet, une seule décision', async () => {
    const { owner, agent, uniq } = e2eScenario(db, 'crf2c', 'owner-secret-CRF2C-0123456789abcdefghijk');
    const [alpha, beta] = [await agent('alpha'), await agent('beta')];
    const cycle = uniq('cycle');
    const scope = 'project:' + uniq('race');
    const ids = [0, 1].map(n => uniq('mem' + n));
    for (const [n, id] of ids.entries()) {
      await append(alpha, cycle, 'p' + n, 'memory.propose', fact(id, scope, n));
      expect((await append(beta, cycle, 'r' + n, 'memory.review', { memory: { id, version: 1 } })).structuredContent.status).toBe('applied');
    }
    const [request] = await alarmRequests(scope);
    const before = await pauseState(scope);
    expect(before).toMatchObject({ paused: 1, occurrence: 1 });
    const form = { action: 'decide', request_id: request.request_id, decision: 'approve', request_seq: String(request.seq), cycle_id: ALARM_CYCLE };
    const responses = await Promise.all([owner(form), owner(form)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await pauseState(scope)).toEqual({ paused: 0, occurrence: 1, baseline: 2, decisions: before.decisions + 1 });
    const decisionEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'owner.decision' AND json_extract(payload_json, '$.request_id') = ?1")
      .bind(request.request_id).first<{ n: number }>();
    expect(decisionEvents?.n).toBe(1);
  });
});

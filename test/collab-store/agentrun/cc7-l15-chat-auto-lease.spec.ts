import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiCanImplement, planAgentRuns, taskRunId } from '../../../src/collab-store/agentrun';
import { CHAT_AUTO_HOLD_SECONDS, applyChatAutoLease } from '../../../src/collab-store/agentrun/chat-auto-lease';
import { createRun, leaseKeyOf } from '../../../src/collab-store/agentrun/engine';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { outputSchemas } from '../../../src/collab-store/mcp/schemas';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { collabToolHandler, OWNER_PROOF } from '../coordinator-helpers';

// CC-7 L15 (décision de Kevin du 2026-10-31, option 2) — le bail du chat est pris automatiquement :
// - toute écriture du chat (canal MCP) sur une tâche prend ou renouvelle le bail pendant 1 h ;
// - l'API du même agent ne démarre plus sur la tâche, et une exécution en vol perd la main ;
// - une tâche done / verified rend le bail ;
// - un réveil « implémenter » n'est confié à l'API que si elle a les outils d'écriture GitHub
//   (AGENT_RUN_GITHUB_WRITES) — sinon elle ne pourrait qu'annoncer un travail qu'elle ne fait pas
//   (seq 1157 et 1160 de cc7-api-auto).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
// Préfixe trié en tête : le planificateur lit au plus PLAN_MAX_CYCLES cycles ouverts par ordre d'id.
const uniq = (label: string) => ('0000-0l15-' + label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);

/** Cycle P6 avec une tâche l7 ; le propriétaire de la tâche est enregistré et relié à un client OAuth. */
async function seed(label: string) {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const cycle = uniq(label);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  const owner = 'p-l15-own-' + n;
  await insertTaskRow(db, { taskId: 'l7', cycle, owner, reviewer: 'p-l15-rev-' + n, tester: 'p-l15-tst-' + n });
  const client = 'cc7l15-client-' + n;
  await registerParticipant(db, { participant_id: owner, display_label: owner, proof: OWNER_PROOF, op: 'reg-' + client });
  await mapClient(db, { oauth_client_id: client, participant_id: owner, proof: OWNER_PROOF, op: 'map-' + client });
  const append = await collabToolHandler(db, 'collab_append_event', client);
  let op = 0;
  const chat = async (type: string, payload: unknown) => {
    const rev = (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
    const result = await append({ cycle, expected_rev: rev, op_id: owner + ':' + cycle + ':l15:' + (++op), type,
      participant_id: owner, session_id: 'chat-1', payload_json: JSON.stringify(payload) });
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return z.object(outputSchemas.collab_append_event).parse(JSON.parse(result.content[0].text));
  };
  const fence = (task = 'l7') => db.prepare('SELECT holder, held_until, generation FROM agent_fences WHERE lease_key = ?1')
    .bind(leaseKeyOf(cycle, owner, task)).first<{ holder: string; held_until: number; generation: number }>();
  const apiRun = (runId: string, now: number) => createRun(db, { runId, cycleId: cycle, participantId: owner, taskId: 'l7', taskKind: 'implement',
    prompt: 'p', maxSteps: 3, maxTokens: 100, maxCostCents: 0, deadlineAt: now + 600, now });
  return { cycle, owner, chat, fence, apiRun };
}

describe('CC-7 L15 — le chat prend le bail en écrivant sur une tâche', () => {
  it('point d’étape du chat sur l7 : bail pris 1 h, signalé dans la réponse ; l’API ne démarre plus sur l7', async () => {
    const s = await seed('hold');
    const body = await s.chat('checkpoint', { task: 'l7', state: 'je commence à coder' });
    expect(body.status).toBe('applied');
    expect(body.chat_lease).toEqual({ task: 'l7', action: 'held', held_until: body.event!.at + CHAT_AUTO_HOLD_SECONDS });
    expect(await s.fence()).toMatchObject({ holder: 'chat', held_until: body.event!.at + CHAT_AUTO_HOLD_SECONDS });
    expect(await s.apiRun('l15-blocked-' + n, body.event!.at + 60)).toEqual({ created: false, reason: 'chat_holds_lease' });
    // Le bail est borné : passé l'heure sans nouvelle écriture du chat, l'API peut reprendre.
    expect((await s.apiRun('l15-after-' + n, body.event!.at + CHAT_AUTO_HOLD_SECONDS + 1)).created).toBe(true);
  });

  it('exécution API déjà en vol : l’écriture du chat la préempte (nouvelle génération, bail au chat)', async () => {
    const s = await seed('preempt');
    const now = Math.floor(Date.now() / 1000);
    const created = await s.apiRun('l15-inflight-' + n, now - 30);
    expect(created.created).toBe(true);
    const before = (await s.fence())!;
    expect(before.holder).toBe('api');
    await s.chat('evidence.add', { task: 'l7', source: 'chat', state: 'SUBMITTED' });
    const after = (await s.fence())!;
    expect(after.holder).toBe('chat');
    expect(after.generation).toBeGreaterThan(before.generation);
    const run = await db.prepare('SELECT generation FROM agent_runs WHERE run_id = ?1').bind('l15-inflight-' + n).first<{ generation: number }>();
    expect(run!.generation).toBeLessThan(after.generation);
  });

  it('chaque écriture renouvelle le bail ; task.status done le rend', async () => {
    const s = await seed('release');
    const first = await s.chat('task.status', { task: { task_id: 'l7', status: 'in_progress' } });
    expect(first.chat_lease?.action).toBe('held');
    const done = await s.chat('task.status', { task: { task_id: 'l7', status: 'done' } });
    expect(done.chat_lease).toEqual({ task: 'l7', action: 'released' });
    expect((await s.fence())!.holder).toBe('none');
    expect((await s.apiRun('l15-free-' + n, done.event!.at + 1)).created).toBe(true);
  });

  it('écriture sans tâche, ou d’un type qui ne marque pas un travail : aucun bail', async () => {
    const s = await seed('notask');
    const ask = await s.chat('clarify.ask', { question: 'Quel SHA ?' });
    expect(ask.chat_lease).toBeUndefined();
    const askTask = await s.chat('clarify.ask', { question: 'Question sur l7', task: 'l7' });
    expect(askTask.chat_lease).toBeUndefined();
    expect(await s.fence()).toBeNull();
  });

  it('le canal API (écriture directe au store, rôle api-agent) ne prend jamais le bail du chat', async () => {
    const s = await seed('api');
    const store = new CollabStore(db);
    const rev = (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(s.cycle).first<{ revision: number }>())!.revision;
    const out = await store.appendEvent({ cycle_id: s.cycle, type: 'checkpoint', participant_id: s.owner, expected_rev: rev,
      op_id: s.owner + ':' + s.cycle + ':api:1', role: 'api-agent', payload_json: JSON.stringify({ task: 'l7', state: 'API' }) });
    expect(out.status).toBe('applied');
    expect(await s.fence()).toBeNull();
  });

  it('identités équivalentes : le bail est pris pour chacune', async () => {
    const effect = await applyChatAutoLease(db, { cycle_id: 'l15-eq-' + n, type: 'checkpoint', at: 1000, payload_json: '{"task":"t9"}' },
      ['p-l15-a-' + n, 'p-l15-b-' + n]);
    expect(effect).toEqual({ task: 't9', action: 'held', held_until: 1000 + CHAT_AUTO_HOLD_SECONDS });
    for (const pid of ['p-l15-a-' + n, 'p-l15-b-' + n]) {
      const row = await db.prepare('SELECT holder FROM agent_fences WHERE lease_key = ?1').bind(leaseKeyOf('l15-eq-' + n, pid, 't9'))
        .first<{ holder: string }>();
      expect(row?.holder, pid).toBe('chat');
    }
  });
});

describe('CC-7 L15 — réveil « implémenter » confié à l’API seulement si elle peut écrire le code', () => {
  it('sans AGENT_RUN_GITHUB_WRITES : aucune exécution implement (unequipped) ; avec « true » : exécution créée', async () => {
    expect(apiCanImplement({})).toBe(false);
    expect(apiCanImplement({ AGENT_RUN_GITHUB_WRITES: 'false' })).toBe(false);
    expect(apiCanImplement({ AGENT_RUN_GITHUB_WRITES: 'true' })).toBe(true);
    const s = await seed('impl');
    const now = Math.floor(Date.now() / 1000) + 10 * 3600;
    const off = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: s.owner }, { now });
    expect(off).toEqual({ considered: 0, created: 0, unequipped: 1 });
    const on = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: s.owner, AGENT_RUN_GITHUB_WRITES: 'true' }, { now });
    expect(on.created).toBe(1);
    const run = await db.prepare('SELECT task_kind FROM agent_runs WHERE run_id = ?1')
      .bind(await taskRunId('implement', s.cycle, s.owner, 'l7', 'none')).first<{ task_kind: string }>();
    expect(run?.task_kind).toBe('implement');
  });
});

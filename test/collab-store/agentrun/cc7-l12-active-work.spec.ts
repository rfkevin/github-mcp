import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { planAgentRuns, answerRunId, taskRunId } from '../../../src/collab-store/agentrun';
import { createRun, preemptByChat } from '../../../src/collab-store/agentrun/engine';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import {
  CHAT_ACTIVE_SECONDS, CONCURRENT_SESSION_SECONDS, ACTIVE_WORK_MAX_CHECKPOINTS, chatActiveWithin, concurrentSession, loadActiveWork, taskOfPayload,
} from '../../../src/collab-store/context';
import { outputSchemas } from '../../../src/collab-store/mcp/schemas';
import { mapClient, registerParticipant } from '../../../src/collab-store/owner/decisions';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { collabToolHandler, OWNER_PROOF } from '../coordinator-helpers';

// CC-7 L12 (demande de Kevin du 2026-10-30) — un seul travailleur actif par agent, chat ou API :
// - le planificateur ne crée pas d'exécution API pendant que le chat du même agent est actif (fenêtre glissante) ;
// - collab_get_context rend le travail en cours de l'agent (active_work) ;
// - collab_append_event avertit, sans bloquer, quand une autre session du même agent vient d'écrire sur la même tâche.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_975_000_000;
let n = 0;
// Préfixe trié en tête : le planificateur lit au plus PLAN_MAX_CYCLES cycles ouverts par ordre d'id.
const uniq = (label: string) => ('0000-0l12-' + label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);

async function event(cycle: string, input: { type: string; participant: string; at: number; payload: unknown; role?: string; session?: string }) {
  await db.prepare([
    'INSERT INTO events (cycle_id, at, type, participant_id, session_id, role, payload_json, expected_rev, idempotency_key, evidence_ref)',
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, '')",
  ].join(' ')).bind(cycle, input.at, input.type, input.participant, input.session ?? '', input.role ?? '',
    JSON.stringify(input.payload), cycle + ':l12:' + (++n)).run();
  return (await db.prepare('SELECT MAX(seq) AS s FROM events WHERE cycle_id = ?1').bind(cycle).first<{ s: number }>())!.s;
}

/** Cycle P6, tâche l7 (owner/reviewer/tester), question de p-ask adressée à `to`. */
async function seedQuestion(label: string, to: string) {
  await ensureSchema(db);
  const cycle = uniq(label);
  await insertCycleRow(db, cycle, 'P6');
  await insertPhaseDefinition(db, cycle, 'P6', []);
  const owner = 'p-own-' + n;
  await insertTaskRow(db, { taskId: 'l7', cycle, owner, reviewer: 'p-rev-' + n, tester: 'p-tst-' + n });
  const askSeq = await event(cycle, { type: 'clarify.ask', participant: 'p-ask', at: 1, payload: { question: 'Quel SHA ?', to } });
  return { cycle, askSeq, owner };
}

const runsOf = async (cycle: string) => {
  await ensureAgentRunSchema(db);
  return (await db.prepare('SELECT COUNT(*) AS c FROM agent_runs WHERE cycle_id = ?1').bind(cycle).first<{ c: number }>())!.c;
};

describe('CC-7 L12 — le planificateur attend que le chat de l’agent ait fini', () => {
  it('question adressée : chat actif il y a 5 min → aucune exécution (différée) ; 16 min plus tard → exécution answer', async () => {
    const to = 'p-l12-ans-' + n;
    const q = await seedQuestion('ans', to);
    await event(q.cycle, { type: 'checkpoint', participant: to, at: T - 300, payload: { state: 'je lis la question' } });
    const busy = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: to }, { now: T });
    expect(busy).toEqual({ considered: 0, created: 0, deferred: 1 });
    expect(await runsOf(q.cycle)).toBe(0);
    // Fenêtre glissante : sans nouvelle écriture du chat, l'API reprend ; la décision n'a pas été consommée.
    const later = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: to }, { now: T - 300 + CHAT_ACTIVE_SECONDS + 60 });
    expect(later.created).toBe(1);
    expect(later.deferred).toBeUndefined();
    const run = await db.prepare('SELECT task_kind FROM agent_runs WHERE run_id = ?1').bind(await answerRunId(q.cycle, to, q.askSeq))
      .first<{ task_kind: string }>();
    expect(run?.task_kind).toBe('answer');
  });

  it('une écriture du canal API (role api-agent) ou du propriétaire ne compte jamais comme chat actif', async () => {
    const to = 'p-l12-api-' + n;
    const q = await seedQuestion('api', to);
    await event(q.cycle, { type: 'checkpoint', participant: to, role: 'api-agent', at: T - 60, payload: { state: 'API' } });
    await event(q.cycle, { type: 'owner.decision', participant: to, at: T - 60, payload: { decision: 'x' } });
    expect(await chatActiveWithin(db, q.cycle, [to], T)).toBe(false);
    expect((await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: to }, { now: T })).created).toBe(1);
  });

  it('le chat d’un AUTRE participant ne bloque rien', async () => {
    const to = 'p-l12-oth-' + n;
    const q = await seedQuestion('oth', to);
    await event(q.cycle, { type: 'checkpoint', participant: 'p-someone-else', at: T - 10, payload: { state: 'actif' } });
    expect((await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: to }, { now: T })).created).toBe(1);
  });

  it('réveil de tâche : chat actif sur CETTE tâche → différé ; chat actif sur une autre tâche → exécution implement', async () => {
    const q = await seedQuestion('task', 'p-l12-elsewhere-' + n);
    const env = { AGENT_RUN_PARTICIPANTS: q.owner };
    await event(q.cycle, { type: 'checkpoint', participant: q.owner, at: T - 120, payload: { task: 'l7', state: 'j’implémente' } });
    expect(await planAgentRuns(db, env, { now: T })).toEqual({ considered: 0, created: 0, deferred: 1 });
    expect(await runsOf(q.cycle)).toBe(0);

    const other = await seedQuestion('task2', 'p-l12-elsewhere2-' + n);
    await event(other.cycle, { type: 'checkpoint', participant: other.owner, at: T - 120, payload: { task: 'autre', state: 'ailleurs' } });
    const out = await planAgentRuns(db, { AGENT_RUN_GITHUB_WRITES: 'true', AGENT_RUN_PARTICIPANTS: other.owner }, { now: T });
    expect(out.created).toBe(1);
    const run = await db.prepare('SELECT task_kind FROM agent_runs WHERE run_id = ?1')
      .bind(await taskRunId('implement', other.cycle, other.owner, 'l7', 'none')).first<{ task_kind: string }>();
    expect(run?.task_kind).toBe('implement');
  });

  it('tâche portée en objet (task.status : task.task_id) reconnue', async () => {
    expect(taskOfPayload(JSON.stringify({ task: { task_id: 'l7', status: 'in_progress' } }))).toBe('l7');
    expect(taskOfPayload(JSON.stringify({ task: 'l7' }))).toBe('l7');
    expect(taskOfPayload(JSON.stringify({ question: 'x' }))).toBeNull();
    expect(taskOfPayload('pas du json')).toBeNull();
    const q = await seedQuestion('obj', 'p-l12-obj-' + n);
    await event(q.cycle, { type: 'task.status', participant: q.owner, at: T - 30, payload: { task: { task_id: 'l7', status: 'in_progress' } } });
    expect(await chatActiveWithin(db, q.cycle, [q.owner], T, 'l7')).toBe(true);
    expect(await chatActiveWithin(db, q.cycle, [q.owner], T, 'autre')).toBe(false);
  });
});

describe('CC-7 L12 — travail en cours (active_work)', () => {
  it('dernière écriture chat, exécutions API ouvertes, derniers checkpoints par tâche ; jamais ceux d’un autre agent', async () => {
    const q = await seedQuestion('aw', 'p-l12-aw-' + n);
    const me = q.owner;
    await event(q.cycle, { type: 'checkpoint', participant: me, at: T - 500, payload: { task: 'l7', state: 'ancien' } });
    await event(q.cycle, { type: 'checkpoint', participant: me, role: 'api-agent', at: T - 400, payload: { task: 'l7', state: 'récent API' } });
    await event(q.cycle, { type: 'checkpoint', participant: me, at: T - 300, payload: { task: 'l9', summary: 'autre tâche', todo: 'tests' } });
    await event(q.cycle, { type: 'checkpoint', participant: 'p-autre', at: T - 10, payload: { task: 'l7', state: 'pas à moi' } });
    const runId = 'l12-run-' + n;
    expect((await createRun(db, { runId, cycleId: q.cycle, participantId: me, taskId: 'l7', taskKind: 'implement', prompt: 'p',
      maxSteps: 4, maxTokens: 1000, maxCostCents: 0, deadlineAt: T + 900, now: T - 200 })).created).toBe(true);
    await createRun(db, { runId: 'l12-run-other-' + n, cycleId: q.cycle, participantId: 'p-autre', taskId: 'l7', taskKind: 'review', prompt: 'p',
      maxSteps: 4, maxTokens: 1000, maxCostCents: 0, deadlineAt: T + 900, now: T - 200 });

    const work = await loadActiveWork(db, q.cycle, [me]);
    expect(work.last_chat_write).toMatchObject({ type: 'checkpoint', task: 'l9' });
    expect(work.open_api_runs.map(r => r.run_id)).toEqual([runId]);
    expect(work.last_checkpoints.map(c => [c.task, c.channel, c.summary])).toEqual([
      ['l9', 'chat', 'autre tâche — tests'],
      ['l7', 'api', 'récent API'],
    ]);
    expect(work.truncated).toEqual({ open_api_runs: false, last_checkpoints: false });

    // Le chat qui revient voit l'exécution ouverte et la préempte (L7-4) : elle ne bloque plus rien ensuite.
    await preemptByChat(db, { cycleId: q.cycle, participantId: me, taskId: 'l7', now: T, holdSeconds: 900 });
    await db.prepare("UPDATE agent_runs SET status = 'preempted' WHERE run_id = ?1").bind(runId).run();
    expect((await loadActiveWork(db, q.cycle, [me])).open_api_runs).toEqual([]);
  });

  it('checkpoints bornés : un par tâche, au plus ACTIVE_WORK_MAX_CHECKPOINTS, troncature signalée', async () => {
    const q = await seedQuestion('awmax', 'p-l12-awmax-' + n);
    for (let i = 0; i < ACTIVE_WORK_MAX_CHECKPOINTS + 2; i += 1) {
      await event(q.cycle, { type: 'checkpoint', participant: q.owner, at: T + i, payload: { task: 't' + i, state: 's' + i } });
    }
    const work = await loadActiveWork(db, q.cycle, [q.owner]);
    expect(work.last_checkpoints).toHaveLength(ACTIVE_WORK_MAX_CHECKPOINTS);
    expect(work.last_checkpoints[0].task).toBe('t' + (ACTIVE_WORK_MAX_CHECKPOINTS + 1));
    expect(work.truncated.last_checkpoints).toBe(true);
  });

  it('collab_get_context : active_work conforme au schéma, limité à l’appelant', async () => {
    const q = await seedQuestion('awtool', 'p-l12-awtool-' + n);
    const me = q.owner;
    await event(q.cycle, { type: 'checkpoint', participant: me, at: T - 60, payload: { task: 'l7', state: 'en cours' } });
    await event(q.cycle, { type: 'checkpoint', participant: 'p-autre', at: T - 30, payload: { task: 'l7', state: 'pas à moi' } });
    const client = 'cc7l12-client-' + n;
    await registerParticipant(db, { participant_id: me, display_label: me, proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: me, proof: OWNER_PROOF, op: 'map-' + client });
    const result = await (await collabToolHandler(db, 'collab_get_context', client))({ cycle: q.cycle });
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const body = z.object(outputSchemas.collab_get_context).parse(JSON.parse(result.content[0].text));
    expect(body.active_work?.last_checkpoints.map(c => c.summary)).toEqual(['en cours']);
    expect(body.active_work?.last_chat_write?.task).toBe('l7');
  });
});

describe('CC-7 L12 — avertissement de session concurrente (non bloquant)', () => {
  const base = { role: '', payload_json: JSON.stringify({ task: 'l7', state: 'x' }) };

  it('autre session du même agent sur la même tâche il y a moins de 30 min → avertissement', async () => {
    const q = await seedQuestion('cs', 'p-l12-cs-' + n);
    const prev = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S1', at: T - 600, payload: { task: 'l7', state: 'a' } });
    const seq = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S2', at: T, payload: { task: 'l7', state: 'b' } });
    expect(await concurrentSession(db, { ...base, cycle_id: q.cycle, seq, at: T, session_id: 'S2' }, [q.owner]))
      .toEqual({ other_session_id: 'S1', seq: prev, at: T - 600, task: 'l7' });
  });

  it('A, B, B (GPT-6, seq 1102) : la seconde écriture de B voit toujours A dans la fenêtre ; A hors fenêtre → rien', async () => {
    const q = await seedQuestion('abb', 'p-l12-abb-' + n);
    const a = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'A', at: T - 600, payload: { task: 'l7', state: 'A' } });
    const b1 = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'B', at: T - 300, payload: { task: 'l7', state: 'B1' } });
    const b2 = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'B', at: T, payload: { task: 'l7', state: 'B2' } });
    expect(await concurrentSession(db, { ...base, cycle_id: q.cycle, seq: b1, at: T - 300, session_id: 'B' }, [q.owner]))
      .toEqual({ other_session_id: 'A', seq: a, at: T - 600, task: 'l7' });
    expect(await concurrentSession(db, { ...base, cycle_id: q.cycle, seq: b2, at: T, session_id: 'B' }, [q.owner]))
      .toEqual({ other_session_id: 'A', seq: a, at: T - 600, task: 'l7' });
    // Une écriture anonyme (sans session_id) de l'agent après A ne masque pas A et n'est pas signalée.
    const anon = await event(q.cycle, { type: 'checkpoint', participant: q.owner, at: T + 1, payload: { task: 'l7', state: 'anonyme' } });
    const b3 = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'B', at: T + 2, payload: { task: 'l7', state: 'B3' } });
    expect(anon).toBeLessThan(b3);
    expect((await concurrentSession(db, { ...base, cycle_id: q.cycle, seq: b3, at: T + 2, session_id: 'B' }, [q.owner]))?.other_session_id).toBe('A');
    // A sort de la fenêtre de 30 min : plus d'avertissement pour B.
    const late = T - 600 + CONCURRENT_SESSION_SECONDS + 1;
    const b4 = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'B', at: late, payload: { task: 'l7', state: 'B4' } });
    expect(await concurrentSession(db, { ...base, cycle_id: q.cycle, seq: b4, at: late, session_id: 'B' }, [q.owner])).toBeNull();
  });

  it('aucun avertissement : même session, autre tâche, trop ancien, sans session_id, écriture API, autre agent', async () => {
    const q = await seedQuestion('cs2', 'p-l12-cs2-' + n);
    await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S1', at: T - CONCURRENT_SESSION_SECONDS - 5, payload: { task: 'l7' } });
    await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S1', at: T - 60, payload: { task: 'l9' } });
    await event(q.cycle, { type: 'checkpoint', participant: 'p-autre', session: 'SX', at: T - 60, payload: { task: 'l7' } });
    const seq = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S2', at: T, payload: { task: 'l7' } });
    const ev = { ...base, cycle_id: q.cycle, seq, at: T };
    expect(await concurrentSession(db, { ...ev, session_id: 'S2' }, [q.owner])).toBeNull();
    expect(await concurrentSession(db, { ...ev, session_id: '' }, [q.owner])).toBeNull();
    expect(await concurrentSession(db, { ...ev, session_id: 'S2', role: 'api-agent' }, [q.owner])).toBeNull();
    expect(await concurrentSession(db, { ...ev, session_id: 'S2', payload_json: '{"question":"x"}' }, [q.owner])).toBeNull();
    // Même session que la précédente écriture sur l9 : jamais d'avertissement contre soi-même.
    const own = await event(q.cycle, { type: 'checkpoint', participant: q.owner, session: 'S1', at: T + 1, payload: { task: 'l9' } });
    expect(await concurrentSession(db, { ...ev, seq: own, at: T + 1, session_id: 'S1', payload_json: '{"task":"l9"}' }, [q.owner])).toBeNull();
  });

  it('collab_append_event : appliqué ET concurrent_session dans la réponse, aussi à la 2e écriture de B (A, B, B) ; autre tâche : aucun champ', async () => {
    const q = await seedQuestion('cstool', 'p-l12-cstool-' + n);
    const me = q.owner;
    const client = 'cc7l12-cs-client-' + n;
    await registerParticipant(db, { participant_id: me, display_label: me, proof: OWNER_PROOF, op: 'reg-' + client });
    await mapClient(db, { oauth_client_id: client, participant_id: me, proof: OWNER_PROOF, op: 'map-' + client });
    const now = Math.floor(Date.now() / 1000);
    await event(q.cycle, { type: 'checkpoint', participant: me, session: 'chat-A', at: now - 120, payload: { task: 'l7', state: 'A travaille' } });
    const append = await collabToolHandler(db, 'collab_append_event', client);
    const rev = (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(q.cycle).first<{ revision: number }>())!.revision;
    const opClient = me.replace(/:/g, '.');
    const result = await append({ cycle: q.cycle, expected_rev: rev, op_id: opClient + ':' + q.cycle + ':cs:1', type: 'checkpoint',
      participant_id: me, session_id: 'chat-B', payload_json: JSON.stringify({ task: 'l7', state: 'B travaille' }) });
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    const body = z.object(outputSchemas.collab_append_event).parse(JSON.parse(result.content[0].text));
    expect(body.status).toBe('applied');
    expect(body.concurrent_session).toMatchObject({ other_session_id: 'chat-A', task: 'l7' });

    // A, B, B (GPT-6, seq 1102) : la seconde écriture de B sur l7 signale toujours A.
    const again = await append({ cycle: q.cycle, expected_rev: body.revision, op_id: opClient + ':' + q.cycle + ':cs:2', type: 'checkpoint',
      participant_id: me, session_id: 'chat-B', payload_json: JSON.stringify({ task: 'l7', state: 'B continue' }) });
    const againBody = z.object(outputSchemas.collab_append_event).parse(JSON.parse(again.content[0].text));
    expect(againBody.status).toBe('applied');
    expect(againBody.concurrent_session).toMatchObject({ other_session_id: 'chat-A', task: 'l7' });

    // Autre tâche, que seule B touche : aucun champ.
    const quiet = await append({ cycle: q.cycle, expected_rev: againBody.revision, op_id: opClient + ':' + q.cycle + ':cs:3', type: 'checkpoint',
      participant_id: me, session_id: 'chat-B', payload_json: JSON.stringify({ task: 'l9', state: 'B ailleurs' }) });
    const quietBody = z.object(outputSchemas.collab_append_event).parse(JSON.parse(quiet.content[0].text));
    expect(quietBody.status).toBe('applied');
    expect(quietBody.concurrent_session).toBeUndefined();
  });
});

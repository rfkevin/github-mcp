import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createRun, runStep, createReadToolHost, ensureAgentRunSchema, planAgentRuns, taskPrompt, ToolRefused, type ModelClient,
} from '../../../src/collab-store/agentrun';
import { engineFor } from '../../../src/collab-store/agentrun/object';
import { createProduct, proposalTaskId } from '../../../src/collab-store/owner/product';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { advanceGuarded } from '../../../src/collab-store/phases';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { OWNER_PROOF, uniqueIds } from '../coordinator-helpers';

// CC-7 L6b-2 (S9) — le canal API dépose les sorties des phases de conception (proposer, critiquer,
// synthétiser, voter) par store_contribute, contrôlé serveur contre la phase courante.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('l6b2');
const T = 1_996_000_000;
let effect = 0;
// Clé d'effet du moteur : l'op_id en garde les 32 premiers caractères, qui doivent donc différer.
const key = () => (++effect).toString(16).padStart(32, '0') + 'a'.repeat(32);

async function product() {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  const pids = [uid('a'), uid('b'), uid('c')];
  for (const pid of pids) {
    await registerParticipant(db, { participant_id: pid, display_label: 'L ' + pid, proof: OWNER_PROOF, op: 'reg-' + pid });
  }
  const cycle = uid('c');
  await createProduct(db, { enabled: true, cycle_id: cycle, goal: 'Outil de notes', participants: pids, proof: OWNER_PROOF });
  const host = createReadToolHost({ db, repository: null, github: null, storeWrites: true, contributions: true });
  const run = async (pid: string, kind = 'design') => {
    await db.prepare("UPDATE agent_runs SET status = 'failed' WHERE cycle_id = ?1 AND participant_id = ?2 AND status = 'running'")
      .bind(cycle, pid).run();
    const runId = uid('run');
    expect((await createRun(db, { runId, cycleId: cycle, participantId: pid, taskId: '', taskKind: kind, prompt: 'p',
      maxSteps: 10, maxTokens: 1_000_000, maxCostCents: 0, deadlineAt: T + 86_400, now: T })).created).toBe(true);
    return runId;
  };
  const contribute = (runId: string, args: Record<string, unknown>, effectKey = key()) =>
    host.execute({ id: 'c', name: 'store_contribute', args }, { run_id: runId, effect_key: effectKey });
  const refusal = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { expect(error).toBeInstanceOf(ToolRefused); return (error as Error).message; }
    throw new Error('refus attendu');
  };
  const revision = async () => (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
  const advance = async (to: 'P2' | 'P3' | 'P4' | 'P5') => advanceGuarded(db, { cycle_id: cycle, expected_revision: await revision(), next_phase: to });
  const lastEvent = async (type: string) => db.prepare('SELECT participant_id, role, payload_json FROM events WHERE cycle_id = ?1 AND type = ?2 ORDER BY seq DESC LIMIT 1')
    .bind(cycle, type).first<{ participant_id: string; role: string; payload_json: string }>();
  return { cycle, pids, host, run, contribute, refusal, advance, lastEvent };
}

describe('CC-7 L6b-2 — store_contribute', () => {
  it('outil proposé au seul kind design ; un autre kind est refusé même s’il l’appelle', async () => {
    const q = await product();
    expect(q.host.list('design')).toEqual(['store_context', 'store_delta', 'store_contribute']);
    expect(q.host.list('review')).not.toContain('store_contribute');
    expect(q.host.spec('design', 'store_contribute')).toEqual({ name: 'store_contribute', effect: 'write' });
    const off = createReadToolHost({ db, repository: null, github: null, storeWrites: true });
    expect(off.list('design')).not.toContain('store_contribute');
    const reviewRun = await q.run(q.pids[0], 'review');
    expect(await q.refusal(q.contribute(reviewRun, { task: proposalTaskId(q.pids[0]), content: 'x' }))).toBe('CONTRIBUTION_KIND_FORBIDDEN');
  });

  it('un produit mené de P1 à P4 par le seul canal API, chaque dépôt vérifié par le serveur', async () => {
    const q = await product();
    const [a, b, c] = q.pids;

    // P1 : proposition sur SA tâche, une seule fois ; rejeu de la même clé d'effet = duplicate.
    const ra = await q.run(a);
    expect(await q.refusal(q.contribute(ra, { task: proposalTaskId(b), content: 'pas la mienne' }))).toBe('CONTRIBUTION_NOT_EXPECTED');
    expect(await q.refusal(q.contribute(ra, { task: proposalTaskId(a) }))).toBe('CONTRIBUTION_ARGS_INVALID');
    const once = key();
    expect(await q.contribute(ra, { task: proposalTaskId(a), content: 'idée de a' }, once)).toMatchObject({ type: 'proposal.submit', phase: 'P1', status: 'applied' });
    expect(await q.contribute(ra, { task: proposalTaskId(a), content: 'idée de a' }, once)).toMatchObject({ status: 'duplicate' });
    expect(await q.lastEvent('proposal.submit')).toMatchObject({ participant_id: a, role: 'author' });
    expect(await q.refusal(q.contribute(ra, { task: proposalTaskId(a), content: 'encore' }))).toBe('CONTRIBUTION_NOT_EXPECTED');
    for (const pid of [b, c]) await q.contribute(await q.run(pid), { task: proposalTaskId(pid), content: 'idée de ' + pid });
    await q.advance('P2');

    // P2 : critique de la proposition dont on est relecteur (a relit c), état de conception obligatoire.
    const ra2 = await q.run(a);
    expect(await q.refusal(q.contribute(ra2, { task: proposalTaskId(c), review: 'sans état' }))).toBe('CONTRIBUTION_STATE_INVALID');
    expect(await q.refusal(q.contribute(ra2, { task: proposalTaskId(c), state: 'PASS', review: 'x' }))).toBe('CONTRIBUTION_STATE_INVALID');
    expect(await q.refusal(q.contribute(ra2, { task: proposalTaskId(b), state: 'AGREE', review: 'pas mon relu' }))).toBe('CONTRIBUTION_NOT_EXPECTED');
    expect(await q.contribute(ra2, { task: proposalTaskId(c), state: 'AMEND', review: 'S3 à préciser' })).toMatchObject({ type: 'evidence.add', phase: 'P2' });
    const critique = await q.lastEvent('evidence.add');
    expect(critique).toMatchObject({ participant_id: a, role: 'reviewer' });
    const payload = JSON.parse(critique!.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ task: proposalTaskId(c), state: 'AMEND', source: 'api-contribution:P2' });
    expect(payload).not.toHaveProperty('head');
    expect(payload).not.toHaveProperty('pr');
    await q.contribute(await q.run(b), { task: proposalTaskId(a), state: 'AGREE', review: 'ok' });
    await q.contribute(await q.run(c), { task: proposalTaskId(b), state: 'AGREE', review: 'ok' });
    await q.advance('P3');

    // P3 : seul le coordinateur synthétise ; P4 : relecteur et testeur votent, OBJECTION possible.
    expect(await q.refusal(q.contribute(await q.run(b), { task: 'synthesis', content: 'pas coordinateur' }))).toBe('CONTRIBUTION_NOT_EXPECTED');
    await q.contribute(await q.run(a), { task: 'synthesis', content: 'plan' });
    await q.advance('P4');
    await q.contribute(await q.run(b), { task: 'synthesis', state: 'AGREE', review: 'ok' });
    await q.contribute(await q.run(c), { task: 'synthesis', state: 'OBJECTION', review: 'S7 manque' });
    await expect(q.advance('P5')).rejects.toBeTruthy();
    expect(await q.lastEvent('evidence.add')).toMatchObject({ participant_id: c, role: 'tester' });
  });

  it('moteur : store_contribute passe la garde D12 (état de conception), les autres écritures non', async () => {
    const q = await product();
    const [a] = q.pids;
    for (const pid of q.pids) await q.contribute(await q.run(pid), { task: proposalTaskId(pid), content: 'i' });
    await q.advance('P2');
    const runId = await q.run(a);
    let step = 0;
    const model: ModelClient = { complete: async () => {
      step += 1;
      const call = step === 1
        ? { id: 'k1', name: 'store_contribute', args: { task: proposalTaskId(q.pids[2]), state: 'AGREE', review: 'AGREE : clair' } }
        : null;
      return { output: { text: call ? '' : 'Fait / Reste / Appris', tool_calls: call ? [call] : [] }, usage: { tokens: 1, cost_cents: 0 } };
    } };
    const deps = { model, tools: q.host, now: () => T + 1, workerId: 'w' };
    await runStep(db, runId, deps);
    expect(await q.lastEvent('evidence.add')).toMatchObject({ participant_id: a, role: 'reviewer' });
  });
});

describe('CC-7 L6b-2 — planification des réveils contribute', () => {
  it('P1 d’un produit : une exécution design par auteur (plus d’implement), consigne de proposition', async () => {
    const q = await product();
    const out = await planAgentRuns(db, { AGENT_RUN_PARTICIPANTS: q.pids.join(',') }, { now: T });
    expect(out.created).toBe(3);
    const rows = (await db.prepare('SELECT participant_id, task_id, task_kind, max_cost_cents FROM agent_runs WHERE cycle_id = ?1 ORDER BY participant_id')
      .bind(q.cycle).all<{ participant_id: string; task_id: string; task_kind: string; max_cost_cents: number }>()).results;
    expect(rows.map(r => [r.participant_id, r.task_id, r.task_kind, r.max_cost_cents]))
      .toEqual([...q.pids].sort().map(pid => [pid, proposalTaskId(pid), 'design', 0]));
    expect(taskPrompt('design', q.cycle, 'p-x', 'P1:proposal.submit:author')).toContain('votre proposition');
    expect(taskPrompt('design', q.cycle, 'synthesis', 'P3:proposal.submit:author:synthesis')).toContain('synthèse');
    expect(taskPrompt('design', q.cycle, 'synthesis', 'P4:evidence.add:tester:synthesis')).toContain('OBJECTION');
  });

  it('engineFor propose store_contribute au kind design', () => {
    const deps = engineFor({ AGENT_RUN_MODEL: 'workers-ai:@cf/zai-org/glm-4.7-flash', AI: { run: async () => ({}) } as never }, db)('r');
    expect(deps.tools.list('design')).toContain('store_contribute');
  });
});

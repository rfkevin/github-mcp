import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, type ModelClient, type ToolHost, type AgentMessage } from '../../../src/collab-store/agentrun';
import { steerAgentRun, stopAgentRun, runControlTarget } from '../../../src/collab-store/agentrun/run-control';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function newRun(taskId = 'work') {
  await ensureSchema(db);
  const id = crypto.randomUUID();
  const now = 1_900_000_000;
  const runId = 'cc8-steer-' + id;
  const result = await createRun(db, {
    runId, cycleId: 'cc8-steer-cycle-' + id, participantId: 'gemini', taskId,
    taskKind: 'fix', prompt: 'Examine les preuves puis termine.',
    maxSteps: -1, maxTokens: -1, maxCostCents: 0, deadlineAt: now + 3600, now,
  });
  expect(result.created).toBe(true);
  return { runId, now };
}

function host(reads: string[]): ToolHost {
  return {
    spec: (_kind, name) => name === 'github_read_file' ? { name, effect: 'read' } : null,
    list: () => ['github_read_file'],
    async execute(call) { reads.push(call.name); return { sha: 'abc', content: 'contenu vérifié' }; },
  };
}

describe('CC8 — recadrage conversationnel et arrêt ciblé sans second moteur', () => {
  it('livre un message envoyé PENDANT le premier appel du modèle au second appel du MÊME run', async () => {
    const { runId, now } = await newRun();
    const reads: string[] = [];
    const seen: AgentMessage[][] = [];
    let calls = 0;
    const model: ModelClient = { async complete(input) {
      calls++;
      seen.push(input.messages);
      if (calls === 1) {
        expect((await steerAgentRun(db, { runId, sender: 'gpt6', opId: 'reframe:1',
          message: 'Ne répète pas les lectures : termine avec les preuves déjà vérifiées.', now })).status).toBe('queued');
        expect((await steerAgentRun(db, { runId, sender: 'gpt6', opId: 'reframe:1',
          message: 'Ne répète pas les lectures : termine avec les preuves déjà vérifiées.', now })).status).toBe('duplicate');
        return { output: { text: 'Première lecture', tool_calls: [
          { id: 'rd1', name: 'github_read_file', args: { path: 'src/index.ts', ref: 'head' } },
        ] }, usage: { tokens: 20, cost_cents: 0 } };
      }
      expect(JSON.stringify(input.messages)).toContain('Ne répète pas les lectures');
      return { output: { text: 'Terminé selon la consigne reçue', tool_calls: [] },
        usage: { tokens: 12, cost_cents: 0 } };
    } };
    const deps = { model, tools: host(reads), now: () => now + 1, workerId: 'cc8-worker' };
    expect((await runStep(db, runId, deps)).outcome).toBe('stepped');
    expect((await runStep(db, runId, deps)).outcome).toBe('completed');
    expect(calls).toBe(2);
    expect(reads).toEqual(['github_read_file']);
    expect(JSON.stringify(seen[0])).not.toContain('Ne répète pas les lectures');
    expect(JSON.stringify(seen[1])).toContain('Ne répète pas les lectures');
    const messages = await db.prepare('SELECT delivered_step,body FROM agent_run_messages WHERE run_id=?1')
      .bind(runId).all<{ delivered_step: number; body: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0].delivered_step).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE run_id=?1').bind(runId)
      .first<{ n: number }>())!.n).toBe(1);
  });

  it('un arrêt individuel interdit un nouveau fournisseur sur le run ciblé, pas sur les autres', async () => {
    const a = await newRun('a');
    const b = await newRun('b');
    const reads: string[] = [];
    let calls = 0;
    const model: ModelClient = { async complete() {
      calls++;
      return { output: { text: 'Fin normale', tool_calls: [] }, usage: { tokens: 1, cost_cents: 0 } };
    } };
    expect((await stopAgentRun(db, { runId: a.runId, sender: 'gpt6', reason: 'stagnation prouvée', now: a.now + 1 })).status).toBe('stopped');
    expect((await stopAgentRun(db, { runId: a.runId, sender: 'gpt6', reason: 'stagnation prouvée', now: a.now + 2 })).status).toBe('already_stopped');
    expect((await runStep(db, a.runId, { model, tools: host(reads), now: () => a.now + 3, workerId: 'c' })).outcome).toBe('halted');
    expect(calls).toBe(0);
    expect((await runStep(db, b.runId, { model, tools: host(reads), now: () => b.now + 3, workerId: 'd' })).outcome).toBe('completed');
    expect(calls).toBe(1);
    expect((await runControlTarget(db, a.runId))?.stop_reason).toContain('individual_stop:');
    await expect(steerAgentRun(db, { runId: a.runId, sender: 'gpt6', opId: 'late:1',
      message: 'Ne pas relancer', now: a.now + 4 })).rejects.toThrow();
  });

  it('arrêt pendant un appel fournisseur : aucun outil, même de lecture, ne démarre après l’arrêt', async () => {
    const { runId, now } = await newRun('inflight');
    const reads: string[] = [];
    const model: ModelClient = { async complete() {
      await stopAgentRun(db, { runId, sender: 'gpt6', reason: 'stop immédiat', now: now + 1 });
      return { output: { text: 'Tentative après arrêt', tool_calls: [
        { id: 'r', name: 'github_read_file', args: { path: 'x', ref: 'head' } },
      ] }, usage: { tokens: 5, cost_cents: 0 } };
    } };
    expect((await runStep(db, runId, { model, tools: host(reads),
      now: () => now + 2, workerId: 'e' })).outcome).toBe('halted');
    expect(reads).toHaveLength(0);
  });

  it('un op_id réutilisé avec contenu différent est refusé sans modifier le message initial', async () => {
    const { runId, now } = await newRun('dedup');
    await steerAgentRun(db, { runId, sender: 'gpt6', opId: 'same-key', message: 'Consigne A', now });
    await expect(steerAgentRun(db, { runId, sender: 'gpt6', opId: 'same-key',
      message: 'Consigne B', now })).rejects.toThrow();
    const row = await db.prepare('SELECT body FROM agent_run_messages WHERE run_id=?1').bind(runId)
      .first<{ body: string }>();
    expect(row?.body).toBe('Consigne A');
  });
});

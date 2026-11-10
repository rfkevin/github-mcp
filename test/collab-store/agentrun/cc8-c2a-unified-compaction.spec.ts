import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun, runStep, type AgentMessage, type ModelClient, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import { ensureSchema } from '../../../src/collab-store/store/schema';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 2_000_000_000;
const ANCHORED_SHA = 'b'.repeat(40);
const KINDS = ['answer', 'design', 'review', 'test', 'implement', 'research', 'planning', 'status'] as const;

async function runHistory(kind: string, compactHistory: boolean) {
  await ensureSchema(db);
  const runId = 'cc8-c2a-' + crypto.randomUUID();
  const created = await createRun(db, {
    runId, cycleId: runId, participantId: 'c2a-agent', taskId: 'c2a-task',
    taskKind: kind, prompt: 'Mission C2a : consulter et recontrôler.',
    maxSteps: 8, maxTokens: 10_000, maxCostCents: 0, deadlineAt: NOW + 900, now: NOW,
  });
  expect(created.created).toBe(true);
  const secret = 'SECRET_OLD_' + kind;
  const last = 'LAST_NEW_' + kind;
  const seen: AgentMessage[][] = [];
  let calls = 0;
  const model: ModelClient = {
    async complete(input) {
      seen.push(input.messages);
      calls++;
      const tool_calls = calls <= 2
        ? [{ id: 'read-' + calls, name: 'read_file', args: { path: String(calls) + '.ts' } }]
        : [];
      return { output: { text: 'étape ' + calls, tool_calls }, usage: { tokens: 10, cost_cents: 0 } };
    },
  };
  const tools: ToolHost = {
    list: () => ['read_file'],
    spec: (_kind, name) => name === 'read_file' ? { name, effect: 'read' } : null,
    async execute(call) {
      return { sha: ANCHORED_SHA, content: call.args.path === '1.ts' ? secret : last };
    },
  };
  for (let i = 0; i < 3; i++) {
    const outcome = await runStep(db, runId, {
      model, tools, now: () => NOW + 1, workerId: 'c2a-worker', compactHistory,
    });
    if (i < 2) expect(outcome.outcome).toBe('stepped');
  }
  const persisted = await db.prepare('SELECT results FROM agent_run_steps WHERE run_id = ?1 AND n = 0')
    .bind(runId).first<{ results: string }>();
  return { seen, persisted: persisted?.results ?? '', secret, last };
}

describe('CC8 C2a — compaction du chemin logique unique, tous kinds', () => {
  it.each(KINDS)('compacte le contexte fournisseur %s sans modifier l’historique D1', async kind => {
    const { seen, persisted, secret, last } = await runHistory(kind, true);
    expect(seen).toHaveLength(3);
    const third = JSON.stringify(seen[2]);
    expect(third).toContain('Checkpoint compact extrait du journal D1');
    expect(third).toContain(ANCHORED_SHA);
    expect(third).toContain(last);
    expect(third).not.toContain(secret);
    expect(persisted).toContain(secret);
    expect(seen[2].at(-1)?.tool_call_id).toBe('read-2');
  });

  it('préserve le mode opt-out sans compaction pour answer', async () => {
    const { seen, secret, last } = await runHistory('answer', false);
    const third = JSON.stringify(seen[2]);
    expect(third).toContain(secret);
    expect(third).toContain(last);
    expect(third).not.toContain('Checkpoint compact extrait du journal D1');
  });
});

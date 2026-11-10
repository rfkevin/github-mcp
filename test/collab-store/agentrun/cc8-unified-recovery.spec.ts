import { describe, expect, it } from 'vitest';
import {
  NO_TOOL_CALL_RECOVERY_MAX,
  isRecoverablePreparationViolation,
  preparationNoToolCallFeedback,
  preparationInstruction,
  preparationViolation,
  shouldRecoverPreparation,
  preparationRecoveriesRemaining,
  PREPARATION_ROUNDS_MAX,
  PREPARATION_READ_TOOLS,
} from '../../../src/collab-store/agentrun/guided-preparation';
import { type ToolCall } from '../../../src/collab-store/agentrun/engine';
import { T, BASE, BRANCH, SCOPE, newRun, host, scripted, drive, row, db, setHalt } from './s7-guided-harness';

const emptyOut = { text: 'analyse sans outil', tool_calls: [] as ToolCall[] };
const SOURCE = 'src/collab-store/agentrun/s7-guided.ts';
const source = { path: SOURCE, sha: '3'.repeat(40), size: 210, content: 'export function planGuidedS7() { return { kind: "stop" }; }' };

function recoveryHost() {
  const available = new Set(['store_context','store_delta','store_memory','store_continuity','github_read_file','github_list_directory']);
  const adapter = host({ github_write_scope: [SCOPE], github_create_branch: [{ sha: 'a'.repeat(40), branch: BRANCH }] });
  const tools = {
    list: (kind: string) => [...new Set([...adapter.tools.list(kind), ...available])],
    spec: (kind: string, name: string) => available.has(name) ? { name, effect: 'read' as const } : adapter.tools.spec(kind, name),
    async execute(c: ToolCall, ctx: { run_id: string }) {
      if (c.name === 'github_read_file' && c.args.path === SOURCE && c.args.ref === BASE) return source;
      if (c.name === 'github_list_directory') return { path: c.args.path, ref: c.args.ref, entries: [{ name: 's7-guided.ts', path: SOURCE, type: 'file' }], truncated: false };
      if (c.name === 'store_context') return { cycle_id: 'x', revision: 1, phase: 'P6', tasks: [] };
      if (c.name === 'store_delta') return { events: [], has_more: false };
      if (c.name === 'store_memory') return { entries: [] };
      if (c.name === 'store_continuity') return { handovers: [], api_runs: [] };
      return adapter.tools.execute(c, ctx);
    },
  };
  return { tools, adapter };
}

describe('CC8 C1 pure module gate (exported, not local copy)', () => {
  it('shouldRecoverPreparation bounds', () => {
    expect(shouldRecoverPreparation(0, 'no_tool_call')).toBe(true);
    expect(shouldRecoverPreparation(1, 'no_tool_call')).toBe(true);
    expect(shouldRecoverPreparation(2, 'no_tool_call')).toBe(false);
    expect(shouldRecoverPreparation(0, 'too_many_tool_calls')).toBe(false);
    expect(preparationRecoveriesRemaining(0)).toBe(2);
    expect(NO_TOOL_CALL_RECOVERY_MAX).toBe(2);
  });
  it('preparationInstruction embeds recoveryHint', () => {
    const text = preparationInstruction('S7-C1', 'a'.repeat(40), ['store_context'], ['ac'], 0, preparationNoToolCallFeedback(1));
    expect(text).toMatch(/RECUPERATION|recuperation/i);
  });
  it('preparationViolation empty = no_tool_call', () => {
    expect(preparationViolation({ tool_calls: [], text: 'x' } as any, [...PREPARATION_READ_TOOLS])).toBe('no_tool_call');
  });
});

describe('CC8 C1 D1 engine recovery', () => {
  it('two no_tool_call recoveries then typed stop; feedback reinjected; no content write', async () => {
    const s = await newRun('c1-recovery-three');
    const h = recoveryHost();
    const model = scripted([emptyOut, emptyOut, emptyOut, emptyOut]);
    const outcomes = await drive(s.runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'c1-rec', guidedS7: true, guidedPreparation: true, githubCompletionGrants: s.grants }, 20);
    const run = await row(s.runId);
    expect(run.status).toBe('failed');
    expect(run.stop_reason).toContain('guided_preparation_violation:no_tool_call');
    const journal = await db.prepare("SELECT COUNT(*) AS c FROM agent_run_journal j JOIN agent_runs r ON r.run_id = j.run_id WHERE j.kind = 'preparation_recovery' AND r.task_id = 'S7-live-vibe' AND COALESCE(json_extract(j.detail, '$.branch'), '') = ?1").bind(BRANCH).first<{ c: number }>();
    expect(Number(journal?.c ?? 0)).toBe(NO_TOOL_CALL_RECOVERY_MAX);
    expect(run.steps_done).toBeGreaterThanOrEqual(NO_TOOL_CALL_RECOVERY_MAX);
    expect(outcomes).not.toContain('busy');
    const prompts = model.seen.map(x => x.messages.map(message => message.content).join('\n'));
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain('RECUPERATION CONSULTANT');
    expect(prompts[1]).toContain('RECUPERATION CONSULTANT');
    expect(prompts[1]).toContain('Recuperations no_tool_call restantes apres cet echec: 1.');
    expect(prompts[2]).toContain('RECUPERATION CONSULTANT');
    expect(prompts[2]).toContain('Derniere recuperation consommee');
    expect(h.adapter.writes().every(w => w === 'github_write_scope' || w === 'github_create_branch')).toBe(true);
    expect(outcomes.at(-1)).toBe('failed');
  });
  it('HALT not widened by recovery path', async () => {
    const s = await newRun('c1-recovery-halt');
    await setHalt(true);
    try {
      const h = recoveryHost();
      const model = scripted([emptyOut, emptyOut]);
      const outcomes = await drive(s.runId, { model: model.client, tools: h.tools, now: () => T + 100, workerId: 'c1-halt', guidedS7: true, guidedPreparation: true, githubCompletionGrants: s.grants }, 10);
      const run = await row(s.runId);
      expect(run == null || run.status !== 'completed').toBe(true);
      expect(outcomes.includes('completed')).toBe(false);
      expect(run.steps_done).toBe(0);
      expect(model.seen).toHaveLength(0);
      const recoveryRows = await db.prepare("SELECT COUNT(*) AS c FROM agent_run_journal WHERE run_id = ?1 AND kind = 'preparation_recovery'")
        .bind(s.runId).first<{ c: number }>();
      expect(Number(recoveryRows?.c ?? 0)).toBe(0);
    } finally { await setHalt(false); }
  });
});

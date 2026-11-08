import { describe, expect, it } from 'vitest';
import { planGuidedS7, type GuidedEntry } from '../../../src/collab-store/agentrun/s7-guided';
import { BRANCH, HEAD, SCOPE, db, drive, host, newRun, row, scripted, T } from './s7-guided-harness';

const scope = (remaining: number, head: string | null = HEAD): GuidedEntry =>
  ({ tool: 'github_write_scope', value: { ...SCOPE, branch_head: head, corrections_remaining: remaining }, failed: false });

describe('CC8 S7 — preflight budget durable de commits', () => {
  it('une branche historique avec 4 commits au total et 0 correction restante s’arrête AVANT modèle', () => {
    const plan = planGuidedS7([scope(0)], BRANCH, 'S7-live-vibe', 1);
    expect(plan).toEqual({ kind: 'stop', reason: 'commit_budget_exhausted' });
    expect(planGuidedS7([scope(-1)], BRANCH, 'S7-live-vibe', 1)).toEqual(plan);
  });
  it('une branche sans budget ne doit pas être créée ni demander un modèle', () => {
    expect(planGuidedS7([scope(0, null)], BRANCH, 'S7-live-vibe', 1))
      .toEqual({ kind: 'stop', reason: 'commit_budget_exhausted' });
  });
  it('un budget non épuisé conserve le parcours S7 existant', () => {
    for (const remaining of [1, 2, 3]) {
      expect(planGuidedS7([scope(remaining)], BRANCH, 'S7-live-vibe', 1))
        .toMatchObject({ kind: 'model', tools: ['github_commit_files'] });
    }
    expect(planGuidedS7([{ tool: 'github_write_scope', value: SCOPE, failed: false }],
      BRANCH, 'S7-live-vibe', 1)).toMatchObject({ kind: 'server', call: { name: 'github_create_branch' } });
  });
  it('D1 : arrêt typé, 0 jeton, aucun commit ni CI quand le budget historique est épuisé', async () => {
    const { runId, grants } = await newRun('budget-exhausted');
    const model = scripted([]);
    const h = host({ github_write_scope: [{ ...SCOPE, branch_head: HEAD, corrections_remaining: 0 }] });
    const outcomes = await drive(runId, {
      model: model.client, tools: h.tools, now: () => T + 100, workerId: runId,
      githubCompletionGrants: grants, guidedS7: true,
    });
    expect(outcomes.at(-1)).toBe('failed');
    expect(await row(runId)).toMatchObject({
      status: 'failed', stop_reason: 'guided_stop:commit_budget_exhausted', tokens_used: 0,
    });
    expect(model.seen).toHaveLength(0);
    expect(h.writes()).toEqual(['github_write_scope']);
    const writes = await db.prepare("SELECT COUNT(*) AS n FROM agent_run_effects WHERE run_id=?1 AND tool='github_commit_files'")
      .bind(runId).first<{ n: number }>();
    expect(writes?.n).toBe(0);
  });
});

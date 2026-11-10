import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { createRun, ToolRefused, type ToolHost } from '../../../src/collab-store/agentrun/engine';
import {
  createReadToolHost, requiredUnifiedCapability, runVerifiedClaims, READ_TOOLS_BY_KIND,
  READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, type ReadToolHostOptions, type RunScope,
} from '../../../src/collab-store/agentrun/read-tools';
import { resolveUnifiedCapabilities } from '../../../src/collab-store/agentrun/agent-capabilities';
import { WRITE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/store-tools';
import { GITHUB_WRITE_TOOL_SCHEMAS, type GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
import { S7_SCHEMAS } from '../../../src/collab-store/agentrun/github-write/tools';
import { VERDICT_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/verdict-tools';
import { CONTRIBUTION_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/contribution-tools';
import { MODEL_CHOICE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/model-choice-tools';
import { RESEARCH_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/research';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const NOW = 2_000_000_000;
/** c2c-author/reviewer/tester = titulaires ; c2c-intruder enregistré sans rôle ; c2c-ghost absent de participants. */
const REGISTERED = ['c2c-author', 'c2c-reviewer', 'c2c-tester', 'c2c-intruder'];

async function seeded(input: { kind: string; participant: string; ownedPaths?: string }): Promise<{ runId: string; scope: RunScope }> {
  await ensureSchema(db);
  await ensureAgentRunSchema(db);
  for (const id of REGISTERED) {
    await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(id).run();
  }
  const cycleId = 'cc8-c2c-' + crypto.randomUUID();
  const taskId = 'c2c-task-' + crypto.randomUUID().slice(0, 8);
  await db.prepare("INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, 'rfkevin/github-mcp', 'P6', 1, 'open')").bind(cycleId).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid,',
    'status, owned_paths, target_ref, next_action, revision)',
    "VALUES (?1, ?2, 'c2c-author', 'c2c-reviewer', 'c2c-tester', 'in_progress', ?3, '', 'read source', 1)",
  ].join(' ')).bind(taskId, cycleId, input.ownedPaths ?? '["src/x.ts"]').run();
  const runId = 'c2c-run-' + crypto.randomUUID();
  const created = await createRun(db, {
    runId, cycleId, participantId: input.participant, taskId, taskKind: input.kind,
    prompt: 'Mission C2c.', maxSteps: 4, maxTokens: 5_000, maxCostCents: 0, deadlineAt: NOW + 900, now: NOW,
  });
  expect(created.created).toBe(true);
  return { runId, scope: { cycle_id: cycleId, participant_id: input.participant, task_id: taskId, task_kind: input.kind } };
}

const github = {
  getTextFile: async () => ({ path: 'src/x.ts', sha: 'b'.repeat(40), content: 'contenu', size: 8 }),
  getPullRequest: async () => ({ number: 1, state: 'open', head: {}, base: {} }),
  listCheckRuns: async () => [],
  compareRefs: async () => ({ status: 'identical', files: [] }),
};

const writes: GitHubWrites = {
  branchHead: async () => null,
  createBranch: async () => ({ sha: 'c'.repeat(40) }),
  commitFiles: async () => ({ commit_sha: 'd'.repeat(40) }),
  recentCommits: async () => [],
  openDraftPullRequest: async () => ({ number: 1, head_sha: 'e'.repeat(40) }),
  openPullRequest: async () => ({ number: 2, head_sha: 'f'.repeat(40) }),
  findPullRequest: async () => null,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('CC8 C2c — le catalogue runtime consomme le contrat unique C0', () => {
  it("l'allowlist par kind est conservée à l'identique ; deux outils restent hors vocabulaire C0", () => {
    expect(READ_TOOLS_BY_KIND).toEqual({
      research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
      answer: ['store_context', 'store_delta'],
      planning: ['store_context', 'store_delta', 'github_read_file'],
      status: ['store_context', 'store_delta', 'github_check_runs'],
      implement: ['store_context', 'store_delta', 'github_list_directory', 'github_read_file', 'github_pull_request', 'github_check_runs'],
      review: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
      test: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
      design: ['store_context', 'store_delta'],
    });
    expect(requiredUnifiedCapability('store_choose_model')).toBeNull();
    expect(requiredUnifiedCapability('web_fetch_official')).toBeNull();
  });

  it('caractérisation : chaque outil du runtime exige une capacité C0 ou est explicitement hors vocabulaire', () => {
    const ungated = new Set(['web_fetch_official', 'store_choose_model']);
    const groups = [READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, WRITE_TOOL_SCHEMAS, GITHUB_WRITE_TOOL_SCHEMAS,
      S7_SCHEMAS, VERDICT_TOOL_SCHEMAS, CONTRIBUTION_TOOL_SCHEMAS, MODEL_CHOICE_TOOL_SCHEMAS, RESEARCH_TOOL_SCHEMAS];
    let mapped = 0;
    for (const group of groups) {
      for (const schema of group) {
        if (ungated.has(schema.name)) continue;
        expect(requiredUnifiedCapability(schema.name)).not.toBeNull();
        mapped += 1;
      }
    }
    expect(mapped).toBeGreaterThanOrEqual(20);
    expect(requiredUnifiedCapability('github_write_scope')).toBe('github.write');
    expect(requiredUnifiedCapability('store_salon_post')).toBe('salon.announce');
    expect(requiredUnifiedCapability('store_verdict')).toBe('review.verdict');
    expect(requiredUnifiedCapability('store_memory')).toBe('memory.read');
  });

  it('porte absente (défaut) : comportement inchangé, aucun refus de capacité', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github });
    const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
    expect(context.cycle_id).toBeDefined();
    // L'outil d'écriture hors allowlist est refusé par l'allowlist, PAS par le contrat.
    await expect(h.execute({ id: 't2', name: 'github_create_branch', args: {} }, { run_id: runId }))
      .rejects.toThrow(/tool_not_allowlisted/);
  });

  it('porte active : auteur enregistré — socle complet, lectures servies, aucun argument du modèle', async () => {
    const { runId, scope } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const options: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, continuity: true, storeWrites: true };
    const h = createReadToolHost(options);
    const caps = resolveUnifiedCapabilities(await runVerifiedClaims(db, scope, options));
    for (const expected of ['cycle.read', 'memory.read', 'github.read', 'question.ask', 'question.answer',
      'task.status', 'task.handover', 'memory.propose', 'memory.rewrite', 'salon.announce']) {
      expect(caps).toContain(expected);
    }
    const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
    expect(context.cycle_id).toBe(scope.cycle_id);
    const delta = await h.execute({ id: 't2', name: 'store_delta', args: { since_seq: 0 } }, { run_id: runId }) as Record<string, unknown>;
    expect(delta).toHaveProperty('events');
    try {
      // La capacité question.ask est tenue : tout refus éventuel ne vient JAMAIS du contrat.
      await h.execute({ id: 't3', name: 'store_ask', args: { question: 'C2c ?' } }, { run_id: runId });
    } catch (error) {
      expect(messageOf(error)).not.toMatch(/capability_not_held/);
    }
  });

  it('porte active : participant non enregistré — aucun outil servi (fail-closed C0)', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-ghost' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true });
    await expect(h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }))
      .rejects.toThrow(/capability_not_held:cycle\.read/);
  });

  it('porte active : enregistré sans rôle dans le cycle — refus', async () => {
    const { runId } = await seeded({ kind: 'research', participant: 'c2c-intruder' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true });
    await expect(h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }))
      .rejects.toThrow(/capability_not_held:cycle\.read/);
  });

  it('porte active : HALT conserve les lectures, refuse tout effet', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, storeWrites: true });
    await db.prepare("INSERT INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', ?1)").bind(NOW).run();
    try {
      const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
      expect(context.cycle_id).toBeDefined();
      await expect(h.execute({ id: 't2', name: 'store_ask', args: { question: 'bloqué ?' } }, { run_id: runId }))
        .rejects.toThrow(/capability_not_held:question\.ask/);
    } finally {
      await db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run();
    }
  });

  it('porte active : github.write exige auteur, mandat et chemins (C0)', async () => {
    const author = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const reviewer = await seeded({ kind: 'review', participant: 'c2c-reviewer' });
    const noPaths = await seeded({ kind: 'implement', participant: 'c2c-author', ownedPaths: '[]' });
    const options: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true,
      githubWrites: { writes, baseBranch: 'mcp/105856986/cc3-integration' } };
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, author.scope, options))).toContain('github.write');
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, reviewer.scope, options))).not.toContain('github.write');
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, noPaths.scope, options))).not.toContain('github.write');
    const h = createReadToolHost(options);
    await expect(h.execute({ id: 't', name: 'github_create_branch', args: { name: 'c2c' } }, { run_id: reviewer.runId }))
      .rejects.toThrow(/capability_not_held:github\.write/);
    await expect(h.execute({ id: 't2', name: 'github_create_branch', args: { name: 'c2c' } }, { run_id: noPaths.runId }))
      .rejects.toThrow(/capability_not_held:github\.write/);
  });

  it('porte active : review.verdict réservé au pair D12 (reviewer/tester) avec verdicts actifs', async () => {
    const reviewer = await seeded({ kind: 'review', participant: 'c2c-reviewer' });
    const author = await seeded({ kind: 'review', participant: 'c2c-author' });
    const withVerdicts: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, verdicts: true, requiredChecks: [] };
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, reviewer.scope, withVerdicts))).toContain('review.verdict');
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, author.scope, withVerdicts))).not.toContain('review.verdict');
    const h = createReadToolHost(withVerdicts);
    await expect(h.execute({ id: 't', name: 'store_verdict', args: { decision: 'agree' } }, { run_id: author.runId }))
      .rejects.toThrow(/capability_not_held:review\.verdict/);
    // Sans l'option verdicts, même le reviewer titulaire n'obtient pas la capacité d'affichage.
    const without: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true };
    const h2 = createReadToolHost(without);
    await expect(h2.execute({ id: 't2', name: 'store_verdict', args: { decision: 'agree' } }, { run_id: reviewer.runId }))
      .rejects.toThrow(/capability_not_held:review\.verdict/);
  });

  it('porte active : design.contribute et la mémoire, uniquement par grant serveur', async () => {
    const designer = await seeded({ kind: 'design', participant: 'c2c-author' });
    const on: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, contributions: true };
    const caps = resolveUnifiedCapabilities(await runVerifiedClaims(db, designer.scope, on));
    expect(caps).toContain('design.contribute');
    expect(caps).not.toContain('memory.propose');
    const off: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true };
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, designer.scope, off))).not.toContain('design.contribute');
  });
});

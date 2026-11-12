// Fixture unique C0/WorkSession : même identité serveur, rôles, grants et D1 pour les tests historiques et API.
import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ensureAgentRunSchema } from '../../../src/collab-store/agentrun/schema';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import type { RunScope } from '../../../src/collab-store/agentrun/read-tools';
import type { GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
export const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
export const NOW = 2_000_000_000;
/** c2c-author/reviewer/tester = titulaires ; c2c-intruder enregistré sans rôle ; c2c-answerer destinataire X13 sans tâche ; c2c-ghost absent de participants. */
const REGISTERED = ['c2c-author', 'c2c-reviewer', 'c2c-tester', 'c2c-intruder', 'c2c-answerer'];

export async function seeded(input: { kind: string; participant: string; ownedPaths?: string; taskless?: boolean }): Promise<{ runId: string; scope: RunScope }> {
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
    runId, cycleId, participantId: input.participant, taskId: input.taskless ? '' : taskId, taskKind: input.kind,
    prompt: 'Mission C2c.', maxSteps: 4, maxTokens: 5_000, maxCostCents: 0, deadlineAt: NOW + 900, now: NOW,
  });
  expect(created.created).toBe(true);
  return { runId, scope: { cycle_id: cycleId, participant_id: input.participant, task_id: input.taskless ? '' : taskId, task_kind: input.kind } };
}

export const github = {
  getTextFile: async () => ({ path: 'src/x.ts', sha: 'b'.repeat(40), content: 'contenu', size: 8 }),
  getPullRequest: async () => ({ number: 1, state: 'open', head: {}, base: {} }),
  listCheckRuns: async () => [],
  compareRefs: async () => ({ status: 'identical', files: [] }),
};

export const writes: GitHubWrites = {
  branchHead: async () => null,
  createBranch: async () => ({ sha: 'c'.repeat(40) }),
  commitFiles: async () => ({ commit_sha: 'd'.repeat(40) }),
  recentCommits: async () => [],
  openDraftPullRequest: async () => ({ number: 1, head_sha: 'e'.repeat(40) }),
  openPullRequest: async () => ({ number: 2, head_sha: 'f'.repeat(40) }),
  findPullRequest: async () => null,
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


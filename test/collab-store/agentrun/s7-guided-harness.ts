import { env } from 'cloudflare:test';
import { createRun, runStep, ToolRefused, type AgentMessage, type ModelOutput, type ToolCall, type ToolHost }
  from '../../../src/collab-store/agentrun';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC8 S7 — banc commun des tests du mode guidé (#278, lot A #281) : D1 de test, mandat, hôte d'outils
// scripté, modèle scripté, création et conduite d'une exécution. Aucun appel réseau.
export const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
export const T = 1_970_000_000;
export const BRANCH = 'mcp/105856986/vibe-api-s7-live';
export const PATH = 'test/collab-store/agentrun/s7-live-vibe.spec.ts';
export const BASE = 'b'.repeat(40);
export const HEAD = 'a'.repeat(40);
export const C1 = 'c'.repeat(40);
export const C2 = 'd'.repeat(40);
export const SCOPE = { branch: BRANCH, name: 's7-live', base_branch: 'mcp/105856986/cc3-integration', base_sha: BASE, granted_paths: [PATH],
  task_paths: [PATH], corrections_remaining: 3 };
export const WAIT = (sha: string) => ({ targetSha: sha, status: 'in_progress', conclusion: null, verifiedSuccess: false, next_action: 'wait', next_poll_seconds: 15 });
export const PASSED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'success', verifiedSuccess: true, next_action: 'request_D12', next_poll_seconds: null });
export const FAILED = (sha: string) => ({ targetSha: sha, status: 'completed', conclusion: 'failure', verifiedSuccess: false, next_action: 'correct', next_poll_seconds: null, diagnostics: ['expected 1 to be 2'] });

export const S7_TOOLS = ['github_write_scope', 'github_create_branch', 'github_commit_files', 'github_replace_text', 'github_run_checks',
  'github_check_result', 'github_open_pr', 'github_read_file'];

/** Hôte d'outils scripté : chaque outil rend la prochaine valeur de sa file (fonction = exception). */
export function host(queues: Record<string, Array<unknown | (() => never)>>) {
  const calls: ToolCall[] = [];
  const tools: ToolHost = {
    list: () => S7_TOOLS,
    spec: (_kind, name) => S7_TOOLS.includes(name) ? { name, effect: name === 'github_read_file' ? 'read' : 'write' } : null,
    async execute(call: ToolCall) {
      calls.push(call);
      const next = (queues[call.name] ?? []).shift();
      if (typeof next === 'function') return (next as () => never)();
      if (next === undefined) throw new ToolRefused('unexpected ' + call.name);
      return next;
    },
  };
  /** Appels d'écriture (lectures serveur exclues), dans l'ordre. */
  const writes = () => calls.map(c => c.name).filter(n => n !== 'github_read_file');
  return { tools, calls, writes };
}

/** Modèle scripté : rend les sorties dans l'ordre, puis « fin » ; chaque appel coûte `tokens`. */
export function scripted(outputs: ModelOutput[], tokens = 2_000) {
  const seen: Array<{ messages: AgentMessage[]; tools: string[] }> = [];
  return {
    seen,
    client: { async complete(input: { messages: AgentMessage[]; tools: string[] }) {
      seen.push({ messages: input.messages, tools: input.tools });
      return { output: outputs[seen.length - 1] ?? { text: 'fin', tool_calls: [] }, usage: { tokens, cost_cents: 0 } };
    } },
  };
}

/** Appel github_commit_files du modèle (nom d'outil libre pour les tests de canonisation). */
export const commitAs = (name: string, content: string, head = HEAD): ModelOutput => ({ text: '', tool_calls: [{ id: 'm-commit', name,
  args: { name: 's7-live', expected_head_sha: head, message: 'S7 test', files: [{ path: PATH, content }] } }] });

/** Exécution implement fraîche sous mandat S7 (un seul grant pour la branche du pilote). */
export async function newRun(label: string, maxSteps = 12) {
  await ensureSchema(db);
  const runId = 'cc8-guided-' + label + '-' + crypto.randomUUID();
  const cycleId = 'cc8-guided-' + crypto.randomUUID();
  await createRun(db, { runId, cycleId, participantId: 'vibe', taskId: 'S7-live-vibe', taskKind: 'implement', prompt: 'Écris le test S7.',
    maxSteps, maxTokens: 48_000, maxCostCents: 0, deadlineAt: T + 2_700, now: T });
  const grants = [{ cycle: cycleId, participant: 'vibe', task: 'S7-live-vibe', branch: BRANCH }];
  return { runId, grants };
}

/** Enchaîne les étapes jusqu'à un état autre que 'stepped' (au plus `max`). */
export async function drive(runId: string, deps: Parameters<typeof runStep>[2], max = 30) {
  const outcomes: string[] = [];
  for (let i = 0; i < max; i++) {
    const { outcome } = await runStep(db, runId, deps);
    outcomes.push(outcome);
    if (outcome !== 'stepped') break;
  }
  return outcomes;
}

export async function row(runId: string) {
  return (await db.prepare('SELECT status, stop_reason, steps_done, tokens_used FROM agent_runs WHERE run_id = ?1').bind(runId)
    .first<{ status: string; stop_reason: string; steps_done: number; tokens_used: number }>())!;
}

/** Pose ou lève le HALT propriétaire. */
export async function setHalt(on: boolean) {
  await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt', ?1, NULL, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .bind(on ? '1' : '0', T).run();
}

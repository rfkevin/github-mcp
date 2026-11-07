import { ToolRefused } from '../engine';
import { ACCEPTANCE_MAX_CHARS, ACCEPTANCE_MAX_ITEMS, MISSION_KINDS, type MissionKind } from '../mission-quality';
import { equivalentParticipantIds } from '../../identity/families';
import { agentRunPaused } from '../../owner/agent-run-status';
import { isAutomationHalted } from '../../owner/automation';

/** Owner-supplied configuration, never model arguments. Empty configuration denies writes. */
export interface WritePolicy { writers?: string; tasks?: string }
export interface WriteGrant {
  cycle: string; task: string; participant: string; branch: string; paths: string[];
  /** Lot C R3 (#283) : `functional` déclaré par le propriétaire ; absent = pilote technique (inchangé). */
  mission?: MissionKind; acceptance?: string[];
}
export interface WriteScope extends WriteGrant { run_id: string; owned_paths: string[] }

function validIdentifier(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}
function validGrantPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return validPath(value.endsWith('/') ? value.slice(0, -1) : value);
}
/** Lot C R3 : mission fonctionnelle = critères d'acceptation obligatoires ; pilote = aucun critère. */
function parseMission(item: Record<string, unknown>): void {
  const mission = item.mission ?? 'pilot';
  if (!(MISSION_KINDS as readonly unknown[]).includes(mission)) throw new Error();
  if (mission === 'pilot') {
    if (item.acceptance !== undefined) throw new Error();
    return;
  }
  const list = item.acceptance;
  if (!Array.isArray(list) || list.length === 0 || list.length > ACCEPTANCE_MAX_ITEMS) throw new Error();
  if (!list.every(c => typeof c === 'string' && c.trim().length > 0 && c.length <= ACCEPTANCE_MAX_CHARS)) throw new Error();
}
function parseGrant(value: unknown): WriteGrant {
  if (!value || typeof value !== 'object') throw new Error();
  const keys = Object.keys(value);
  const expectedKeys = ['branch', 'cycle', 'participant', 'paths', 'task'];
  const optionalKeys = ['mission', 'acceptance'];
  if (!expectedKeys.every(key => keys.includes(key)) || keys.some(key => !expectedKeys.includes(key) && !optionalKeys.includes(key))) throw new Error();
  const item = value as Record<string, unknown>;
  parseMission(item);
  if (!['cycle', 'task', 'participant', 'branch'].every(key => validIdentifier(item[key]))) throw new Error();
  if (!Array.isArray(item.paths) || item.paths.length === 0 || item.paths.length > 50) throw new Error();
  if (!item.paths.every(validGrantPath)) throw new Error();
  return item as unknown as WriteGrant;
}
export function grants(policy: WritePolicy): WriteGrant[] {
  if (!policy.tasks) return [];
  try {
    const value: unknown = JSON.parse(policy.tasks);
    if (!Array.isArray(value) || value.length > 50) throw new Error();
    return value.map(parseGrant);
  } catch { throw new ToolRefused('api_write_policy_invalid'); }
}

export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 400 && !/[\\\x00-\x1f\x7f]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}
export function inPaths(path: string, paths: readonly string[]): boolean {
  return validPath(path) && paths.some(p => p.endsWith('/') ? path.startsWith(p) : path === p);
}
export function assertPaths(scope: WriteScope, paths: string[]): void {
  if (!paths.length || paths.some(path => !inPaths(path, scope.paths) || !inPaths(path, scope.owned_paths))) {
    throw new ToolRefused('api_write_outside_task');
  }
}

export async function authorize(db: D1Database, policy: WritePolicy, runId: string, branch: string): Promise<WriteScope> {
  const run = await db.prepare('SELECT participant_id, cycle_id, task_id, task_kind, status, lease_key, generation FROM agent_runs WHERE run_id = ?1')
    .bind(runId).first<{ participant_id: string; cycle_id: string; task_id: string; task_kind: string; status: string; lease_key: string; generation: number }>();
  if (!run || run.task_kind !== 'implement' || run.status !== 'running') throw new ToolRefused('api_write_run_invalid');
  const writers = (policy.writers ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!writers.includes(run.participant_id)) throw new ToolRefused('api_writer_not_enabled');
  const matches = grants(policy).filter(g => g.participant === run.participant_id && g.cycle === run.cycle_id && g.task === run.task_id);
  if (matches.length !== 1 || matches[0].branch !== branch) throw new ToolRefused('api_task_not_enabled');
  const task = await db.prepare('SELECT t.owner_pid, t.status, t.owned_paths, c.status AS cycle_status FROM tasks t JOIN cycles c ON c.cycle_id=t.cycle_id WHERE t.cycle_id=?1 AND t.task_id=?2')
    .bind(run.cycle_id, run.task_id).first<{ owner_pid: string; status: string; owned_paths: string; cycle_status: string }>();
  const ids = await equivalentParticipantIds(db, run.participant_id);
  if (!task || !ids.includes(task.owner_pid) || task.cycle_status !== 'open' || task.status !== 'in_progress') throw new ToolRefused('api_write_task_inactive');
  if (await isAutomationHalted(db)) throw new ToolRefused('HALT_ACTIVE');
  for (const pid of ids) if (await agentRunPaused(db, pid)) throw new ToolRefused('AGENT_PAUSED');
  const fence = await db.prepare('SELECT generation, holder FROM agent_fences WHERE lease_key=?1').bind(run.lease_key)
    .first<{ generation: number; holder: string }>();
  if (!fence || fence.generation !== run.generation || fence.holder !== 'api') throw new ToolRefused('api_write_preempted');
  let owned: unknown;
  try { owned = JSON.parse(task.owned_paths); } catch { throw new ToolRefused('api_write_paths_invalid'); }
  if (!Array.isArray(owned) || !owned.every(p => typeof p === 'string')) throw new ToolRefused('api_write_paths_invalid');
  return { ...matches[0], run_id: runId, owned_paths: owned };
}

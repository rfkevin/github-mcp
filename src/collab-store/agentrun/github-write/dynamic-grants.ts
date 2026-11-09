/** CC8 — mandats GitHub éphémères créés dans D1, sous UNE politique owner de portée bornée.
 *
 * Aucun appel modèle, événement de tâche ou texte libre ne constitue une autorisation :
 * seule une requête MCP authentifiée par un coordinateur owner-approved peut insérer
 * un mandat ; le Worker doit avoir une politique propriétaire déployée et non vide.
 * Chaque lecture revalide la politique actuelle, le TTL, les chemins et la branche.
 */
import { ToolRefused } from '../engine';
import { sha256Hex } from '../../store/hash';
import { ensureAgentRunSchema } from '../schema';
import { apiBranch } from '../github-tools';
import { activeCoordinatorGuard, isCoordinator } from '../../owner/coordinators';
import type { WriteGrant } from './authorization';

export interface DynamicGrantPolicy {
  cycle: string;
  participants: string[];
  path_prefixes: string[];
  max_paths: number;
  max_grants: number;
}
export interface DynamicGrantRequest {
  cycle: string; task: string; participant: string; paths: string[];
  coordinator: string; acceptance?: string[]; now: number;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PID = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const validPath=(path:string):boolean=>path.length>0&&path.length<=400
  && !/[\\\x00-\x1f\x7f]/.test(path)
  && !path.split('/').some(part=>!part||part==='.'||part==='..');
const FORBIDDEN = /^(?:\.github|\.mcp|scripts|migrations)(?:\/|$)|^(?:wrangler\.(?:jsonc?|toml)|AGENT_MEMORY\.md|TOOL_IMPROVEMENTS\.md)$/i;
export const DYNAMIC_GRANT_TTL_SECONDS = 48 * 3600;

function reject(code:string):never { throw new ToolRefused(code); }
function validPaths(policy:DynamicGrantPolicy, paths: readonly string[]): boolean {
  return paths.length > 0 && paths.length <= policy.max_paths
    && new Set(paths).size === paths.length && paths.every(path =>
      validPath(path) && !path.endsWith('/') && !FORBIDDEN.test(path)
      && policy.path_prefixes.some(prefix => path.startsWith(prefix)));
}

/** No configuration => no dynamic grants. Malformed configuration => fail closed. */
export function parseDynamicGrantPolicy(raw?:string): DynamicGrantPolicy | null {
  if (raw === undefined || raw === '') return null;
  let value:unknown;
  try { value = JSON.parse(raw); } catch { return reject('dynamic_policy_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('dynamic_policy_invalid');
  const p=value as Record<string,unknown>;
  if (Object.keys(p).some(k=>!['cycle','participants','path_prefixes','max_paths','max_grants'].includes(k))
    || !ID.test(String(p.cycle ?? '')) || !Array.isArray(p.participants) || !Array.isArray(p.path_prefixes)
    || p.participants.length<1 || p.participants.length>8
    || p.path_prefixes.length<1 || p.path_prefixes.length>12
    || !Number.isSafeInteger(p.max_paths) || Number(p.max_paths)<1 || Number(p.max_paths)>5
    || !Number.isSafeInteger(p.max_grants) || Number(p.max_grants)<1 || Number(p.max_grants)>50)
    return reject('dynamic_policy_invalid');
  const participants=p.participants as unknown[];
  const prefixes=p.path_prefixes as unknown[];
  if (new Set(participants).size !== participants.length || !participants.every(x=>typeof x==='string'&&PID.test(x))
    || new Set(prefixes).size !== prefixes.length
    || !prefixes.every(x=>typeof x==='string'&&x.endsWith('/')&&x.length>6
      && validPath(x.slice(0,-1)) && !FORBIDDEN.test(x.slice(0,-1)))) return reject('dynamic_policy_invalid');
  return p as unknown as DynamicGrantPolicy;
}
function policyAllows(p:DynamicGrantPolicy, cycle:string,task:string,pid:string,paths:readonly string[]):boolean {
  return p.cycle===cycle && ID.test(task) && p.participants.includes(pid) && validPaths(p,paths);
}
async function branchFor(cycle:string,task:string,pid:string):Promise<string> {
  const digest=await sha256Hex(cycle+'\u001f'+task);
  return apiBranch(pid, 'd'+digest.slice(0,24));
}
interface GrantRow {
  cycle:string; task:string; participant:string; branch:string; paths_json:string;
  acceptance_json:string; created_by:string; created_at:number; expires_at:number;
}
function parseRow(row: GrantRow): WriteGrant {
  const paths=JSON.parse(row.paths_json) as string[];
  const acceptance=JSON.parse(row.acceptance_json) as string[];
  return {cycle:row.cycle,task:row.task,participant:row.participant,branch:row.branch,
    paths,mission:'functional',acceptance};
}

/** Read-on-every-effect: an old D1 row never grants rights after policy removal/expiry. */
export async function findDynamicGrant(db:D1Database,raw:string|undefined,cycle:string,task:string,
  participant:string,now=Math.floor(Date.now()/1000)):Promise<WriteGrant|null> {
  const p=parseDynamicGrantPolicy(raw);
  if (!p || p.cycle!==cycle || !p.participants.includes(participant)) return null;
  await ensureAgentRunSchema(db);
  const row=await db.prepare('SELECT cycle,task,participant,branch,paths_json,acceptance_json,created_by,created_at,expires_at FROM api_dynamic_grants WHERE cycle=?1 AND task=?2 AND participant=?3')
    .bind(cycle,task,participant).first<GrantRow>();
  if (!row || row.expires_at<=now) return null;
  // A coordinator's revocation must revoke ALL of its live grants immediately.
  const alive=await db.prepare(
    "SELECT 1 AS ok WHERE EXISTS(SELECT 1 FROM cycles WHERE cycle_id=?2 AND status='open') AND "
    + activeCoordinatorGuard('?1')
  ).bind(row.created_by,cycle).first<{ok:number}>();
  if (alive?.ok!==1) return null;
  let paths:string[], acceptance:string[];
  try { paths=JSON.parse(row.paths_json) as string[]; acceptance=JSON.parse(row.acceptance_json) as string[]; }
  catch { return reject('dynamic_grant_corrupt'); }
  if (!policyAllows(p,cycle,task,participant,paths)
    || row.branch !== await branchFor(cycle,task,participant)
    || !Array.isArray(acceptance)||acceptance.length<1 || acceptance.length>4
    || acceptance.some(x=>typeof x!=='string'||!x.trim()||x.length>350)) return reject('dynamic_grant_invalid');
  return parseRow(row);
}

/** One-time D1 CAS insert, append-only. Replay must match EXACT intent; no widening. */
export async function issueDynamicGrant(db:D1Database,raw:string|undefined,i:DynamicGrantRequest):Promise<WriteGrant> {
  const p=parseDynamicGrantPolicy(raw);
  if (!p) return reject('dynamic_policy_not_approved');
  if (!policyAllows(p,i.cycle,i.task,i.participant,i.paths) || !PID.test(i.coordinator)
    || !Number.isSafeInteger(i.now)||i.now<=0) return reject('dynamic_scope_not_approved');
  const acceptance=i.acceptance??[
    'Lire le contexte, la mémoire, la continuité et les vrais fichiers source avant de coder.',
    'Respecter le mandat de fichiers et les tests CI ; ouvrir une PR et enregistrer une passation.',
  ];
  if (!Array.isArray(acceptance)||acceptance.length<1||acceptance.length>4
      || acceptance.some(x=>typeof x!=='string'||!x.trim()||x.length>350))
    return reject('dynamic_acceptance_invalid');
  const branch=await branchFor(i.cycle,i.task,i.participant);
  await ensureAgentRunSchema(db);
  const expiration=i.now+DYNAMIC_GRANT_TTL_SECONDS;
  await db.prepare([
    'INSERT OR IGNORE INTO api_dynamic_grants(cycle,task,participant,branch,paths_json,acceptance_json,created_by,created_at,expires_at)',
    'SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9',
    'WHERE (SELECT COUNT(*) FROM api_dynamic_grants WHERE cycle=?1) < ?10',
    "AND EXISTS(SELECT 1 FROM cycles WHERE cycle_id=?1 AND status='open')",
    'AND ' + activeCoordinatorGuard('?7')
  ].join(' ')).bind(i.cycle,i.task,i.participant,branch,JSON.stringify(i.paths),JSON.stringify(acceptance),
    i.coordinator,i.now,expiration,p.max_grants).run();
  const row=await db.prepare('SELECT cycle,task,participant,branch,paths_json,acceptance_json,created_by,created_at,expires_at FROM api_dynamic_grants WHERE cycle=?1 AND task=?2 AND participant=?3')
    .bind(i.cycle,i.task,i.participant).first<GrantRow>();
  // Diagnose only after the atomic INSERT guard; these reads never grant permission.
  const cycle=await db.prepare('SELECT status FROM cycles WHERE cycle_id=?1')
    .bind(i.cycle).first<{status:string}>();
  if (cycle?.status!=='open') return reject('dynamic_cycle_not_open');
  if (!await isCoordinator(db,i.coordinator)) return reject('dynamic_coordinator_not_active');
  if (!row) {
    const count=await db.prepare('SELECT COUNT(*) AS n FROM api_dynamic_grants WHERE cycle=?1')
      .bind(i.cycle).first<{n:number}>();
    if ((count?.n??0)>=p.max_grants) return reject('dynamic_grant_cap_exhausted');
    const collision=await db.prepare('SELECT 1 AS ok FROM api_dynamic_grants WHERE branch=?1')
      .bind(branch).first<{ok:number}>();
    if (collision) return reject('dynamic_branch_conflict');
    return reject('dynamic_grant_insert_refused');
  }
  if (row.expires_at<=i.now) return reject('dynamic_grant_expired');
  if (row.branch!==branch || row.paths_json!==JSON.stringify(i.paths)
    || row.acceptance_json!==JSON.stringify(acceptance) || row.created_by!==i.coordinator)
    return reject('dynamic_grant_conflict');
  return parseRow(row);
}

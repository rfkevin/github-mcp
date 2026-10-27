/**
 * CC-7 L6b-3 (plan CC-PLAN-7 v0.2, S11, Q4) — interrupteur de fusion automatique vers
 * la branche d'INTÉGRATION, et message « prêt à promouvoir » (S8).
 *
 * Éteint par défaut, allumé par Kevin seul sur le Worker :
 * - AUTO_MERGE_INTEGRATION === 'true' (exact) ;
 * - AUTO_MERGE_REPOSITORY (owner/repo) et AUTO_MERGE_BRANCH (branche d'intégration,
 *   jamais main ni master : refus en code) ;
 * - AUTO_MERGE_REQUIRED_CHECKS facultatif (défaut : les 4 contrôles D12 du dépôt).
 *
 * Aucun nouveau chemin d'écriture : le passage réutilise la porte CC-5 L4 telle quelle
 * (evaluateMergeGate : D12 complet au couple exact via la décision merge_ready du
 * contrôleur, HALT, CI nommée, base = tête d'intégration, PR non brouillon et
 * fusionnable, chemins protégés exclus, bail ; puis executeIntegration et l'exécuteur
 * fencé createGitHubMergeExecutor : intention D1 unique, branche temporaire,
 * fast-forward sans force, relectures avant le PATCH). Le module ne connaît pas le
 * client GitHub (invariant C6) : la racine du Worker injecte les lectures et la
 * requête REST.
 *
 * Le bail (cc5_merge_leases) est posé par ce passage pour le couple exact, juste avant
 * l'exécution, et expire après MERGE_INTENT_TTL_SECONDS : une soumission qui change de
 * head ou de base ne correspond plus au bail ni à l'intention.
 */
import { nextActors, type ControllerSnapshot } from '../controller/rules';
import { readControllerSnapshot } from '../controller/snapshot';
import { inspectPhase } from '../phases/engine';
import { sha256Hex } from '../store/hash';
import { ensureSchema } from '../store/schema';
import { postSalonMessage, salonEnabled, SalonError } from '../salon';
import type { MergeCandidate } from './merge-gate';
import { runGitHubIntegration, type GitHubGateReader } from './github-adapter';
import { createGitHubMergeExecutor } from './github-merge-executor';
import { createGitHubRestPort, type GitHubRestRequest } from './github-rest-port';
import { MERGE_INTENT_SCHEMA, MERGE_INTENT_TTL_SECONDS } from './merge-intent';
import type { IntegrationOutcome } from './integration';

/** Chemins jamais fusionnés automatiquement (S11) : Kevin les fusionne à la main. */
export const AUTO_MERGE_PROTECTED_PATHS: readonly string[] = Object.freeze([
  '.github', 'wrangler.jsonc', 'wrangler.toml', 'package.json', 'package-lock.json', 'migrations',
  'src/security', 'src/collab-store/owner', 'src/collab-store/gates', 'src/auth', 'src/oauth',
  'AGENT_MEMORY.md', 'TOOL_IMPROVEMENTS.md', 'AGENTS.md', 'CLAUDE.md',
]);
export const AUTO_MERGE_DEFAULT_CHECKS: readonly string[] = Object.freeze([
  'ci', 'Workers Builds: github-mcp', 'GitGuardian Security Checks', 'SonarCloud Code Analysis',
]);
/** Au plus ce nombre de fusions par passage (une erreur n'arrête pas les autres candidats). */
export const AUTO_MERGE_PASS_LIMIT = 3;

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;
const SHA_PAIR_RE = /^([a-f0-9]{40})\.\.([a-f0-9]{40})$/;

export interface AutoMergeEnv {
  AUTO_MERGE_INTEGRATION?: string;
  AUTO_MERGE_REPOSITORY?: string;
  AUTO_MERGE_BRANCH?: string;
  AUTO_MERGE_REQUIRED_CHECKS?: string;
  SALON_ENABLED?: string;
}

export interface AutoMergeConfig { repository: string; branch: string; checks: readonly string[] }

/** Configuration effective, ou null (éteint, incomplet, ou branche principale) : fail-closed. */
export function autoMergeConfig(env: AutoMergeEnv): AutoMergeConfig | null {
  if (env.AUTO_MERGE_INTEGRATION !== 'true') return null;
  const repository = (env.AUTO_MERGE_REPOSITORY ?? '').trim();
  const branch = (env.AUTO_MERGE_BRANCH ?? '').trim();
  if (!REPOSITORY_RE.test(repository) || !BRANCH_RE.test(branch) || branch.includes('..')) return null;
  if (/^(main|master)$/i.test(branch) || /^refs\//.test(branch)) return null;
  const raw = env.AUTO_MERGE_REQUIRED_CHECKS;
  const names = raw === undefined ? [] : raw.split(',').map(name => name.trim()).filter(Boolean);
  const checks = names.length >= 1 && names.length <= 10 && names.every(name => name.length <= 100)
    ? [...new Set(names)] : [...AUTO_MERGE_DEFAULT_CHECKS];
  return { repository, branch, checks };
}

/** Lectures GitHub injectées par la racine du Worker (aucun client GitHub dans le store). */
export interface AutoMergeGitHub {
  /** Requête REST authentifiée (écritures de l'exécuteur : branche temporaire, merge, PATCH sans force). */
  request: GitHubRestRequest;
  pull(pr: number): Promise<{ head: string; draft: boolean; mergeable: boolean | null; state: string; baseRef: string }>;
  checks(sha: string): Promise<Array<{ name: string; status: string; conclusion: string | null }>>;
  changedFiles(base: string, head: string): Promise<string[]>;
  branchSha(branch: string): Promise<string>;
}

export interface AutoMergeCandidate { cycle_id: string; task_id: string; pr: number; head: string; base: string }

/** PR de la soumission courante (evidence.add de l'auteur au même head/base), ou null. */
async function submissionPr(db: D1Database, cycleId: string, taskId: string, head: string, base: string): Promise<number | null> {
  const { results } = await db.prepare([
    "SELECT payload_json FROM events WHERE cycle_id = ?1 AND type = 'evidence.add' AND json_valid(payload_json)",
    "AND json_extract(payload_json, '$.task') = ?2 AND json_extract(payload_json, '$.head') = ?3",
    "AND json_extract(payload_json, '$.base') = ?4 ORDER BY seq DESC LIMIT 20",
  ].join(' ')).bind(cycleId, taskId, head, base).all<{ payload_json: string }>();
  for (const row of results) {
    const pr = (JSON.parse(row.payload_json) as { pr?: unknown }).pr;
    if (typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0) return pr;
  }
  return null;
}

async function snapshotOf(db: D1Database, cycleId: string): Promise<ControllerSnapshot> {
  return readControllerSnapshot(db, cycleId, async id => {
    const facts = await inspectPhase(db, id);
    return { satisfied: facts.outputsSatisfied, outputs: facts.outputs };
  });
}

/** Candidats : décisions merge_ready du contrôleur (deux verdicts positifs au même head/base) des cycles ouverts. */
export async function autoMergeCandidates(db: D1Database, limit = 20): Promise<AutoMergeCandidate[]> {
  await ensureSchema(db);
  const { results } = await db.prepare("SELECT cycle_id FROM cycles WHERE status = 'open' ORDER BY cycle_id LIMIT ?1")
    .bind(limit).all<{ cycle_id: string }>();
  const out: AutoMergeCandidate[] = [];
  for (const { cycle_id } of results) {
    let snapshot: ControllerSnapshot;
    try { snapshot = await snapshotOf(db, cycle_id); } catch { continue; }
    for (const decision of nextActors(snapshot).decisions) {
      const pair = decision.kind === 'merge_ready' && decision.task_id ? SHA_PAIR_RE.exec(decision.subject) : null;
      if (!pair) continue;
      const pr = await submissionPr(db, cycle_id, decision.task_id!, pair[1], pair[2]);
      if (pr !== null) out.push({ cycle_id, task_id: decision.task_id!, pr, head: pair[1], base: pair[2] });
    }
  }
  return out;
}

export type AutoMergeResult = AutoMergeCandidate & { outcome: IntegrationOutcome['state'] | 'error'; detail: string };

async function salonTrace(db: D1Database, env: AutoMergeEnv, body: string, level: 'info' | 'decision', now: number, incidentKey?: string): Promise<void> {
  if (!salonEnabled(env)) return;
  try {
    await postSalonMessage(db, env, { authorPid: 'controller', level, body, now, skipAgentQuota: true,
      ...(incidentKey ? { incidentKey } : {}) });
  } catch (error) {
    // Trace best-effort : un salon en HALT ou un incident déjà signalé ne fait jamais échouer le passage.
    if (!(error instanceof SalonError)) throw error;
  }
}

/** Une fusion candidate, par la porte et l'exécuteur CC-5 L4 inchangés. */
async function mergeOne(db: D1Database, config: AutoMergeConfig, github: AutoMergeGitHub,
  target: AutoMergeCandidate, nowFn: () => number): Promise<IntegrationOutcome> {
  const leaseNow = nowFn();
  // Bail du couple exact, posé par ce passage (schéma d'intention installé avant).
  await db.batch(MERGE_INTENT_SCHEMA.map(statement => db.prepare(statement)));
  await db.prepare([
    'INSERT INTO cc5_merge_leases (cycle, task, head, base, expires_at, revoked) VALUES (?1, ?2, ?3, ?4, ?5, 0)',
    'ON CONFLICT(cycle, task) DO UPDATE SET head = excluded.head, base = excluded.base, expires_at = excluded.expires_at, revoked = 0',
  ].join(' ')).bind(target.cycle_id, target.task_id, target.head, target.base, leaseNow + MERGE_INTENT_TTL_SECONDS).run();

  const inspect = async (): Promise<{ snapshot: ControllerSnapshot; candidate: MergeCandidate }> => {
    const now = nowFn();
    const [snapshot, pull, checks, integrationBase, lease] = await Promise.all([
      snapshotOf(db, target.cycle_id), github.pull(target.pr), github.checks(target.head),
      github.branchSha(config.branch),
      db.prepare('SELECT cycle, task, head, base, expires_at, revoked FROM cc5_merge_leases WHERE cycle = ?1 AND task = ?2')
        .bind(target.cycle_id, target.task_id).first<{ cycle: string; task: string; head: string; base: string; expires_at: number; revoked: number }>(),
    ]);
    const changed = await github.changedFiles(target.base, target.head);
    return { snapshot, candidate: {
      cycleId: target.cycle_id, taskId: target.task_id,
      // Head lu sur la PR (un head déplacé ne correspond plus à la soumission) ; une PR fermée ou qui
      // ne vise pas la branche d'intégration est traitée comme non fusionnable (refus de la porte).
      head: pull.head, base: target.base, integrationBase, prDraft: pull.draft,
      prMergeable: pull.mergeable === true && pull.state === 'open' && pull.baseRef === config.branch,
      ciChecks: checks, expectedChecks: config.checks, changedPaths: changed, protectedPaths: AUTO_MERGE_PROTECTED_PATHS,
      lease: lease ? { cycleId: lease.cycle, taskId: lease.task, head: lease.head, base: lease.base,
        expiresAt: lease.expires_at, revoked: lease.revoked === 1 } : null,
      now,
    } };
  };
  const reader: GitHubGateReader = {
    inspect,
    // Fusion confirmée : la tête de la branche d'intégration est le commit de fusion.
    mergedPullRequest: async sha => (await github.branchSha(config.branch)) === sha,
    linkedIssue: async () => null,
    closeIssue: async () => undefined,
  };
  const attemptId = 'cc7-' + (await sha256Hex([target.cycle_id, target.task_id, target.head, target.base].join('|'))).slice(0, 20);
  const intent = { cycle: target.cycle_id, task: target.task_id, pr: target.pr, head: target.head, base: target.base, now: leaseNow };
  const writer = createGitHubMergeExecutor({ db, intent, inspect, enabled: true,
    github: createGitHubRestPort(github.request, config.repository, target.pr, config.branch, attemptId) });
  return runGitHubIntegration(reader, writer, { pr: target.pr, task: target.task_id, head: target.head, base: target.base });
}

/**
 * Passage de fusion automatique : rien sans autoMergeConfig (éteint par défaut). Chaque candidat
 * passe la porte L4 deux fois puis l'exécuteur fencé ; une fusion confirmée est tracée au salon.
 */
export async function runAutoMergePass(db: D1Database, env: AutoMergeEnv, github: AutoMergeGitHub,
  options: { now?: () => number } = {}): Promise<AutoMergeResult[]> {
  const config = autoMergeConfig(env);
  if (!config) return [];
  const nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
  const results: AutoMergeResult[] = [];
  await db.batch(MERGE_INTENT_SCHEMA.map(statement => db.prepare(statement)));
  // Équité : un couple déjà fusionné (ou à l'issue incertaine, arbitrage humain) n'est plus tenté ; un
  // couple tenté il y a moins de MERGE_INTENT_TTL_SECONDS (bail encore valide) attend son tour, pour
  // qu'un refus durable ne confisque pas les AUTO_MERGE_PASS_LIMIT places du passage.
  const due: AutoMergeCandidate[] = [];
  for (const target of await autoMergeCandidates(db)) {
    if (due.length >= AUTO_MERGE_PASS_LIMIT) break;
    const settled = await db.prepare("SELECT 1 AS x FROM cc5_merge_intents WHERE cycle = ?1 AND task = ?2 AND head = ?3 AND base = ?4 AND state IN ('merged', 'uncertain')")
      .bind(target.cycle_id, target.task_id, target.head, target.base).first();
    const recent = await db.prepare('SELECT 1 AS x FROM cc5_merge_leases WHERE cycle = ?1 AND task = ?2 AND head = ?3 AND base = ?4 AND expires_at > ?5')
      .bind(target.cycle_id, target.task_id, target.head, target.base, nowFn()).first();
    if (!settled && !recent) due.push(target);
  }
  for (const target of due) {
    try {
      const outcome = await mergeOne(db, config, github, target, nowFn);
      const detail = outcome.state === 'denied' ? outcome.verdict.reasons.join(',')
        : 'mergeSha' in outcome && outcome.mergeSha ? outcome.mergeSha : '';
      results.push({ ...target, outcome: outcome.state, detail });
      if (outcome.state === 'merged') {
        await salonTrace(db, env, 'Fusion automatique vers ' + config.branch + ' : PR #' + target.pr + ' (' + target.cycle_id + ', '
          + target.task_id + ', ' + target.head.slice(0, 7) + '/' + target.base.slice(0, 7) + ') → ' + outcome.mergeSha.slice(0, 7)
          + '. Deux verdicts au couple exact, CI ' + config.checks.length + '/' + config.checks.length + '.', 'info', nowFn());
      }
    } catch (error) {
      results.push({ ...target, outcome: 'error', detail: error instanceof Error ? error.message.slice(0, 200) : 'error' });
    }
  }
  return results;
}

/**
 * S8 « produit viable » (approximation serveur) : cycle en P6, au moins une tâche, toutes
 * terminées (done ou verified). Un message salon `decision` « prêt à promouvoir » à Kevin,
 * une seule fois par cycle (incident_key promote:<cycle>, sans fait nouveau = jamais répété).
 */
export async function announceReadyToPromote(db: D1Database, env: AutoMergeEnv, options: { now?: () => number } = {}): Promise<string[]> {
  if (!salonEnabled(env)) return [];
  await ensureSchema(db);
  const { results } = await db.prepare([
    "SELECT c.cycle_id FROM cycles c WHERE c.status = 'open' AND c.phase = 'P6'",
    'AND EXISTS (SELECT 1 FROM tasks t WHERE t.cycle_id = c.cycle_id)',
    "AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.cycle_id = c.cycle_id AND t.status NOT IN ('done', 'verified'))",
    'ORDER BY c.cycle_id LIMIT 20',
  ].join(' ')).all<{ cycle_id: string }>();
  const announced: string[] = [];
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  for (const { cycle_id } of results) {
    const already = await db.prepare("SELECT 1 AS ok FROM salon_messages WHERE incident_key = ?1 LIMIT 1")
      .bind('promote:' + cycle_id).first().catch(() => null);
    if (already) continue;
    await salonTrace(db, env, 'Prêt à promouvoir : le cycle ' + cycle_id + ' est en P6 et toutes ses tâches sont terminées. '
      + 'La promotion vers main reste ton acte (Kevin).', 'decision', now, 'promote:' + cycle_id);
    announced.push(cycle_id);
  }
  return announced;
}

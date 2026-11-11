/**
 * CC-5 l7 (incrément 7c-1) — hôte d'outils en LECTURE SEULE pour les exécutions API.
 *
 * Allowlist deny-by-default figée en code (amendement A2, plan seq 719) : chaque
 * type de tâche n'a que les outils listés dans READ_TOOLS_BY_KIND ; aucun outil
 * d'écriture (effect 'read' partout), donc aucun effet externe en 7c-1. Le
 * moteur refuse en plus API_AGENT_FORBIDDEN et tronque chaque résultat
 * (RESULT_MAX_CHARS) avant de le rendre au modèle comme donnée.
 *
 * CC-7 L5a (S9) : github_diff donne aux types `review` et `test` le couple
 * head/base exact de la soumission (head = SHA de 40 caractères, base = SHA ou
 * branche), avec bornage des fichiers et des patchs rendus au modèle.
 *
 * CC-7 L5b (S10) : store_verdict dépose le verdict D12 d'une relecture ou d'un
 * test APRÈS re-vérification serveur (verdict-tools.ts) ; chaque lecture GitHub
 * réussie est journalée dans agent_run_reads (preuve au SHA exact).
 *
 * Le participant et le cycle d'un appel sont relus dans agent_runs à partir
 * du run_id fourni par le moteur, jamais pris dans les arguments du modèle :
 * une exécution ne lit que le contexte de SON participant (masquage CR-C du
 * store, redactEventsFor) et que le dépôt autorisé par l'hôte.
 */
import { CollabStore } from '../store/collab-store';
import { equivalentParticipantIds } from '../identity/families';
import { loadActiveWork, loadContinuity, loadVisibleActiveMemory, memoryRolesOf } from '../context';

import { ToolRefused, type LookupResult, type ToolCall, type ToolHost, type ToolSpec } from './engine';
import type { ToolSchema } from './workers-ai-model';
import { createStoreWriteTools, WRITE_TOOL_SCHEMAS, type WriteToolName } from './store-tools';
import { API_BRANCH_NAMESPACE, createGitHubWriteTools, GITHUB_WRITE_TOOL_SCHEMAS, type GitHubWrites, type GitHubWriteToolName } from './github-tools';
import { createS7Tools, S7_SCHEMAS, type S7Options } from './github-write/tools';
import { exactGrant, type WriteGrant } from './github-write/authorization';
import { sha256Hex } from '../store/hash';
import { createVerdictTools, VERDICT_TOOL_SCHEMAS } from './verdict-tools';
import { createContributionTools, CONTRIBUTION_TASK_KIND, CONTRIBUTION_TOOL_SCHEMAS } from './contribution-tools';
import { createModelChoiceTools, MODEL_CHOICE_TOOL_SCHEMAS } from './model-choice-tools';
import type { PolicyEnv } from './model-policy';
import { createResearchTools, RESEARCH_TOOL_SCHEMAS, type ResearchToolsOptions } from './research';
import { diffReadRef } from './verify-guided';
// CC8 C2c : le catalogue runtime consomme le contrat unique C0 (attestations serveur uniquement).
import { hasUnifiedCapability, type AssignedTaskRole, type UnifiedCapability, type VerifiedCapabilityClaims } from './agent-capabilities';

/**
 * CC-7 M2 : rôle mémoire tenu par une exécution API selon son type (role:<rôle>, parité avec le
 * rôle de tâche servi au chat). Les contributions de conception (design) n'en portent pas.
 */
export function runRoles(taskKind: string): string[] {
  if (taskKind === 'review') return ['reviewer'];
  if (taskKind === 'test') return ['tester'];
  if (taskKind === 'implement') return ['owner'];
  if (taskKind === 'research') return ['researcher'];
  return [];
}

/** Lectures GitHub utilisées par l'hôte (sous-ensemble des clients existants, lecture seule). */
export interface GitHubReads {
  getTextFile(repository: string, path: string, ref: string): Promise<{ path: string; sha: string; content: string; size: number }>;
  /** Optional for older test hosts; actual Worker GitHub client provides bounded safe directory listings. */
  listDirectory?(repository: string, path: string, ref: string): Promise<Array<{name:string;path:string;type:string;size:number;sha:string}>>;
  getPullRequest(repository: string, pullNumber: number): Promise<unknown>;
  listCheckRuns(repository: string, ref: string): Promise<unknown[]>;
  /** CC-7 L5a : diff entre une base et un head exact (compare du client, lecture seule). */
  compareRefs(repository: string, base: string, head: string): Promise<unknown>;
}

/** CC-7 L5a : bornes du diff rendu au modèle (fichiers et patchs, S9). */
export const DIFF_MAX_FILES = 50;
export const DIFF_PATCH_CHARS = 2000;

export const READ_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_context', description: 'Contexte du cycle et active_work partagés avec le chat, registre intégral paginé. full:true permet la lecture non compactée à la demande.',
    parameters: { type: 'object', properties: {
      full: { type: 'boolean' }, registry_page: { type: 'integer', minimum: 0 },
      registry_limit: { type: 'integer', minimum: 1, maximum: 200 },
    }, additionalProperties: false } },
  { name: 'store_delta', description: 'Événements du cycle après since_seq (au plus 50), masqués selon votre participant.',
    parameters: { type: 'object', properties: { since_seq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
      full: { type: 'boolean', description: 'Demander les événements complets si une preuve exacte est nécessaire (opt-in).' } },
      required: ['since_seq'], additionalProperties: false } },
  { name: 'github_list_directory', description: 'Explorer un dossier du dépôt GitHub autorisé, sans lire les fichiers : jusqu’à 80 entrées. Utiliser ref SHA de base pendant la préparation.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Dossier depuis la racine, chaîne vide pour racine.' }, ref: { type: 'string' } },
      required: ['path', 'ref'], additionalProperties: false } },
  { name: 'github_read_file', description: 'Lire un fichier texte du dépôt autorisé à une référence (branche ou SHA).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' } }, required: ['path', 'ref'], additionalProperties: false } },
  { name: 'github_pull_request', description: 'Lire une PR du dépôt autorisé (titre, état, head et base).',
    parameters: { type: 'object', properties: { number: { type: 'integer', minimum: 1 } }, required: ['number'], additionalProperties: false } },
  { name: 'github_check_runs', description: 'Contrôles CI d’un commit exact (SHA de 40 caractères) du dépôt autorisé.',
    parameters: { type: 'object', properties: { sha: { type: 'string' } }, required: ['sha'], additionalProperties: false } },
  { name: 'github_diff', description: 'Diff entre une base (SHA ou branche) et un head exact (SHA de 40 caractères) du dépôt autorisé : fichiers, statuts et patchs bornés.',
    parameters: { type: 'object', properties: { base: { type: 'string' }, head: { type: 'string', pattern: '^[a-f0-9]{40}$' } },
      required: ['base', 'head'], additionalProperties: false } },
]);

export type ReadToolName = 'store_context' | 'store_delta' | 'github_list_directory' | 'github_read_file' | 'github_pull_request' | 'github_check_runs' | 'github_diff';

/**
 * CC-7 L3 (incrément 1) : lectures de continuité, ajoutées à TOUS les types de tâche quand l'hôte est créé avec
 * `continuity: true` (porte AGENT_RUN_CONTINUITY, éteinte par défaut). Mêmes données que le chat (parité S1, S4) :
 * mémoire C4 visible du participant et « depuis ta dernière visite » (notes de passation, exécutions précédentes).
 */
export const CONTINUITY_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'store_memory', description: 'Mémoire C4 visible (personnelle et partagée). Lire page 0 puis next_page, sans perte des anciennes entrées.',
    parameters: { type: 'object', properties: { page: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false } },
  { name: 'store_continuity', description: 'Historique chat/API du même participant. Lire page 0 puis next_page pour accéder aux anciennes passations et exécutions.',
    parameters: { type: 'object', properties: { page: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
]);
export type ContinuityToolName = 'store_memory' | 'store_continuity';
const CONTINUITY_TOOLS: readonly ContinuityToolName[] = ['store_memory', 'store_continuity'];
export const CONTINUITY_MEMORY_LIMIT = 40;
/** Registre complet des tâches rendu par store_context en mode continuité (écarts E1-E3 de l8). */
export const REGISTRY_MAX_TASKS = 60;

/** Allowlist par type de tâche, figée en code ; un type inconnu n'a aucun outil. */
export const READ_TOOLS_BY_KIND: Readonly<Record<string, readonly ReadToolName[]>> = Object.freeze({
  research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  // 7c-2 : réponse à une question adressée (créée par le contrôleur, plan.ts).
  answer: ['store_context', 'store_delta'],
  planning: ['store_context', 'store_delta', 'github_read_file'],
  status: ['store_context', 'store_delta', 'github_check_runs'],
  // 7c-3 : implémentation sur la branche de l'agent (écritures GitHub de github-tools.ts).
  implement: ['store_context', 'store_delta', 'github_list_directory', 'github_read_file', 'github_pull_request', 'github_check_runs'],
  // CC-7 L5a (S9) : réveils de relecture et de test — lecture du couple head/base exact.
  review: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
  test: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
  // CC-7 L6b-2 : contribution de conception (proposition, critique, synthèse, vote) — lectures du store seulement.
  design: ['store_context', 'store_delta'],
});

const SHA_RE = /^[a-f0-9]{40}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * CC-7 L5b (S10) : journalise une lecture GitHub réussie de l'exécution dans
 * agent_run_reads (INSERT OR IGNORE, empreinte (run_id, tool, ref_sha)) — la
 * preuve de lecture au SHA exact exigée par store_verdict (contrôle ⑦).
 */
async function journalRead(db: D1Database, runId: string, tool: string, refSha: string): Promise<void> {
  const effectKey = await sha256Hex([runId, tool, refSha].join('\u001f'));
  await db.prepare("INSERT OR IGNORE INTO agent_run_reads (effect_key, run_id, tool, ref_sha, status, at) VALUES (?1, ?2, ?3, ?4, 'completed', ?5)")
    .bind(effectKey, runId, tool, refSha, Math.floor(Date.now() / 1000)).run();
}

export interface ReadToolHostOptions {
  db: D1Database;
  /** Unique dépôt lisible par l'exécution (ex. rfkevin/github-mcp) ; null = aucun outil GitHub. */
  repository: string | null;
  github: GitHubReads | null;
  /** 7c-2 : ajoute les écritures store de WRITE_TOOLS_BY_KIND (clarify, task.status non-verdict). Absent = lecture seule. */
  storeWrites?: boolean;
  /**
   * 7c-3 : écritures GitHub (type `implement` seulement) sur la branche API du participant ;
   * exigent aussi `repository`. Absent = aucune écriture GitHub.
   */
  githubWrites?: { writes: GitHubWrites; baseBranch: string; s7?: S7Options } | null;
  /** CC-7 L3 : lectures de continuité (store_memory, store_continuity) et registre complet dans store_context. Absent = inchangé. */
  continuity?: boolean;
  /** CC8 : opt-in. Contexte focalisé sur la tâche pour implement seulement; tout reste accessible via full:true. */
  contextCompaction?: boolean;
  /** CC-7 L5b (S10) : store_verdict (verdicts contrôlés serveur) pour les kinds review et test ; absent = aucun verdict. */
  verdicts?: boolean;
  /** CC-7 L6b : contrôles CI exigés par nom pour store_verdict (absent = tous les contrôles présents verts). */
  requiredChecks?: readonly string[];
  /** CC-7 L6b-2 : store_contribute (sorties de phase de conception, contrôlées serveur) pour le kind design ; absent = aucune. */
  contributions?: boolean;
  /** CC-7 L9b : store_choose_model (l'agent choisit son modèle et sa réflexion, dans sa liste) ; absent = aucun. */
  modelChoice?: PolicyEnv | null;
  /** CC-7 L11 : outils des chercheurs en tournante (web officiel, salon) pour le kind research ; absent = aucun. */
  research?: ResearchToolsOptions | null;
  /**
   * CC8 C2c : consommer le contrat unique C0 — chaque outil servi est borné par les
   * attestations serveur du run (runVerifiedClaims) AVANT tout effet. Absent = inchangé :
   * l'allowlist par kind et les gardes au point d'effet restent seules en vigueur.
   */
  unifiedCapabilities?: boolean;
}

export interface RunScope { cycle_id: string; participant_id: string; task_id: string; task_kind: string }

/**
 * CC8 C2c — capacité du contrat unique C0 exigée par chaque outil servi par ce runtime.
 * Les outils sans entrée C0 (web_fetch_official, store_choose_model) restent régis par
 * la seule allowlist par kind ; les outils d'écriture GitHub (S7 compris) exigent github.write.
 */
const TOOL_UNIFIED_CAPABILITY: Readonly<Record<string, UnifiedCapability>> = Object.freeze({
  store_context: 'cycle.read',
  store_delta: 'cycle.read',
  store_salon_read: 'cycle.read',
  store_memory: 'memory.read',
  store_continuity: 'memory.read',
  github_list_directory: 'github.read',
  github_read_file: 'github.read',
  github_pull_request: 'github.read',
  github_check_runs: 'github.read',
  github_diff: 'github.read',
  store_ask: 'question.ask',
  store_answer: 'question.answer',
  store_salon_post: 'salon.announce',
  store_task_status: 'task.status',
  store_handover: 'task.handover',
  store_memory_propose: 'memory.propose',
  store_memory_rewrite: 'memory.rewrite',
  store_verdict: 'review.verdict',
  store_contribute: 'design.contribute',
  web_fetch_official: 'web.read',
  store_choose_model: 'model.choose',
});
const GITHUB_WRITE_CAPABILITY_TOOLS: ReadonlySet<string> = new Set(
  [...GITHUB_WRITE_TOOL_SCHEMAS, ...S7_SCHEMAS].map(schema => schema.name));

/** Capacité C0 exigée pour servir cet outil, ou null si hors vocabulaire (allowlist seule). */
export function requiredUnifiedCapability(name: string): UnifiedCapability | null {
  return TOOL_UNIFIED_CAPABILITY[name] ?? (GITHUB_WRITE_CAPABILITY_TOOLS.has(name) ? 'github.write' : null);
}

/**
 * CC8 C2c — attestations serveur du run pour le contrat unique C0 : identité, cycle,
 * HALT (owner_flags), rôle et grant GitHub EXACT (statique/dynamique S7, R2)
 * relus dans D1 et dans la politique S7 de l'hôte.
 * Aucun argument du modèle n'entre ici ; l'allowlist par kind et les gardes au point
 * d'effet restent seules autorité (C0 : une capacité est un droit d'affichage, pas un permis).
 */
export async function runVerifiedClaims(db: D1Database, run: RunScope, options: ReadToolHostOptions): Promise<VerifiedCapabilityClaims> {
  const equivalents = [...new Set([run.participant_id, ...(await equivalentParticipantIds(db, run.participant_id))])];
  const registered = await db.prepare(
    'SELECT 1 FROM participants WHERE participant_id IN (' + equivalents.map((_, index) => '?' + (index + 1)).join(',')
      + ") AND status = 'active' LIMIT 1",
  ).bind(...equivalents).first();
  const cycle = await db.prepare('SELECT status FROM cycles WHERE cycle_id = ?1').bind(run.cycle_id).first<{ status: string }>();
  const halted = await db.prepare("SELECT 1 FROM owner_flags WHERE name = 'halt' AND value = '1'").first();
  const task = run.task_id
    ? await db.prepare('SELECT owner_pid, reviewer_pid, tester_pid, status, owned_paths FROM tasks WHERE cycle_id = ?1 AND task_id = ?2')
      .bind(run.cycle_id, run.task_id)
      .first<{ owner_pid: string; reviewer_pid: string; tester_pid: string; status: string; owned_paths: string }>()
    : null;
  const role: AssignedTaskRole = task
    ? (equivalents.includes(task.owner_pid) ? 'author'
      : equivalents.includes(task.reviewer_pid) ? 'reviewer'
      : equivalents.includes(task.tester_pid) ? 'tester' : 'none')
    : 'none';
  const held = role !== 'none';
  let cycleMember = held;
  if (!cycleMember) {
    const placeholders = (offset: number) => equivalents.map((_, index) => '?' + (offset + index)).join(',');
    const member = await db.prepare([
      'SELECT 1 FROM tasks WHERE cycle_id = ?1 AND (owner_pid IN (' + placeholders(2) + ')',
      ' OR reviewer_pid IN (' + placeholders(2 + equivalents.length) + ')',
      ' OR tester_pid IN (' + placeholders(2 + 2 * equivalents.length) + ')) LIMIT 1',
    ].join('')).bind(run.cycle_id, ...equivalents, ...equivalents, ...equivalents).first();
    cycleMember = member != null;
  }
  if (!cycleMember) {
    // R1 (contre-revue Claude, cc8 seq 2132) : un run sans tâche (réponse adressée
    // X13) prouve sa relation au cycle par la question qui lui est ADRESSÉE dans
    // le journal — jamais en fabriquant une tâche. L'EXISTENCE (question répondue
    // ou non) évite de perdre la relation en plein run quand store_answer ferme la
    // question ; un adressage par rôle ($.to = owner/reviewer/tester) suppose une
    // tâche, déjà couverte par la requête de rôles ci-dessus. Payload illisible :
    // fail-closed, aucun élargissement.
    try {
      const addressed = await db.prepare([
        "SELECT 1 FROM events WHERE cycle_id = ?1 AND type = 'clarify.ask'",
        "AND json_extract(payload_json, '$.to') IN (" + equivalents.map((_, index) => '?' + (index + 2)).join(',') + ')',
        'LIMIT 1',
      ].join(' ')).bind(run.cycle_id, ...equivalents).first();
      cycleMember = addressed != null;
    } catch {
      cycleMember = false;
    }
  }
  let ownedPaths: string[] = [];
  try {
    const parsed: unknown = task ? JSON.parse(task.owned_paths) : null;
    if (Array.isArray(parsed)) ownedPaths = parsed.filter((path): path is string => typeof path === 'string' && path.length > 0);
  } catch {
    // owned_paths illisible : mandat vide, github.write refusé (fail-closed C0).
  }
  // R2 (contre-revue Claude, cc8 seq 2132) : l'attestation github.write est le
  // grant EXACT statique/dynamique S7 (exactGrant) que la garde au point d'effet
  // revalide à chaque écriture — jamais la seule configuration de l'hôte. Le
  // mandat de la tâche (owned_paths) reste exigé car assertPaths borne chaque
  // effet au couple grant ∩ owned_paths ; hôte sans politique S7, ambiguïté de
  // politique, tâche inactive ou mandat vide : fail-closed.
  let githubWriteGrant: VerifiedCapabilityClaims['github_write_grant'];
  if (options.githubWrites != null && options.repository !== null) {
    const s7 = options.githubWrites.s7 ?? null;
    const writers = (s7?.policy.writers ?? '').split(',').map(part => part.trim()).filter(Boolean);
    let grant: WriteGrant | null = null;
    if (run.task_id && s7 && writers.includes(run.participant_id)) {
      try {
        grant = await exactGrant(options.db, s7.policy, run.cycle_id, run.task_id, run.participant_id);
      } catch {
        grant = null; // api_task_grant_ambiguous / politique invalide : fail-closed.
      }
    }
    githubWriteGrant = {
      valid: grant != null && ownedPaths.length > 0 && task?.status === 'in_progress',
      branch: grant?.branch ?? API_BRANCH_NAMESPACE,
      paths: grant?.paths ?? [],
    };
  }
  return {
    participant_registered: registered != null,
    cycle_member: cycleMember,
    cycle_open: cycle?.status === 'open',
    halted: halted != null,
    task_role: role,
    task_assignment_verified: held,
    github_read_granted: options.repository !== null && options.github !== null,
    memory_read_scoped: options.continuity === true,
    question_answer_authorized: options.storeWrites === true,
    memory_propose_scoped: options.storeWrites === true && options.continuity === true,
    memory_rewrite_scoped: options.storeWrites === true && options.continuity === true,
    design_contribution_authorized: options.contributions === true,
    verdict_sha_pair_verified: options.verdicts === true && options.repository !== null && options.github !== null
      && (role === 'reviewer' || role === 'tester'),
    web_read_granted: options.research?.researchEnabled === true,
    model_choose_granted: options.modelChoice != null,
    // Mandat d'affichage : le grant EXACT statique/dynamique S7 relu ci-dessus ;
    // la branche exacte et les chemins restent gardés À CHAQUE EFFET par les
    // outils S7 (authorize + assertPaths) et les mandats de complétion.
    github_write_grant: githubWriteGrant,
  };
}

function intArg(args: Record<string, unknown>, name: string, min: number, max: number, fallback?: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolRefused(name + ' : entier entre ' + min + ' et ' + max + ' requis.');
  }
  return value;
}

function stringArg(args: Record<string, unknown>, name: string, pattern: RegExp): string {
  const value = args[name];
  if (typeof value !== 'string' || !pattern.test(value)) throw new ToolRefused(name + ' invalide.');
  return value;
}

export function createReadToolHost(options: ReadToolHostOptions): ToolHost & { schemas(taskKind: string): ToolSchema[] } {
  const writes = options.storeWrites ? createStoreWriteTools(options.db) : null;
  const ghOptions = options.githubWrites && options.repository !== null
    ? { db: options.db, repository: options.repository, writes: options.githubWrites.writes, baseBranch: options.githubWrites.baseBranch } : null;
  const gh = ghOptions ? (options.githubWrites?.s7 ? createS7Tools(ghOptions, options.githubWrites.s7) : createGitHubWriteTools(ghOptions)) : null;
  const ghSchemas = options.githubWrites?.s7 ? [...GITHUB_WRITE_TOOL_SCHEMAS, ...S7_SCHEMAS] : GITHUB_WRITE_TOOL_SCHEMAS;
  // CC-7 L5b (S10) : store_verdict, seulement avec un dépôt ET des lectures GitHub.
  const verdicts = options.verdicts && options.repository !== null && options.github !== null
    ? createVerdictTools({ db: options.db, repository: options.repository, github: options.github, requiredChecks: options.requiredChecks })
    : null;
  // CC-7 L6b-2 : contributions de conception, seulement pour le kind design.
  const contributions = options.contributions ? createContributionTools(options.db) : null;
  // CC-7 L9b : choix de modèle par l'agent lui-même, pour tout type de tâche connu.
  const modelChoice = options.modelChoice ? createModelChoiceTools(options.db, options.modelChoice) : null;
  // CC-7 L11 : lecture web officielle et salon (journal partagé), seulement pour le kind research.
  const research = options.research ? createResearchTools(options.db, {
    ...options.research, unifiedCapabilities: options.unifiedCapabilities === true,
  }) : null;
  // Unified WorkSession tools depend on the host resources and actual C0
  // claims, not on API vs chat or a legacy kind string. Claims are checked
  // again at every effect. Legacy callers keep the old lists until migrated.
  const unified = options.unifiedCapabilities === true;
  const memoryWrite = (kind: string): readonly WriteToolName[] =>
    writes && options.continuity && (unified || Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, kind))
      ? ['store_memory_propose', 'store_memory_rewrite', 'store_handover'] : [];
  const writeNames = (kind: string): readonly string[] =>
    [...(writes ? (unified ? WRITE_TOOL_SCHEMAS.map(schema => schema.name) : writes.names(kind)) : []),
      ...memoryWrite(kind),
      ...(gh ? (unified ? ghSchemas.filter(schema => !options.githubWrites?.s7 || options.githubWrites.s7.checks
        || !['github_run_checks', 'github_check_result'].includes(schema.name)).map(schema => schema.name) : gh.names(kind)) : []),
      ...(verdicts && (unified || kind === 'review' || kind === 'test') ? ['store_verdict' as const] : []),
      ...(contributions && (unified || kind === CONTRIBUTION_TASK_KIND) ? ['store_contribute' as const] : []),
      ...(modelChoice && (unified || Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, kind)) ? ['store_choose_model' as const] : []),
      ...(research ? research.writes(kind) : [])];
  const isGitHubWrite = (name: string) => ghSchemas.some(schema => schema.name === name);
  const allowed = (kind: string): readonly ReadToolName[] => {
    const candidate = unified ? READ_TOOL_SCHEMAS.map(schema => schema.name as ReadToolName)
      : Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, kind) ? READ_TOOLS_BY_KIND[kind] : [];
    return candidate.filter(name => !name.startsWith('github_') || (options.repository !== null && options.github !== null
      && (name !== 'github_list_directory' || !!options.github.listDirectory)));
  };
  const continuityNames = (kind: string): readonly ContinuityToolName[] =>
    options.continuity && (unified || Object.prototype.hasOwnProperty.call(READ_TOOLS_BY_KIND, kind)) ? CONTINUITY_TOOLS : [];
  const readNames = (kind: string): readonly string[] =>
    [...allowed(kind), ...continuityNames(kind), ...(research ? research.reads(kind) : [])];
  async function scope(runId: string): Promise<RunScope> {
    const run = await options.db.prepare('SELECT cycle_id, participant_id, task_id, task_kind FROM agent_runs WHERE run_id = ?1').bind(runId).first<RunScope>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function execute(call: ToolCall, ctx: { run_id: string; effect_key?: string; prefetch?: boolean }): Promise<unknown> {
    // CC8 C2c : le run est relu AVANT tout effet ; quand l'hôte consomme le contrat
    // unique C0, chaque outil exige sa capacité vérifiée — l'allowlist par kind et les
    // gardes au point d'effet restent inchangés (refus typé, jamais d'élargissement).
    const runScope = await scope(ctx.run_id);
    if (unified) {
      const required = requiredUnifiedCapability(call.name);
      if (required && !hasUnifiedCapability(await runVerifiedClaims(options.db, runScope, options), required)) {
        throw new ToolRefused('capability_not_held:' + required);
      }
      if (![...readNames(runScope.task_kind), ...writeNames(runScope.task_kind)].includes(call.name)) {
        throw new ToolRefused('tool_not_configured');
      }
    }
    if (writes && (WRITE_TOOL_SCHEMAS.some(schema => schema.name === call.name))) return writes.execute(call, ctx);
    if (gh && isGitHubWrite(call.name)) return gh.execute(call, ctx);
    // CC-7 L5b (S10) : verdict contrôlé serveur (rôle, identité, couple, CI, preuve).
    if (verdicts && call.name === 'store_verdict') return verdicts.execute(call, ctx);
    // CC-7 L6b-2 : contribution de conception contrôlée serveur (phase courante, titulaire manquant).
    if (contributions && call.name === 'store_contribute') return contributions.execute(call, ctx);
    if (modelChoice && call.name === 'store_choose_model') return modelChoice.execute(call, ctx);
    if (research && RESEARCH_TOOL_SCHEMAS.some(schema => schema.name === call.name)) return research.execute(call, ctx);
    const { cycle_id, participant_id, task_id, task_kind } = runScope;
    const args = call.args ?? {};
    const store = new CollabStore(options.db);
    switch (call.name as ReadToolName) {
      case 'store_context': {
        const mine = await store.getContext(cycle_id, participant_id);
        // Same durable active_work source consumed by the chat MCP context.
        // Transport-specific API task_kind never controls what history exists.
        const ids = options.continuity ? await equivalentParticipantIds(options.db, participant_id) : null;
        const activeWork = ids ? await loadActiveWork(options.db, cycle_id, ids) : null;
        const shared = activeWork ? { active_work: activeWork } : {};
        if (options.contextCompaction && !unified && task_kind === 'implement' && task_id && args.full !== true && args.registry_page === undefined) {
          const current = mine.tasks.find(task => task.task_id === task_id);
          if (!current) throw new ToolRefused('api_task_context_not_visible');
          const last = await options.db.prepare('SELECT MAX(seq) AS latest FROM events WHERE cycle_id = ?1')
            .bind(cycle_id).first<{ latest: number | null }>();
          const latestSeq = last?.latest ?? 0;
          return { cycle_id, phase: mine.phase, status: mine.status, revision: mine.revision,
            task: current, scope: 'task-first', latest_seq: latestSeq, ...shared,
            recent_since_seq: Math.max(0, latestSeq - 50),
            note: 'Lire store_delta avec since_seq=recent_since_seq puis next_since_seq ; full:true pour les preuves exactes.' };
        }
        if (!options.continuity) return mine;
        // Every registry entry is reachable by page; no total-count truncation.
        const page = intArg(args, 'registry_page', 0, 1_000_000, 0);
        const limit = intArg(args, 'registry_limit', 1, 200, REGISTRY_MAX_TASKS);
        const offset = page * limit;
        const all = await store.getContext(cycle_id);
        const rows = all.tasks.slice(offset, offset + limit);
        const registry = rows.map(task => ({ task_id: task.task_id, status: task.status,
          owner: task.owner_pid, reviewer: task.reviewer_pid, tester: task.tester_pid, next_action: String(task.next_action ?? '').slice(0, 300) }));
        const hasMore = all.tasks.length > offset + rows.length;
        return { ...mine, ...shared, registry, registry_truncated: hasMore,
          registry_page: page, registry_next_page: hasMore ? page + 1 : null, registry_total: all.tasks.length };
      }
      case 'store_delta': {
        const since = intArg(args, 'since_seq', 0, Number.MAX_SAFE_INTEGER);
        const limit = intArg(args, 'limit', 1, 50, 50);
        const { events, hasMore } = await store.getDelta(cycle_id, since, limit, participant_id);
        if (options.contextCompaction && task_kind === 'implement' && task_id && args.full !== true) {
          const globalKinds = new Set(['owner.decision', 'owner.request', 'round.add', 'phase.advance', 'phase.adjust']);
          const filtered = events.filter(event => globalKinds.has(event.type) || event.payload_json.includes(task_id));
          return { has_more: hasMore, next_since_seq: events.length ? events[events.length - 1].seq : since,
            filtered_for: task_id, omitted_in_page: events.length - filtered.length,
            events: filtered.map(event => ({ seq: event.seq, type: event.type, participant_id: event.participant_id,
              payload: event.payload_json.length <= 1400 ? event.payload_json
                : JSON.stringify({ truncated: true, preview: event.payload_json.slice(0, 1100) }) })) };
        }
        return { has_more: hasMore, events: events.map(event => ({ seq: event.seq, type: event.type, participant_id: event.participant_id, payload: event.payload_json })) };
      }
      case 'github_list_directory': {
        const path = stringArg(args, 'path', /^[^\0]{0,300}$/);
        const ref = stringArg(args, 'ref', REF_RE);
        if (!options.github?.listDirectory) throw new ToolRefused('github_list_directory_unavailable');
        const entries = await options.github.listDirectory(options.repository!, path, ref);
        await journalRead(options.db, ctx.run_id, 'github_list_directory', SHA_RE.test(ref) ? ref : '');
        return { path, ref, entries: entries.slice(0, 80), truncated: entries.length > 80 };
      }
      case 'github_read_file': {
        const path = stringArg(args, 'path', /^[^\0]{1,400}$/);
        const ref = stringArg(args, 'ref', REF_RE);
        const file = await options.github!.getTextFile(options.repository!, path, ref);
        await journalRead(options.db, ctx.run_id, 'github_read_file', SHA_RE.test(ref) ? ref : '');
        return { path: file.path, sha: file.sha, size: file.size, content: file.content };
      }
      case 'github_pull_request': {
        const number = intArg(args, 'number', 1, 10_000_000);
        const pr = await options.github!.getPullRequest(options.repository!, number) as Record<string, unknown>;
        await journalRead(options.db, ctx.run_id, 'github_pull_request', '');
        const head = (pr.head ?? {}) as Record<string, unknown>;
        const base = (pr.base ?? {}) as Record<string, unknown>;
        return { number: pr.number, title: pr.title, state: pr.state, draft: pr.draft, merged: pr.merged,
          head: { ref: head.ref, sha: head.sha }, base: { ref: base.ref, sha: base.sha } };
      }
      case 'github_check_runs': {
        const sha = stringArg(args, 'sha', SHA_RE);
        const runs = await options.github!.listCheckRuns(options.repository!, sha) as Array<Record<string, unknown>>;
        await journalRead(options.db, ctx.run_id, 'github_check_runs', sha);
        return runs.slice(0, 50).map(run => ({ name: run.name, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha }));
      }
      case 'github_diff': {
        const head = stringArg(args, 'head', SHA_RE);
        const base = stringArg(args, 'base', REF_RE);
        const comparison = await options.github!.compareRefs(options.repository!, base, head) as Record<string, unknown>;
        // CC8 S7 vérification guidée (relecture GPT-6 #286, V1) : la prélecture serveur est journalisée à part ;
        // elle ne vaut preuve d'un verdict positif que si le contexte injecté couvre tout le diff (verify-guided.ts).
        // V1b : la preuve porte sur le COUPLE lu (head:base), jamais sur le head seul (diffReadRef).
        await journalRead(options.db, ctx.run_id, ctx.prefetch === true ? 'github_diff_prefetch' : 'github_diff', diffReadRef(head, base));
        const raw = Array.isArray(comparison.files) ? comparison.files as Array<Record<string, unknown>> : [];
        // L5a : le diff est borné avant d'entrer dans le contexte du modèle (données, jamais instructions).
        const files = raw.slice(0, DIFF_MAX_FILES).map(file => {
          const patch = typeof file.patch === 'string' ? file.patch : '';
          return { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions,
            patch: patch.slice(0, DIFF_PATCH_CHARS), patch_truncated: patch.length > DIFF_PATCH_CHARS };
        });
        return { base, head, status: comparison.status, ahead_by: comparison.ahead_by, behind_by: comparison.behind_by,
          total_commits: comparison.total_commits, files, files_truncated: raw.length > DIFF_MAX_FILES };
      }
      default:
        break;
    }
    if (options.continuity && (CONTINUITY_TOOLS as readonly string[]).includes(call.name)) {
      const ids = await equivalentParticipantIds(options.db, participant_id);
      if (call.name === 'store_continuity') {
        const page = intArg(args, 'page', 0, 1_000_000, 0);
        const limit = intArg(args, 'limit', 1, 100, 5);
        return loadContinuity(options.db, cycle_id, ids, { page, pageSize: limit });
      }
      const cycle = await options.db.prepare('SELECT project FROM cycles WHERE cycle_id = ?1').bind(cycle_id).first<{ project: string | null }>();
      // CC-7 M2 : parité chat/API — l'exécution voit aussi la mémoire du rôle qu'elle tient (type d'exécution)
      // et role:coordinator si l'agent détient le mandat de coordination du cycle.
      const run = await options.db.prepare('SELECT task_id, task_kind FROM agent_runs WHERE run_id = ?1')
        .bind(ctx.run_id).first<{ task_id: string; task_kind: string }>();
      const identities = new Set(ids);
      const roles = await memoryRolesOf(options.db, cycle_id, identities, runRoles(run?.task_kind ?? ''));
      const memory = await loadVisibleActiveMemory(options.db, { participantId: participant_id, participantIds: identities, roles,
        taskId: run?.task_id || null, project: cycle?.project ?? null });
      const page = intArg(args, 'page', 0, 1_000_000, 0);
      const limit = intArg(args, 'limit', 1, 200, CONTINUITY_MEMORY_LIMIT);
      const offset = page * limit;
      const entries = memory.slice(offset, offset + limit);
      const hasMore = memory.length > offset + entries.length;
      return { entries, truncated: hasMore, next_page: hasMore ? page + 1 : null, page, total_visible: memory.length };
    }
    throw new ToolRefused('tool_not_allowlisted');
  }
  return {
    spec(taskKind: string, name: string): ToolSpec | null {
      if (readNames(taskKind).includes(name)) return { name, effect: 'read' };
      if ((writeNames(taskKind) as readonly string[]).includes(name)) return { name, effect: 'write' };
      return null;
    },
    list(taskKind: string): string[] {
      return [...readNames(taskKind), ...writeNames(taskKind)];
    },
    schemas(taskKind: string): ToolSchema[] {
      const names = new Set<string>([...readNames(taskKind), ...writeNames(taskKind)]);
      return [...READ_TOOL_SCHEMAS, ...CONTINUITY_TOOL_SCHEMAS, ...WRITE_TOOL_SCHEMAS, ...ghSchemas, ...VERDICT_TOOL_SCHEMAS, ...CONTRIBUTION_TOOL_SCHEMAS, ...MODEL_CHOICE_TOOL_SCHEMAS, ...RESEARCH_TOOL_SCHEMAS].filter(schema => names.has(schema.name));
    },
    execute,
    // Contrat d'hôte 7a : un outil d'écriture sans lookup serait refusé ; les écritures store en ont un.
    async lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult> {
      if (verdicts && call.name === 'store_verdict') return verdicts.lookup(call, ctx);
      if (contributions && call.name === 'store_contribute') return contributions.lookup(call, ctx);
      if (modelChoice && call.name === 'store_choose_model') return modelChoice.lookup(call, ctx);
      if (research && call.name === 'store_salon_post') return research.lookup(call, ctx);
      if (gh && isGitHubWrite(call.name)) return gh.lookup(call, ctx);
      return writes ? writes.lookup(call, ctx) : null;
    },
  };
}

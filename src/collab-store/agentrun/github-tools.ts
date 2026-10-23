/**
 * CC-5 l7 (incrément 7c-3) — écritures GitHub des exécutions API, sur la branche de l'agent.
 *
 * Plan de clôture v1.1, amendement A3 : une exécution API n'écrit que sur SA branche
 * `mcp/105856986/<participant>-api-<nom>` (préfixe construit ici depuis le participant
 * de agent_runs, jamais pris dans les arguments du modèle) ; expectedHeadSha obligatoire
 * pour tout commit ; une PR ouverte par un agent API est TOUJOURS un brouillon vers la
 * branche de base fixée par l'hôte ; aucun outil de fusion, d'approbation ni de
 * résolution de conflit n'existe pour ce canal : un conflit est un échec propre.
 *
 * Le store n'importe jamais le client GitHub (invariant CC-3 C6) : la racine du Worker
 * injecte `GitHubWrites` (src/agent-run-object.ts) et traduit les refus certains du
 * client (conflit, politique, validation) en `GitHubWriteRefused`. Toute autre erreur
 * reste incertaine : le moteur marque l'effet ambiguous et appelle `lookup`.
 *
 * Contrat d'hôte 7a : chaque effet porte une empreinte dérivée de la clé d'effet du
 * moteur — nom de branche pour la création, trailer `Agent-Effect:` dans le message
 * de commit, branche de tête pour la PR — et `lookup` la recherche avant tout réessai.
 */
import { ToolRefused, type LookupResult, type ToolCall } from './engine';
import type { ToolSchema } from './workers-ai-model';

/** Écritures GitHub fournies par la racine du Worker (jeton contents + pull_requests en écriture). */
export interface GitHubWrites {
  /** SHA de tête de la branche, ou null si elle n'existe pas. */
  branchHead(repository: string, branch: string): Promise<string | null>;
  createBranch(repository: string, branch: string, baseBranch: string, expectedBaseSha: string): Promise<{ sha: string }>;
  commitFiles(repository: string, branch: string, expectedHeadSha: string, message: string,
    files: Array<{ path: string; content: string; expectedSha?: string }>): Promise<{ commit_sha: string }>;
  /** Derniers commits de la branche (plus récent d'abord), message complet. */
  recentCommits(repository: string, branch: string, limit: number): Promise<Array<{ sha: string; message: string }>>;
  openDraftPullRequest(repository: string, branch: string, baseBranch: string, title: string, body: string): Promise<{ number: number; head_sha: string }>;
  /** PR (tout état) dont la tête est cette branche, ou null. */
  findPullRequest(repository: string, branch: string): Promise<{ number: number; head_sha: string } | null>;
}

/** Refus certain du client GitHub (rien n'a été écrit) ; levé par l'adaptateur de la racine. */
export class GitHubWriteRefused extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'GitHubWriteRefused';
  }
}

export type GitHubWriteToolName = 'github_create_branch' | 'github_commit_files' | 'github_open_draft_pr';

/** Espace de noms des branches API, figé en code (A3). */
export const API_BRANCH_NAMESPACE = 'mcp/105856986';
export const DEFAULT_API_BASE_BRANCH = 'mcp/105856986/cc3-integration';
export const MAX_COMMIT_FILES = 20;
export const MAX_FILE_CHARS = 100_000;
export const MAX_COMMIT_CHARS = 400_000;
const SHA_RE = /^[a-f0-9]{40}$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const PARTICIPANT_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
/** Même règle que la politique du client : un segment de branche fait au plus 49 caractères. */
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/;
const BASE_RE = /^[A-Za-z0-9._/-]{1,200}$/;
/**
 * Chemins jamais écrits par un agent API, en plus des chemins protégés du client
 * (.github, scripts/ci, scripts/deploy, .mcp) : journaux en ajout seul, configuration
 * de déploiement (interrupteurs d'activation) et migrations.
 */
const FORBIDDEN_PATH_RE = /^(?:AGENT_MEMORY\.md|TOOL_IMPROVEMENTS\.md|wrangler\.(?:jsonc?|toml)|\.github(?:\/|$)|scripts(?:\/|$)|\.mcp(?:\/|$)|migrations(?:\/|$))/i;

export const GITHUB_WRITE_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  { name: 'github_create_branch', description: 'Créer VOTRE branche de travail mcp/105856986/<participant>-api-<name> depuis la branche de base de l’hôte, au SHA de base lu (base_sha).',
    parameters: { type: 'object', properties: { name: { type: 'string', pattern: NAME_RE.source }, base_sha: { type: 'string', pattern: SHA_RE.source } },
      required: ['name', 'base_sha'], additionalProperties: false } },
  { name: 'github_commit_files', description: 'Un commit sur VOTRE branche <name> : expected_head_sha obligatoire (tête lue), fichiers complets ; expected_sha requis pour modifier un fichier existant. Conflit = échec, jamais de résolution.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', pattern: NAME_RE.source }, expected_head_sha: { type: 'string', pattern: SHA_RE.source },
      message: { type: 'string', maxLength: 120 },
      files: { type: 'array', minItems: 1, maxItems: MAX_COMMIT_FILES, items: { type: 'object', properties: {
        path: { type: 'string' }, content: { type: 'string', maxLength: MAX_FILE_CHARS }, expected_sha: { type: 'string', pattern: SHA_RE.source } },
        required: ['path', 'content'], additionalProperties: false } },
    }, required: ['name', 'expected_head_sha', 'message', 'files'], additionalProperties: false } },
  { name: 'github_open_draft_pr', description: 'Ouvrir une PR BROUILLON de VOTRE branche <name> vers la branche de base de l’hôte. Jamais de fusion.',
    parameters: { type: 'object', properties: { name: { type: 'string', pattern: NAME_RE.source }, title: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 8000 } }, required: ['name', 'title'], additionalProperties: false } },
]);

/** Écritures GitHub par type de tâche, figées en code ; seul `implement` écrit sur GitHub. */
export const GITHUB_WRITE_TOOLS_BY_KIND: Readonly<Record<string, readonly GitHubWriteToolName[]>> = Object.freeze({
  implement: ['github_create_branch', 'github_commit_files', 'github_open_draft_pr'],
});

/** Branche API d'un participant ; refus si le participant ou le nom ne tient pas dans la politique de branches. */
export function apiBranch(participantId: string, name: unknown): string {
  if (!PARTICIPANT_RE.test(participantId)) throw new ToolRefused('participant_not_branch_safe');
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new ToolRefused('name : [a-z0-9-], 1 à 32 caractères.');
  const segment = participantId + '-api-' + name;
  if (!SEGMENT_RE.test(segment)) throw new ToolRefused('branch_name_too_long');
  return API_BRANCH_NAMESPACE + '/' + segment;
}

/** Trailer d'effet ajouté au message de commit (empreinte d'intention, jamais un UUID). */
export function effectTrailer(effectKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(effectKey)) throw new ToolRefused('effect_key_invalid');
  return 'Agent-Effect: ' + effectKey.slice(0, 32);
}

function sha(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new ToolRefused(name + ' : SHA de 40 caractères requis.');
  return value;
}

function line(args: Record<string, unknown>, name: string, max: number): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) {
    throw new ToolRefused(name + ' : une ligne de 1 à ' + max + ' caractères requise.');
  }
  return value.trim();
}

function files(args: Record<string, unknown>): Array<{ path: string; content: string; expectedSha?: string }> {
  const raw = args.files;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_COMMIT_FILES) throw new ToolRefused('files : 1 à ' + MAX_COMMIT_FILES + ' fichiers.');
  const seen = new Set<string>();
  let total = 0;
  return raw.map(entry => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const path = item.path;
    const content = item.content;
    if (typeof path !== 'string' || !path || path.length > 400 || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new ToolRefused('path invalide.');
    }
    if (FORBIDDEN_PATH_RE.test(path)) throw new ToolRefused('path_forbidden_on_api_channel');
    if (seen.has(path)) throw new ToolRefused('path en double.');
    seen.add(path);
    if (typeof content !== 'string' || content.length > MAX_FILE_CHARS) throw new ToolRefused('content : texte de ' + MAX_FILE_CHARS + ' caractères au plus.');
    total += content.length;
    if (total > MAX_COMMIT_CHARS) throw new ToolRefused('commit_too_large');
    const expected = item.expected_sha;
    if (expected !== undefined && (typeof expected !== 'string' || !SHA_RE.test(expected))) throw new ToolRefused('expected_sha invalide.');
    return { path, content, ...(expected ? { expectedSha: expected } : {}) };
  });
}

export interface GitHubWriteToolsOptions {
  db: D1Database;
  repository: string;
  writes: GitHubWrites;
  /** Branche cible des PR brouillons et base des branches créées ; jamais main ni master. */
  baseBranch: string;
}

export interface GitHubWriteTools {
  names(taskKind: string): readonly GitHubWriteToolName[];
  execute(call: ToolCall, ctx: { run_id: string; effect_key?: string }): Promise<unknown>;
  lookup(call: ToolCall, ctx: { run_id: string; effect_key: string }): Promise<LookupResult>;
}

export function createGitHubWriteTools(options: GitHubWriteToolsOptions): GitHubWriteTools {
  const base = options.baseBranch;
  if (!BASE_RE.test(base) || /^(?:main|master)$/i.test(base) || base.includes('..')) throw new Error('baseBranch invalide pour le canal API.');
  async function scope(runId: string): Promise<{ participant_id: string }> {
    const run = await options.db.prepare('SELECT participant_id FROM agent_runs WHERE run_id = ?1').bind(runId).first<{ participant_id: string }>();
    if (!run) throw new ToolRefused('unknown_run');
    return run;
  }
  async function refusedOnCertain<T>(effect: () => Promise<T>): Promise<T> {
    try {
      return await effect();
    } catch (error) {
      // Refus certain (conflit, politique, validation) : rien n'a été écrit. Le reste est incertain.
      if (error instanceof GitHubWriteRefused) throw new ToolRefused(error.code);
      throw error;
    }
  }
  return {
    names(taskKind) {
      return Object.prototype.hasOwnProperty.call(GITHUB_WRITE_TOOLS_BY_KIND, taskKind) ? GITHUB_WRITE_TOOLS_BY_KIND[taskKind] : [];
    },
    async execute(call, ctx) {
      if (!ctx.effect_key) throw new ToolRefused('effect_key_required');
      const trailer = effectTrailer(ctx.effect_key);
      const { participant_id } = await scope(ctx.run_id);
      const args = call.args ?? {};
      const branch = apiBranch(participant_id, args.name);
      switch (call.name as GitHubWriteToolName) {
        case 'github_create_branch': {
          const baseSha = sha(args, 'base_sha');
          const created = await refusedOnCertain(() => options.writes.createBranch(options.repository, branch, base, baseSha));
          return { branch, sha: created.sha, base };
        }
        case 'github_commit_files': {
          const head = sha(args, 'expected_head_sha');
          const message = line(args, 'message', 120) + '\n\n' + trailer;
          const changes = files(args);
          const commit = await refusedOnCertain(() => options.writes.commitFiles(options.repository, branch, head, message, changes));
          return { branch, commit_sha: commit.commit_sha, files: changes.map(change => change.path) };
        }
        case 'github_open_draft_pr': {
          const title = line(args, 'title', 200);
          const bodyArg = args.body;
          if (bodyArg !== undefined && (typeof bodyArg !== 'string' || bodyArg.length > 8000)) throw new ToolRefused('body : 8000 caractères au plus.');
          const body = (typeof bodyArg === 'string' ? bodyArg + '\n\n' : '')
            + '---\nPR brouillon ouverte par une exécution API (participant ' + participant_id + ', exécution ' + ctx.run_id + ').\n'
            + 'Aucune fusion par le canal API : revue et test D12 par d’autres familles, fusion par le propriétaire.\n' + trailer;
          const pr = await refusedOnCertain(() => options.writes.openDraftPullRequest(options.repository, branch, base, title, body));
          return { branch, number: pr.number, head_sha: pr.head_sha, draft: true, base };
        }
        default:
          throw new ToolRefused('tool_not_allowlisted');
      }
    },
    async lookup(call, ctx) {
      const { participant_id } = await scope(ctx.run_id);
      const branch = apiBranch(participant_id, (call.args ?? {}).name);
      switch (call.name as GitHubWriteToolName) {
        case 'github_create_branch': {
          const head = await options.writes.branchHead(options.repository, branch);
          return head ? { found: true, result: { branch, sha: head, base, status: 'duplicate' } } : { found: false };
        }
        case 'github_commit_files': {
          const head = await options.writes.branchHead(options.repository, branch);
          // Sans branche, aucun commit n'a pu avancer sa tête.
          if (!head) return { found: false };
          const trailer = effectTrailer(ctx.effect_key);
          const expected = sha(call.args ?? {}, 'expected_head_sha');
          // Le commit de l'effet, s'il existe, a pour parent expected_head_sha : on remonte depuis la tête
          // jusqu'à ce SHA. Trailer trouvé avant = écrit ; SHA atteint sans trailer = pas écrit ;
          // SHA hors de la fenêtre lue = incertain (le moteur passe en needs_reconcile).
          const commits = await options.writes.recentCommits(options.repository, branch, 30);
          for (const commit of commits) {
            if (commit.sha === expected) return { found: false };
            if (commit.message.split('\n').some(row => row.trim() === trailer)) {
              return { found: true, result: { branch, commit_sha: commit.sha, status: 'duplicate' } };
            }
          }
          return null;
        }
        case 'github_open_draft_pr': {
          const pr = await options.writes.findPullRequest(options.repository, branch);
          return pr ? { found: true, result: { branch, number: pr.number, head_sha: pr.head_sha, draft: true, base, status: 'duplicate' } } : { found: false };
        }
        default:
          return null;
      }
    },
  };
}

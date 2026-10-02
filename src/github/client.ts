import { assertWritableBranch, PolicyViolationError, type SecurityPolicy } from '../security/policy';
import { InputValidationError, type GitHubClientOptions } from './types';
import { GitHubFiles, SENSITIVE_FILE } from './files';
import { GitHubRepositories } from './repositories';
import { GitHubBranches } from './branches';
import { GitHubChanges } from './changes';
import { GitHubMerges } from './merges';
import { GitHubPullRequests } from './pull-requests';
import { GitHubAuthenticator } from './auth';
import { GitHubHttp } from './http';
import { GitHubIssues } from './issues';
import { GitHubActions } from './actions';
import { GitHubCommits } from './commits';
import { GitHubReleases } from './releases';
import type { GitHubServiceContext } from './service-context';

export {
  GitHubApiError,
  GitHubConflictError,
  GitHubRateLimitError,
} from './types';
export type {
  ApplyChangeSetOptions,
  AppliedChangeSet,
  GitHubBranch,
  GitHubCheckRun,
  GitHubClientOptions,
  GitHubComment,
  GitHubCombinedStatus,
  GitHubCommit,
  GitHubComparison,
  GitHubIssue,
  GitHubJob,
  GitHubLabel,
  GitHubPullRequest,
  GitHubRateLimit,
  GitHubRelease,
  GitHubRepository,
  GitHubReview,
  GitHubReviewComment,
  GitHubSearchCodeItem,
  GitHubWorkflow,
  GitHubWorkflowRun,
  MergeMethod,
  ReviewEvent,
  ReviewLineComment,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Constantes                                                                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------- */
/*  Utilitaires purs                                                           */
/* -------------------------------------------------------------------------- */

const encodeSegment = (value: string): string => encodeURIComponent(value);

const encodeSlashPath = (value: string): string =>
  value.split('/').map(encodeSegment).join('/');

function splitRepository(repository: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);

  if (!match) {
    throw new InputValidationError('Format de dépôt invalide. Utilise owner/repository.');
  }

  return { owner: match[1], name: match[2] };
}

function withQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  if (!query) {
    return path;
  }

  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InputValidationError(`${label} invalide.`);
  }
}

function assertGitRef(name: string, label = 'branche'): void {
  if (/[~^]/.test(name)) {
    throw new InputValidationError(
      'Expressions Git relatives (~ et ^) non prises en charge. Utilisez un nom de branche, un tag ou le SHA du commit souhaité (le SHA du parent pour master~1).',
      'UNSUPPORTED_REF_EXPRESSION',
    );
  }
  const hasControlCharacter = [...name].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || code === 0x7f;
  });

  if (
    !name ||
    name.length > 240 ||
    hasControlCharacter ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('//') ||
    name.includes('..') ||
    name.includes('@{') ||
    name === '@' ||
    /[\\~^:?*[\]%]/.test(name)
  ) {
    throw new InputValidationError(`Nom de ${label} invalide.`);
  }
}

function assertReadablePath(path: string, allowEmpty = false): void {
  if (allowEmpty && path === '') {
    return;
  }

  const hasControlCharacter = [...path].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

  if (
    !path ||
    path.length > 1024 ||
    hasControlCharacter ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    path.split('/').includes('.git')
  ) {
    throw new InputValidationError('Chemin de fichier invalide.');
  }

  if (SENSITIVE_FILE.test(path)) {
    throw new InputValidationError('La lecture de ce fichier sensible est interdite.', 'SENSITIVE_FILE');
  }
}

/* -------------------------------------------------------------------------- */
/*  Client                                                                     */
/* -------------------------------------------------------------------------- */

export class GitHubClient {
  readonly files: GitHubFiles;
  readonly repositories: GitHubRepositories;
  readonly branches: GitHubBranches;
  readonly changes: GitHubChanges;
  readonly merges: GitHubMerges;
  readonly pullRequests: GitHubPullRequests;
  readonly issues: GitHubIssues;
  readonly actions: GitHubActions;
  readonly commits: GitHubCommits;
  readonly releases: GitHubReleases;
  private readonly authenticator: GitHubAuthenticator;
  private readonly http: GitHubHttp;
  private readonly policy: Partial<SecurityPolicy>;
  private readonly allowedRepositories: ReadonlySet<string>;

  constructor(options: GitHubClientOptions) {
    // Enveloppe obligatoire : `fetch` détaché de `globalThis` lève « Illegal invocation » dans un Worker.
    const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    const userAgent = options.userAgent ?? 'github-mcp-worker';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authenticator = new GitHubAuthenticator({
      appId: options.appId,
      privateKey: options.privateKey,
      installationId: options.installationId,
      tokenPermissions: options.tokenPermissions,
      fetcher,
      userAgent,
      timeoutMs,
    });
    this.http = new GitHubHttp({
      fetcher,
      userAgent,
      timeoutMs,
      apiVersion: options.apiVersion,
      assertRequestAllowed: method => {
        if (options.policy?.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          throw new PolicyViolationError('READ_ONLY_REPOSITORY', 'Ce dépôt est configuré en lecture seule.');
        }
      },
      getInstallationToken: forceRefresh =>
        this.authenticator.getInstallationToken(forceRefresh),
    });
    this.policy = options.policy ?? {};
    this.allowedRepositories = new Set(
      (options.allowedRepositories ?? []).map(repository => repository.toLowerCase()),
    );
    const context: GitHubServiceContext = {
      request: <T>(path: string, init?: RequestInit) => this.http.request<T>(path, init),
      send: (path, init) => this.http.send(path, init),
      repoPath: (repository, suffix) => this.repoPath(repository, suffix),
      paginate: <TPayload, TItem>(path: string, extract: (payload: TPayload) => TItem[], limit?: number) =>
        this.http.paginate(path, extract, limit),
      paginateArray: <T>(path: string, limit?: number) => this.http.paginateArray<T>(path, limit),
      withQuery,
      encodeSegment,
      encodeSlashPath,
      splitRepository,
      assertPositiveInteger,
      assertGitRef,
      assertReadablePath,
      assertWritableBranchName: branch => this.assertWritableBranchName(branch),
      policy: this.policy,
      allowedRepositories: this.allowedRepositories,
      allowMerge: options.allowMerge ?? false,
      allowIntegrationMerge: options.allowIntegrationMerge ?? false,
      allowApproval: options.allowApproval ?? false,
      allowedWorkflows: new Set(options.allowedWorkflows ?? []),
      allowedWorkflowRefs: new Set(options.allowedWorkflowRefs ?? []),
    };

    this.files = new GitHubFiles(context);
    this.repositories = new GitHubRepositories(context);
    this.branches = new GitHubBranches(context);
    this.changes = new GitHubChanges(context);
    this.merges = new GitHubMerges(context);
    this.pullRequests = new GitHubPullRequests(context);
    this.issues = new GitHubIssues(context);
    this.actions = new GitHubActions(context);
    this.commits = new GitHubCommits(context);
    this.releases = new GitHubReleases(context);
  }

  private repoPath(repository: string, suffix = ''): string {
    const { owner, name } = splitRepository(repository);

    if (
      this.allowedRepositories.size > 0 &&
      !this.allowedRepositories.has(`${owner}/${name}`.toLowerCase())
    ) {
      throw new InputValidationError('Ce dépôt n’est pas autorisé.', 'REPOSITORY_DENIED');
    }

    return `/repos/${encodeSegment(owner)}/${encodeSegment(name)}${suffix}`;
  }

  private assertWritableBranchName(branch: string): void {
    assertGitRef(branch);
    assertWritableBranch(branch, this.policy);
  }
}

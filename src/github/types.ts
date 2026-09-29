import type { SecurityPolicy } from '../security/policy';

export type GitHubUser = { login: string; html_url?: string };
export type GitHubLabel = { name: string; color?: string; description?: string | null };

export type GitHubRepository = {
  full_name: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
  html_url?: string;
  archived?: boolean;
  visibility?: string;
};

export type GitHubTreeEntry = {
  path?: string;
  sha?: string;
  type?: string;
  mode?: string;
};

export type GitHubTree = { sha?: string; truncated?: boolean; tree: GitHubTreeEntry[] };

export type GitHubContentFile = {
  type: 'file';
  encoding: string;
  content: string;
  sha: string;
  path: string;
  size: number;
};

export type GitHubContentEntry = {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
};

export type GitHubBranch = {
  name: string;
  protected: boolean;
  commit: { sha: string };
};

export type GitHubCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  author?: GitHubUser | null;
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
};

export type GitHubComparison = {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: GitHubCommit[];
  files?: NonNullable<GitHubCommit['files']>;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url: string;
  body?: string | null;
  user?: GitHubUser;
  head: { ref: string; sha: string };
  base: { ref: string };
};

export type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body?: string | null;
  user?: GitHubUser;
  labels: Array<GitHubLabel | string>;
  assignees?: GitHubUser[];
  pull_request?: unknown;
};

export type GitHubComment = {
  id: number;
  html_url: string;
  body?: string;
  user?: GitHubUser;
  created_at: string;
};

export type GitHubReview = {
  id: number;
  state: string;
  body?: string | null;
  user?: GitHubUser;
  html_url?: string;
};

export type GitHubReviewComment = {
  id: number;
  path: string;
  line?: number | null;
  body: string;
  user?: GitHubUser;
  html_url: string;
};

export type GitHubWorkflow = { id: number; name: string; path: string; state: string };

export type GitHubWorkflowRun = {
  id: number;
  name?: string | null;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  event: string;
  html_url: string;
  created_at: string;
};

export type GitHubJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  steps?: Array<{ name: string; status: string; conclusion: string | null }>;
};

export type GitHubCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
};

export type GitHubCombinedStatus = {
  state: string;
  total_count: number;
  statuses: Array<{ context: string; state: string; description: string | null }>;
};

export type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body?: string | null;
};

export type GitHubRateLimit = {
  resources: Record<string, { limit: number; remaining: number; reset: number }>;
};

export type GitHubSearchCodeItem = {
  name: string;
  path: string;
  sha: string;
  html_url: string;
};

export type GitHubClientOptions = {
  appId: string;
  /** Clé privée PKCS#8 (les `\\n` échappés sont acceptés). */
  privateKey: string;
  installationId: string;
  userAgent?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  /** Politique de sécurité appliquée à toutes les écritures. */
  policy?: Partial<SecurityPolicy>;
  /** Liste blanche `owner/repo` (insensible à la casse). Vide = toute l'installation. */
  allowedRepositories?: readonly string[];
  /** Permissions demandées pour le jeton (moindre privilège). Omis = celles de l'installation. */
  tokenPermissions?: Record<string, 'read' | 'write'>;
  /** Autorise la fusion de Pull Requests (désactivé par défaut). */
  allowMerge?: boolean;
  /** Autorise l'approbation de Pull Requests (désactivé par défaut). */
  allowApproval?: boolean;
};

export type FileDeletion = {
  path: string;
  expectedSha?: string;
};

export type ApplyChangeSetOptions = {
  deletions?: readonly FileDeletion[];
};

export type AppliedChangeSet = {
  branch: string;
  commitSha: string;
  changedPaths: string[];
  deletedPaths: string[];
};

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export type ReviewLineComment = {
  path: string;
  line: number;
  body: string;
  side?: 'LEFT' | 'RIGHT';
};

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    endpoint: string,
    public readonly resetAt: Date | null,
  ) {
    super(
      429,
      endpoint,
      `Limite de requêtes GitHub atteinte${
        resetAt ? ` (réinitialisation à ${resetAt.toISOString()})` : ''
      }.`,
    );
    this.name = 'GitHubRateLimitError';
  }
}

export class GitHubConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubConflictError';
  }
}

export type { FileChange, SecurityPolicy } from '../security/policy';

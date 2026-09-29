export type SecurityPolicy = {
  readOnly: boolean;
  protectedBranches: readonly string[];
  protectedBranchPrefixes: readonly string[];
  branchPrefix: string;
  maxFilesPerChange: number;
  maxFileBytes: number;
};

export type FileChange = {
  path: string;
  content: string;
  expectedSha?: string;
};

export const DEFAULT_POLICY: Readonly<SecurityPolicy> = Object.freeze({
  readOnly: false,
  protectedBranches: ['main', 'master', 'client'],
  protectedBranchPrefixes: ['client/'],
  branchPrefix: 'mcp/',
  maxFilesPerChange: 50,
  maxFileBytes: 1_000_000,
});

export class PolicyViolationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

function reject(code: string, message: string): never {
  throw new PolicyViolationError(code, message);
}

function getPolicy(
  input: Partial<SecurityPolicy> = {},
): Readonly<SecurityPolicy> {
  const policy = {
    ...DEFAULT_POLICY,
    ...input,
  };

  if (
    !Array.isArray(policy.protectedBranches) ||
    !Array.isArray(policy.protectedBranchPrefixes) ||
    !/^[a-z0-9][a-z0-9-]{0,31}\/$/.test(policy.branchPrefix)
  ) {
    reject('INVALID_POLICY', 'La configuration des branches est invalide.');
  }

  if (
    !Number.isInteger(policy.maxFilesPerChange) ||
    policy.maxFilesPerChange < 1 ||
    policy.maxFilesPerChange > 100
  ) {
    reject('INVALID_POLICY', 'Le nombre maximal de fichiers est invalide.');
  }

  if (
    !Number.isInteger(policy.maxFileBytes) ||
    policy.maxFileBytes < 1 ||
    policy.maxFileBytes > 10_000_000
  ) {
    reject('INVALID_POLICY', 'La taille maximale de fichier est invalide.');
  }

  return policy;
}

function slugify(value: string, field: string): string {
  const result = value
    .normalize('NFKC')
    .toLowerCase()
    // Chaque suite de caractères invalides est déjà réduite à un seul tiret,
    // donc il suffi de retirer un tiret au début et un à la fin. Les
    // alternatives quantifiées (`/^-+|-+$/`) sont évitées car elles
    // provoquent un backtracking super-linéaire.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 48)
    .replace(/-$/, '');

  if (!result) {
    reject('INVALID_BRANCH_SEGMENT', `${field} est invalide.`);
  }

  return result;
}

export function buildWorkingBranch(
  client: string,
  task: string,
  inputPolicy: Partial<SecurityPolicy> = {},
): string {
  const policy = getPolicy(inputPolicy);

  return `${policy.branchPrefix}${slugify(client, 'Le client')}/${slugify(
    task,
    'La tâche',
  )}`;
}

export function assertSelectedRepository(
  repository: string,
  selectedRepositories: readonly string[],
): void {
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) &&
    !repository.includes('..');

  if (!valid) {
    reject('INVALID_REPOSITORY', 'Le nom du dépôt est invalide.');
  }

  const selected = selectedRepositories.some(
    candidate => candidate.toLowerCase() === repository.toLowerCase(),
  );

  if (!selected) {
    reject(
      'REPOSITORY_DENIED',
      'Le dépôt ne fait pas partie des dépôts autorisés.',
    );
  }
}

export function assertWritableBranch(
  branch: string,
  inputPolicy: Partial<SecurityPolicy> = {},
): void {
  const policy = getPolicy(inputPolicy);
  const normalized = branch.toLowerCase();

  if (policy.readOnly) {
    reject(
      'READ_ONLY_REPOSITORY',
      'Ce dépôt est configuré en lecture seule.',
    );
  }

  if (
    policy.protectedBranches.some(
      protectedBranch => protectedBranch.toLowerCase() === normalized,
    ) ||
    policy.protectedBranchPrefixes.some(prefix =>
      normalized.startsWith(prefix.toLowerCase()),
    )
  ) {
    reject('PROTECTED_BRANCH', 'Cette branche est protégée.');
  }

  if (
    branch.length > 240 ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('\\') ||
    /[\u0000-\u0020\u007f~^:?*[%\]]/.test(branch) ||
    !branch.startsWith(policy.branchPrefix)
  ) {
    reject('BRANCH_DENIED', 'La branche ne respecte pas la politique.');
  }

  const segments = branch.slice(policy.branchPrefix.length).split('/');

  if (
    segments.length !== 2 ||
    segments.some(segment => !/^[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/.test(segment))
  ) {
    reject(
      'BRANCH_DENIED',
      `Utilise une branche ${policy.branchPrefix}<client>/<tâche>.`,
    );
  }
}

export function assertWritablePath(path: string): void {
  const parts = path.split('/');

  if (
    !path ||
    path.length > 4096 ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f<>:"|?*%]/.test(path) ||
    parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git' ||
        part.endsWith('.') ||
        part.endsWith(' '),
    )
  ) {
    reject('PATH_DENIED', 'Le chemin du fichier est invalide.');
  }

  if (/^\.github\/workflows(?:\/|$)/i.test(path)) {
    reject('WORKFLOW_DENIED', 'Les fichiers GitHub Actions sont protégés.');
  }
}

export function validateChangeSet(
  changes: readonly FileChange[],
  inputPolicy: Partial<SecurityPolicy> = {},
): readonly FileChange[] {
  const policy = getPolicy(inputPolicy);

  if (
    !Array.isArray(changes) ||
    changes.length === 0 ||
    changes.length > policy.maxFilesPerChange
  ) {
    reject('CHANGE_SET_INVALID', 'Le nombre de fichiers est invalide.');
  }

  const paths = new Set<string>();

  for (const change of changes) {
    if (
      !change ||
      typeof change.path !== 'string' ||
      typeof change.content !== 'string'
    ) {
      reject('CHANGE_INVALID', 'Une modification est invalide.');
    }

    assertWritablePath(change.path);

    if (paths.has(change.path)) {
      reject('DUPLICATE_PATH', `Le fichier ${change.path} est dupliqué.`);
    }

    paths.add(change.path);

    if (change.content.includes('\u0000')) {
      reject('BINARY_FILE_DENIED', 'Les fichiers binaires sont interdits.');
    }

    if (
      new TextEncoder().encode(change.content).byteLength >
      policy.maxFileBytes
    ) {
      reject('FILE_TOO_LARGE', `Le fichier ${change.path} est trop volumineux.`);
    }

    if (
      change.expectedSha !== undefined &&
      !/^[a-f0-9]{40}$/i.test(change.expectedSha)
    ) {
      reject('INVALID_SHA', `Le SHA de ${change.path} est invalide.`);
    }
  }

  return changes;
}

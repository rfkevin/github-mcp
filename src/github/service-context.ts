import type { SecurityPolicy } from '../security/policy';

export type GitHubServiceContext = {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  send: (path: string, init?: RequestInit) => Promise<Response>;
  repoPath: (repository: string, suffix?: string) => string;
  paginate: <TPayload, TItem>(
    path: string,
    extract: (payload: TPayload) => TItem[],
    limit?: number,
  ) => Promise<TItem[]>;
  paginateArray: <T>(path: string, limit?: number) => Promise<T[]>;
  withQuery: (
    path: string,
    params: Record<string, string | number | boolean | undefined>,
  ) => string;
  encodeSegment: (value: string) => string;
  encodeSlashPath: (value: string) => string;
  splitRepository: (repository: string) => { owner: string; name: string };
  assertPositiveInteger: (value: number, label: string) => void;
  assertGitRef: (name: string, label?: string) => void;
  assertReadablePath: (path: string, allowEmpty?: boolean) => void;
  assertWritableBranchName: (branch: string) => void;
  policy: Partial<SecurityPolicy>;
  allowedRepositories: ReadonlySet<string>;
  allowMerge: boolean;
  allowApproval: boolean;
};

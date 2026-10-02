import type { GitHubUser } from './common';
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
    size?: number;
};
export type GitHubTree = {
    sha?: string;
    truncated?: boolean;
    tree: GitHubTreeEntry[];
};
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
    commit: {
        sha: string;
    };
};
export type GitHubCommit = {
    sha: string;
    parents?: Array<{
        sha: string;
    }>;
    html_url: string;
    commit: {
        message: string;
        author?: {
            name?: string;
            date?: string;
        };
    };
    author?: GitHubUser | null;
    files?: Array<{
        filename: string;
        previous_filename?: string;
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
    resources: Record<string, {
        limit: number;
        remaining: number;
        reset: number;
    }>;
};
export type GitHubSearchCodeItem = {
    name: string;
    path: string;
    sha: string;
    html_url: string;
};

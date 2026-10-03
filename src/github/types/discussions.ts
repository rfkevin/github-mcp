import type { GitHubUser, GitHubLabel } from './common';
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
    head: {
        ref: string;
        sha: string;
        repo?: {
            full_name: string;
        } | null;
    };
    base: {
        ref: string;
        sha?: string;
    };
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
    updated_at?: string;
    issue_url?: string;
};
export type GitHubCommitComment = GitHubComment & {
    commit_id: string;
    path?: string | null;
    line?: number | null;
};
export type GitHubReview = {
    id: number;
    state: string;
    body?: string | null;
    user?: GitHubUser;
    html_url?: string;
    submitted_at?: string;
};
export type GitHubReviewComment = {
    id: number;
    path: string;
    line?: number | null;
    body: string;
    user?: GitHubUser;
    html_url: string;
    created_at?: string;
    updated_at?: string;
};
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type ReviewLineComment = {
    path: string;
    line: number;
    body: string;
    side?: 'LEFT' | 'RIGHT';
};

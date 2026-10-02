export type GitHubWorkflow = {
    id: number;
    name: string;
    path: string;
    state: string;
};
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
    display_title?: string;
    path?: string;
};
export type GitHubJob = {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string | null;
    steps?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
    }>;
};
export type GitHubCheckRun = {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string | null;
    head_sha?: string;
    app?: {
        slug?: string;
    };
    output?: {
        title?: string | null;
        summary?: string | null;
        annotations_count?: number;
    };
};
export type GitHubCheckAnnotation = {
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: string;
    title?: string | null;
    message: string;
};
export type GitHubCombinedStatus = {
    state: string;
    total_count: number;
    statuses: Array<{
        context: string;
        state: string;
        description: string | null;
    }>;
};

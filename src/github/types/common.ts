export type GitHubUser = {
    login: string;
    html_url?: string;
};
export type GitHubLabel = {
    name: string;
    color?: string;
    description?: string | null;
};

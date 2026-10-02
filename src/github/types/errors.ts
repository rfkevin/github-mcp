export class GitHubApiError extends Error {
    constructor(public readonly status: number, public readonly endpoint: string, message: string) {
        super(message);
        this.name = 'GitHubApiError';
    }
}
/** Message écrit par le projet, sûr à restituer (jamais une réponse distante). */
export class InputValidationError extends Error {
    constructor(message: string, public readonly code = 'INVALID_REQUEST') {
        super(message);
        this.name = 'InputValidationError';
    }
}
export class GitHubRateLimitError extends GitHubApiError {
    constructor(endpoint: string, public readonly resetAt: Date | null) {
        super(429, endpoint, `Limite de requêtes GitHub atteinte${resetAt ? ` (réinitialisation à ${resetAt.toISOString()})` : ''}.`);
        this.name = 'GitHubRateLimitError';
    }
}
export class GitHubConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GitHubConflictError';
    }
}

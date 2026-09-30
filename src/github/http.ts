import { GitHubApiError, GitHubRateLimitError } from './types';
import { readJson } from './response';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

// Seul le nom de l'erreur est lu : son message peut contenir l'URL appelée.
function networkFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';

  if (name === 'TimeoutError') return 'Délai dépassé lors de l’appel à GitHub.';
  if (name === 'AbortError') return 'Appel à GitHub interrompu avant la réponse.';
  return 'Échec réseau lors de l’appel à GitHub.';
}

export type GitHubHttpOptions = {
  fetcher: typeof fetch;
  userAgent: string;
  timeoutMs: number;
  apiVersion?: '2022-11-28' | '2026-03-10';
  assertRequestAllowed?: (method: string) => void;
  getInstallationToken: (forceRefresh?: boolean) => Promise<string>;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

export class GitHubHttp {
  constructor(private readonly options: GitHubHttpOptions) {}

  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    this.options.assertRequestAllowed?.(method);
    const idempotent = method === 'GET' || method === 'HEAD';
    let forceRefresh = false;
    let refreshedOnce = false;

    for (let attempt = 0; ; attempt += 1) {
      const token = await this.options.getInstallationToken(forceRefresh);
      forceRefresh = false;

      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/vnd.github+json');
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('X-GitHub-Api-Version', this.options.apiVersion ?? GITHUB_API_VERSION);
      headers.set('User-Agent', this.options.userAgent);

      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      let response: Response;

      try {
        response = await this.options.fetcher(`${GITHUB_API}${path}`, {
          ...init,
          headers,
          // Workers peut conserver Authorization lors d'une redirection distante.
          // Les URL de téléchargement de logs nécessiteront un client sans jeton.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        if (idempotent && attempt < MAX_RETRIES) {
          await sleep(500 * 2 ** attempt);
          continue;
        }

        throw new GitHubApiError(0, path, networkFailureMessage(error));
      }

      if (response.ok) {
        return response;
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new GitHubApiError(response.status, path, 'Redirection GitHub refusée.');
      }

      if (response.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        forceRefresh = true;
        await response.body?.cancel();
        continue;
      }

      const delay = this.retryDelay(response, attempt, idempotent);

      if (delay !== undefined && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(delay);
        continue;
      }

      throw await this.toApiError(response, path);
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.send(path, init);

    if (response.status === 204) {
      return undefined as T;
    }

    return readJson<T>(response);
  }

  async paginate<TPayload, TItem>(
    path: string,
    extract: (payload: TPayload) => TItem[],
    limit = 300,
  ): Promise<TItem[]> {
    const items: TItem[] = [];

    for (let page = 1; items.length < limit; page += 1) {
      const payload = await this.request<TPayload>(this.withQuery(path, { per_page: 100, page }));
      const batch = extract(payload);
      items.push(...batch);

      if (batch.length < 100) {
        break;
      }
    }

    return items.slice(0, limit);
  }

  paginateArray<T>(path: string, limit?: number): Promise<T[]> {
    return this.paginate<T[], T>(path, payload => payload, limit);
  }

  private retryDelay(
    response: Response,
    attempt: number,
    idempotent: boolean,
  ): number | undefined {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    const isRateLimited =
      response.status === 429 ||
      (response.status === 403 && (retryAfter !== null || remaining === '0'));

    if (isRateLimited) {
      let delay: number | undefined;

      if (retryAfter !== null) {
        delay = Number(retryAfter) * 1000;
      } else {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        delay = reset ? reset * 1000 - Date.now() : undefined;
      }

      if (delay === undefined || Number.isNaN(delay) || delay > MAX_RATE_LIMIT_WAIT_MS) {
        return undefined;
      }

      return Math.max(delay, 500);
    }

    if (idempotent && [500, 502, 503, 504].includes(response.status)) {
      return 500 * 2 ** attempt;
    }

    return undefined;
  }

  private async toApiError(response: Response, path: string): Promise<GitHubApiError> {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');

    if (
      response.status === 429 ||
      (response.status === 403 && (retryAfter !== null || remaining === '0'))
    ) {
      await response.body?.cancel();
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      return new GitHubRateLimitError(path, reset ? new Date(reset * 1000) : null);
    }

    let message = `GitHub a répondu avec le statut ${response.status}.`;

    try {
      const payload = await readJson<{
        message?: string;
        errors?: Array<string | { message?: string }>;
      }>(response, 32_000);

      if (payload.message) {
        message = payload.message;
      }

      const details = (payload.errors ?? [])
        .map(error => (typeof error === 'string' ? error : error.message))
        .filter((detail): detail is string => Boolean(detail))
        .join(' ; ');

      if (details) {
        message = `${message} — ${details}`;
      }
    } catch {
      // Never expose a raw response body from an API error.
    }

    return new GitHubApiError(response.status, path, message.slice(0, 500));
  }

  private withQuery(
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
    if (!query) return path;
    return `${path}${path.includes('?') ? '&' : '?'}${query}`;
  }
}

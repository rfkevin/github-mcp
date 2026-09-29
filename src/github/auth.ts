import { importPKCS8, SignJWT } from 'jose';
import { GitHubApiError, type GitHubClientOptions } from './types';

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const TOKEN_SAFETY_MARGIN_MS = 60_000;

type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

type GitHubAuthOptions = Pick<
  GitHubClientOptions,
  'appId' | 'privateKey' | 'installationId' | 'tokenPermissions'
> & {
  fetcher: typeof fetch;
  userAgent: string;
  timeoutMs: number;
};

export class GitHubAuthenticator {
  private signingKeyPromise?: Promise<SigningKey>;
  private installationToken?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(private readonly options: GitHubAuthOptions) {}

  async getInstallationToken(forceRefresh = false): Promise<string> {
    const cached = this.installationToken;

    if (!forceRefresh && cached && cached.expiresAt - TOKEN_SAFETY_MARGIN_MS > Date.now()) {
      return cached.value;
    }

    this.pendingToken ??= this.createInstallationToken().finally(() => {
      this.pendingToken = undefined;
    });

    return this.pendingToken;
  }

  private getSigningKey(): Promise<SigningKey> {
    this.signingKeyPromise ??= (async () => {
      const pem = this.options.privateKey.replaceAll('\\n', '\n').trim();

      if (pem.includes('BEGIN RSA PRIVATE KEY')) {
        throw new Error(
          'Clé PKCS#1 détectée. Convertis-la : openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem',
        );
      }

      return importPKCS8(pem, 'RS256');
    })().catch(error => {
      this.signingKeyPromise = undefined;
      throw error;
    });

    return this.signingKeyPromise;
  }

  private async createAppJwt(): Promise<string> {
    const signingKey = await this.getSigningKey();
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.options.appId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 540)
      .sign(signingKey);
  }

  private async createInstallationToken(): Promise<string> {
    const appJwt = await this.createAppJwt();
    const permissions = this.options.tokenPermissions;
    const response = await this.options.fetcher(
      `${GITHUB_API}/app/installations/${encodeURIComponent(this.options.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${appJwt}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': this.options.userAgent,
          ...(permissions ? { 'Content-Type': 'application/json' } : {}),
        },
        body: permissions ? JSON.stringify({ permissions }) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubApiError(
        response.status,
        '/app/installations/{id}/access_tokens',
        'Impossible de créer le jeton GitHub App.',
      );
    }

    const payload = (await response.json()) as { token?: string; expires_at?: string };

    if (!payload.token) {
      throw new Error('GitHub n’a pas retourné de jeton d’installation.');
    }

    const expiresAt = payload.expires_at
      ? Date.parse(payload.expires_at)
      : Date.now() + 50 * 60_000;

    this.installationToken = {
      value: payload.token,
      expiresAt: Number.isNaN(expiresAt) ? Date.now() + 50 * 60_000 : expiresAt,
    };

    return payload.token;
  }
}

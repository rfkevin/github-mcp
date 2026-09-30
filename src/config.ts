import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { checksConfig } from './checks/config';

export interface AppEnv {
  OAUTH_KV: KVNamespace;
  PUBLIC_ORIGIN: string;
  ALLOWED_GITHUB_USER_IDS: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  /** JSON optionnel : dépôts + ref + SHA du contrôleur revu. Absent = aucun lancement. */
  GITHUB_CHECKS_CONFIG?: string;
}
export type AuthEnv = AppEnv & { OAUTH_PROVIDER: OAuthHelpers };

export function publicOrigin(env: AppEnv): string {
  const url = new URL(env.PUBLIC_ORIGIN);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Origine HTTPS invalide.');
  return url.origin;
}

export function isAllowedUser(env: AppEnv, userId: unknown): userId is string {
  return typeof userId === 'string' && /^[1-9][0-9]*$/.test(userId) &&
    env.ALLOWED_GITHUB_USER_IDS.split(',').map(id => id.trim()).includes(userId);
}

export function assertConfigured(env: AppEnv): void {
  publicOrigin(env);
  checksConfig(env.GITHUB_CHECKS_CONFIG);
  for (const value of [env.GITHUB_APP_ID, env.GITHUB_INSTALLATION_ID,
    env.GITHUB_PRIVATE_KEY, env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Configuration incomplète.');
  }
  if (!env.ALLOWED_GITHUB_USER_IDS.split(',').some(id => /^[1-9][0-9]*$/.test(id.trim()))) {
    throw new Error('Aucun utilisateur autorisé.');
  }
}

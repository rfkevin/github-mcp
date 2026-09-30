import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { checksConfig } from './checks/config';
import { writesEnabled } from './writes/config';
import { automationEnabled } from './automation/config';

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
  /** Interrupteur global, désactivé par défaut. Nécessite aussi le consentement mcp:write. */
  GITHUB_WRITES_ENABLED?: string;
  /** Mode multi-dépôts, global et désactivé par défaut ; consentement mcp:automation. */
  GITHUB_AUTOMATION_ENABLED?: string;
  /** Commit du paquet publié ; absent pour les anciens déploiements. */
  BUILD_SHA?: string;
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
  if (env.BUILD_SHA && !/^[a-f0-9]{40}$/i.test(env.BUILD_SHA)) throw new Error('Commit de déploiement invalide.');
  publicOrigin(env);
  checksConfig(env.GITHUB_CHECKS_CONFIG);
  writesEnabled(env.GITHUB_WRITES_ENABLED);
  automationEnabled(env.GITHUB_AUTOMATION_ENABLED);
  for (const value of [env.GITHUB_APP_ID, env.GITHUB_INSTALLATION_ID,
    env.GITHUB_PRIVATE_KEY, env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET]) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Configuration incomplète.');
  }
  if (!env.ALLOWED_GITHUB_USER_IDS.split(',').some(id => /^[1-9][0-9]*$/.test(id.trim()))) {
    throw new Error('Aucun utilisateur autorisé.');
  }
}

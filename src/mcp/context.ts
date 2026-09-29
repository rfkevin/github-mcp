import { GitHubClient } from '../github/client';
import type { AppEnv } from '../config';

export type ToolContext = {
  actor: string;
  /** Permissions minimales (métadonnées) : listing de l'installation. */
  github: Pick<GitHubClient, 'repositories'>;
  /** Lecture élargie : fichiers, comparaisons, contrôles et exécutions. */
  reads: Pick<GitHubClient, 'files' | 'commits' | 'actions'>;
};

/**
 * Deux clients, deux jetons. Demander une permission que la GitHub App n'a pas
 * accordée fait échouer la création du jeton (422) : les séparer garantit qu'un
 * outil de lecture mal configuré ne prive pas `github_list_repositories`, qui
 * n'a besoin que des métadonnées. `policy.readOnly` reste actif des deux côtés.
 */
export function createToolContext(env: AppEnv, actor: string): ToolContext {
  const shared = {
    appId: env.GITHUB_APP_ID,
    installationId: env.GITHUB_INSTALLATION_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    policy: { readOnly: true },
  };

  return {
    actor,
    github: new GitHubClient({ ...shared, tokenPermissions: { metadata: 'read' } }),
    reads: new GitHubClient({
      ...shared,
      tokenPermissions: {
        metadata: 'read',
        contents: 'read',
        pull_requests: 'read',
        actions: 'read',
        checks: 'read',
        statuses: 'read',
      },
    }),
  };
}

import { GitHubClient } from '../github/client';
import type { AppEnv } from '../config';

export type ToolContext = { actor: string; github: Pick<GitHubClient, 'repositories'> };

export function createToolContext(env: AppEnv, actor: string): ToolContext {
  return { actor, github: new GitHubClient({
    appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    policy: { readOnly: true }, tokenPermissions: { metadata: 'read' },
  }) };
}

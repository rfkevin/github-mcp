import { z } from 'zod';
import type { GitHubClient } from '../github/client';
import { InputValidationError } from '../github/types';
import { assertSelectedRepository } from '../security/policy';
import { agentLabelSchema, mutation } from './coordinator';

export const createIssueSchema = z.object({
  repository: z.string().min(3).max(200), title: z.string().trim().min(1).max(256),
  body: z.string().max(30_000).default(''), agentLabel: agentLabelSchema.default('agent non précisé'),
}).strict();

/** Dedicated Issues: Write token; never reuse a PR or contents token. */
export class IssueWriteCoordinator {
  constructor(private readonly actor: string,
    private readonly repositories: Pick<GitHubClient['repositories'], 'listInstallationRepositories' | 'getRepository'>,
    private readonly issues: Pick<GitHubClient['issues'], 'createIssue'>) {
    if (!/^[1-9][0-9]*$/.test(actor)) throw new InputValidationError('Identité d’écriture invalide.');
  }
  async createIssue(input: z.input<typeof createIssueSchema>) {
    const args = createIssueSchema.parse(input);
    assertSelectedRepository(args.repository, await this.repositories.listInstallationRepositories());
    const metadata = await this.repositories.getRepository(args.repository);
    if (metadata.archived) throw new InputValidationError('Ce dépôt est archivé.', 'REPOSITORY_ARCHIVED');
    const body = `Création MCP — compte GitHub ${this.actor} — agent déclaré : ${args.agentLabel}\n\n${args.body}`;
    const issue = await mutation(() => this.issues.createIssue(args.repository, args.title, body));
    return { repository: args.repository, number: issue.number, title: issue.title,
      state: issue.state, url: issue.html_url,
      note: 'Issue créée ; peut déclencher notifications et automatisations. Si la réponse est perdue, relire les issues avant de relancer pour éviter un doublon.' };
  }
}

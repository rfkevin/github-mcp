import { z } from 'zod';
import type { GitHubClient } from '../github/client';
import { GitHubApiError, GitHubConflictError, InputValidationError } from '../github/types';
import { SENSITIVE_FILE } from '../github/files';
import { assertSelectedRepository, assertWritableBranch, assertWritablePath, validateChangeSet } from '../security/policy';
import { verificationFollowUp } from '../mcp/workflow-guidance';

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
const repository = z.string().min(3).max(200);
const branch = z.string().min(1).max(240);
const path = z.string().min(1).max(1024);
// Unicode property escapes are not portable between JSON Schema validators.
// Keep the exact Unicode/length rule on the server, and publish portable metadata.
export const agentLabelSchema = z.string().trim()
  .refine(value => /^[\p{L}\p{N} ._-]{1,80}$/u.test(value), 'Nom d’agent invalide.')
  .meta({ minLength: 1, maxLength: 80,
    description: 'Nom déclaré de l’agent : 1 à 80 caractères, lettres, chiffres, espaces, points, tirets ou underscores.' });
const agentLabel = agentLabelSchema.default('agent non précisé');
export const createBranchSchema = z.object({ repository,
  task: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/),
  baseBranch: branch.optional(), expectedBaseSha: sha }).strict();
export const commitChangesSchema = z.object({ repository, branch, expectedHeadSha: sha,
  message: z.string().trim().min(1).max(200), agentLabel,
  changes: z.array(z.object({ path, content: z.string().max(1_000_000), expectedSha: sha.optional() }).strict()).max(50).default([]),
  deletions: z.array(z.object({ path, expectedSha: sha }).strict()).max(50).default([]),
}).strict();
export const openPullRequestSchema = z.object({ repository, branch, expectedHeadSha: sha,
  baseBranch: branch.optional(),
  title: z.string().trim().min(1).max(256), body: z.string().max(30_000).default(''), draft: z.boolean().default(true) }).strict();
export const commentPullRequestSchema = z.object({ repository, number: z.number().int().positive(),
  expectedHeadSha: sha, body: z.string().trim().min(1).max(10_000), agentLabel,
  decision: z.enum(['comment', 'agree', 'changes_requested']).default('comment'),
  expectedBaseSha: sha.optional(),
}).strict();
export const commentCommitSchema = z.object({ repository, sha,
  body: z.string().trim().min(1).max(10_000), agentLabel }).strict();

type ReadServices = {
  repositories: Pick<GitHubClient['repositories'], 'listInstallationRepositories' | 'getRepository'>;
  branches: Pick<GitHubClient['branches'], 'getBranchHead'>;
  commits: Pick<GitHubClient['commits'], 'getCommit'>;
};
type WriteServices = {
  branches: Pick<GitHubClient['branches'], 'createWorkingBranch'>;
  changes: Pick<GitHubClient['changes'], 'applyChangeSet'>;
  pullRequests: Pick<GitHubClient['pullRequests'], 'createPullRequest' | 'getPullRequest'>;
  issues: Pick<GitHubClient['issues'], 'createComment'>;
  commits: Pick<GitHubClient['commits'], 'createComment'>;
};

export class WriteCoordinator {
  readonly branchPrefix: string;
  constructor(private readonly actor: string, private readonly reads: ReadServices, private readonly writes: WriteServices) {
    if (!/^[1-9][0-9]*$/.test(actor)) throw new InputValidationError('Identité d’écriture invalide.');
    this.branchPrefix = `mcp/${actor}/`;
  }

  private ownBranch(branch: string): void {
    assertWritableBranch(branch);
    if (!branch.startsWith(this.branchPrefix)) {
      throw new InputValidationError('Cette branche n’appartient pas à l’utilisateur connecté.', 'BRANCH_OWNER_MISMATCH');
    }
  }

  private async repositoryForDiscussion(repository: string) {
    // Liste effective GitHub, pas une seconde liste de dépôts à configurer.
    assertSelectedRepository(repository, await this.reads.repositories.listInstallationRepositories());
    const metadata = await this.reads.repositories.getRepository(repository);
    if (metadata.archived) throw new InputValidationError('Ce dépôt est archivé.', 'REPOSITORY_ARCHIVED');
    return metadata;
  }

  private async repositoryForWrite(repository: string, branch: string) {
    const metadata = await this.repositoryForDiscussion(repository);
    if (branch.toLowerCase() === metadata.default_branch.toLowerCase()) {
      throw new InputValidationError('L’écriture sur la branche par défaut est interdite.', 'PROTECTED_BRANCH');
    }
    return metadata;
  }

  async createBranch(input: z.input<typeof createBranchSchema>) {
    const args = createBranchSchema.parse(input);
    const branch = `${this.branchPrefix}${args.task}`;
    this.ownBranch(branch);
    const metadata = await this.repositoryForWrite(args.repository, branch);
    const baseBranch = args.baseBranch ?? metadata.default_branch;
    const result = await mutation(() => this.writes.branches.createWorkingBranch(
      args.repository, branch, baseBranch, { expectedBaseSha: args.expectedBaseSha }));
    return { repository: args.repository, baseBranch, ...result };
  }

  async commitChanges(input: z.input<typeof commitChangesSchema>) {
    const args = commitChangesSchema.parse(input);
    const message = `${args.message}\n\nMCP-Actor: ${this.actor}\nMCP-Agent: ${args.agentLabel}`;
    if (message.length > 200) throw new InputValidationError('Raccourcissez le message : 200 caractères maximum avec la trace MCP.', 'MESSAGE_TOO_LONG');
    this.ownBranch(args.branch);
    const files = [...args.changes, ...args.deletions.map(deletion => ({ ...deletion, content: '' }))];
    validateChangeSet(files);
    let bytes = 0;
    for (const file of files) {
      assertWritablePath(file.path);
      if (SENSITIVE_FILE.test(file.path)) throw new InputValidationError('Fichier sensible interdit.', 'SENSITIVE_FILE');
      bytes += new TextEncoder().encode(file.content).byteLength;
    }
    if (bytes > 1_000_000) throw new InputValidationError('Le contenu cumulé dépasse 1 Mo.', 'CHANGE_SET_TOO_LARGE');
    await this.repositoryForWrite(args.repository, args.branch);
    const result = await mutation(() => this.writes.changes.applyChangeSet(args.repository, args.branch,
      args.changes, message, { expectedHeadSha: args.expectedHeadSha, deletions: args.deletions }));
    return { repository: args.repository, ...result,
      followUp: verificationFollowUp(args.repository, result.commitSha),
      note: 'Commit enregistré, pas une validation des tests. Les automatisations du dépôt peuvent démarrer.' };
  }

  async openPullRequest(input: z.input<typeof openPullRequestSchema>) {
    const args = openPullRequestSchema.parse(input);
    this.ownBranch(args.branch);
    const metadata = await this.repositoryForWrite(args.repository, args.branch);
    const baseBranch = args.baseBranch ?? metadata.default_branch;
    if (baseBranch.toLowerCase() === args.branch.toLowerCase()) throw new InputValidationError('Les branches source et cible de la PR doivent être différentes.');
    if (args.baseBranch) await this.reads.branches.getBranchHead(args.repository, baseBranch);
    const head = await this.reads.branches.getBranchHead(args.repository, args.branch);
    if (head !== args.expectedHeadSha) throw new InputValidationError('La branche a changé : relisez le diff.', 'HEAD_CHANGED');
    const pull = await mutation(() => this.writes.pullRequests.createPullRequest(args.repository, args.branch,
      baseBranch, args.title, args.body, { draft: args.draft }));
    return { repository: args.repository, number: pull.number, url: pull.html_url, draft: pull.draft,
      base: pull.base.ref, branch: pull.head.ref, headSha: pull.head.sha,
      headMatchesExpected: pull.head.sha === args.expectedHeadSha,
      followUp: verificationFollowUp(args.repository, pull.head.sha, pull.number),
      note: 'PR créée, sans fusion ni validation des tests. Le SHA observé peut évoluer ; relire le diff avant toute validation. Les automatisations du dépôt peuvent démarrer.' };
  }

  async commentPullRequest(input: z.input<typeof commentPullRequestSchema>) {
    const args = commentPullRequestSchema.parse(input);
    await this.repositoryForDiscussion(args.repository);
    const pull = await this.writes.pullRequests.getPullRequest(args.repository, args.number);
    if (pull.state !== 'open' || pull.head.repo?.full_name.toLowerCase() !== args.repository.toLowerCase()) {
      throw new InputValidationError('Seule une PR ouverte dont la branche source appartient à ce dépôt peut être commentée.', 'PR_DENIED');
    }
    if (pull.head.sha.toLowerCase() !== args.expectedHeadSha) {
      throw new InputValidationError('La PR a changé : relisez son état avant de commenter.', 'HEAD_CHANGED');
    }
    let decision = '';
    if (args.decision !== 'comment') {
      if (!args.expectedBaseSha || args.agentLabel === 'agent non précisé') {
        throw new InputValidationError('Un avis exige agentLabel et expectedBaseSha.', 'REVIEW_CONTEXT_REQUIRED');
      }
      const base = await this.reads.branches.getBranchHead(args.repository, pull.base.ref);
      if (base.toLowerCase() !== args.expectedBaseSha) throw new InputValidationError('La base a changé : renouveler la revue.', 'BASE_CHANGED');
      decision = `MCP-Review: ${JSON.stringify({ version: 1, agent: args.agentLabel, actor: this.actor,
        head: args.expectedHeadSha, base: args.expectedBaseSha, decision: args.decision })}\n\n`;
    }
    const comment = await mutation(() => this.writes.issues.createComment(args.repository, args.number,
      decision + this.reviewBody(args.agentLabel, args.expectedHeadSha, args.body)));
    return { repository: args.repository, number: args.number, id: comment.id, url: comment.html_url,
      observedHeadSha: pull.head.sha, note: 'Commentaire ajouté, sans approbation. Peut déclencher les automatisations du dépôt.' };
  }

  private reviewBody(agent: string, sha: string, body: string): string {
    return `Revue MCP — compte GitHub ${this.actor} — agent déclaré : ${agent}\nCommit examiné : ${sha}\n\n${body}`;
  }

  async commentCommit(input: z.input<typeof commentCommitSchema>) {
    const args = commentCommitSchema.parse(input);
    await this.repositoryForDiscussion(args.repository);
    const commit = await this.reads.commits.getCommit(args.repository, args.sha);
    if (commit.sha.toLowerCase() !== args.sha) throw new InputValidationError('Commit différent de celui demandé.', 'COMMIT_MISMATCH');
    const comment = await mutation(() => this.writes.commits.createComment(args.repository, args.sha,
      this.reviewBody(args.agentLabel, args.sha, args.body)));
    return { repository: args.repository, sha: args.sha, id: comment.id, url: comment.html_url,
      note: 'Commentaire général ajouté au commit, sans modification du code, approbation ou fusion. Peut déclencher des notifications et automatisations. En cas de doute, lire les commentaires avant de réessayer.' };
  }
}

/** Une réponse perdue ne doit pas faire rejouer automatiquement une écriture. */
export async function mutation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof GitHubConflictError) {
      throw new InputValidationError('Conflit : vérifiez la branche, les SHA des fichiers ou une PR déjà existante avant de réessayer.', 'WRITE_CONFLICT');
    }
    if (error instanceof GitHubApiError && (error.status === 0 || error.status >= 500) ||
        error instanceof SyntaxError) {
      throw new InputValidationError('Résultat de l’écriture incertain. Vérifiez la branche ou les PR sur GitHub avant de relancer ; aucun rejeu automatique.', 'WRITE_RESULT_UNKNOWN');
    }
    throw error;
  }
}

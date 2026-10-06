import { z } from 'zod';
import type { GitHubClient } from '../github/client';
import { InputValidationError } from '../github/types';
import { SENSITIVE_FILE } from '../github/files';
import { assertSelectedRepository, assertWritableBranch } from '../security/policy';
import { agentLabelSchema, mutation } from '../writes/coordinator';
import { verificationFollowUp } from '../workflow/follow-up';

const repository = z.string().min(3).max(200), branch = z.string().min(1).max(240);
const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
export const mergeContextSchema = z.object({ repository, branch, baseBranch: branch.optional() }).strict();
export const resolveConflictsSchema = mergeContextSchema.extend({ expectedHeadSha: sha, expectedBaseSha: sha,
  message: z.string().trim().min(1).max(200), agentLabel: agentLabelSchema.default('agent non précisé'),
  resolutions: z.array(z.discriminatedUnion('choice', [
    z.object({ path: z.string().min(1).max(1024), choice: z.enum(['ours', 'theirs', 'delete']) }).strict(),
    z.object({ path: z.string().min(1).max(1024), choice: z.literal('content'), content: z.string().max(1_000_000) }).strict(),
  ])).max(50).default([]),
}).strict();

type Reads = {
  repositories: Pick<GitHubClient['repositories'], 'listInstallationRepositories' | 'getRepository'>;
  branches: Pick<GitHubClient['branches'], 'getBranchHead'>;
  merges: Pick<GitHubClient['merges'], 'inspect'>;
};
export class MergeCoordinator {
  readonly canResolve: boolean;
  constructor(private readonly actor: string, private readonly reads: Reads, private readonly writes?: GitHubClient['merges']) {
    if (!/^[1-9][0-9]*$/.test(actor)) throw new InputValidationError('Identité invalide.');
    this.canResolve = Boolean(writes);
  }
  private async metadata(repository: string) {
    assertSelectedRepository(repository, await this.reads.repositories.listInstallationRepositories());
    return this.reads.repositories.getRepository(repository);
  }
  async context(input: z.input<typeof mergeContextSchema>) {
    const args = mergeContextSchema.parse(input);
    const metadata = await this.metadata(args.repository);
    const baseBranch = args.baseBranch ?? metadata.default_branch;
    const [headSha, baseSha] = await Promise.all([this.reads.branches.getBranchHead(args.repository, args.branch), this.reads.branches.getBranchHead(args.repository, baseBranch)]);
    const snapshot = await this.reads.merges.inspect(args.repository, headSha, baseSha);
    let ownBranch = args.branch.startsWith(`mcp/${this.actor}/`) && args.branch.toLowerCase() !== metadata.default_branch.toLowerCase();
    try { assertWritableBranch(args.branch); } catch { ownBranch = false; }
    return { repository: args.repository, branch: args.branch, baseBranch, headSha, baseSha, ancestorSha: snapshot.ancestorSha,
      conflicts: snapshot.plan.rows.filter(row => row.conflict).map(row => ({
        path: SENSITIVE_FILE.test(row.path) ? '[chemin sensible]' : row.path, blocked: row.blocked,
        ...(row.blocked ? {} : { ancestorBlobSha: row.ancestor?.sha ?? null, oursBlobSha: row.ours?.sha ?? null, theirsBlobSha: row.theirs?.sha ?? null }) })),
      automaticPaths: snapshot.plan.rows.filter(row => !row.conflict && !row.blocked).map(row => row.path),
      blockedPaths: snapshot.plan.rows.filter(row => row.blocked).map(row => SENSITIVE_FILE.test(row.path) ? '[chemin sensible]' : row.path),
      canResolve: this.canResolve && ownBranch && !metadata.archived && !snapshot.plan.rows.some(row => row.blocked),
      note: 'Comparaison conservatrice par fichier : deux éditions différentes exigent un choix même si Git pourrait fusionner les lignes. Lire les trois SHA avec github_read_files, résoudre tous les conflits, puis github_resolve_conflicts. Aucun choix implicite, aucune fusion de PR. Les SHA restent à revérifier.' };
  }
  async resolve(input: z.input<typeof resolveConflictsSchema>) {
    if (!this.writes) throw new InputValidationError('Résolution désactivée : mcp:write requis.', 'MERGE_WRITE_DISABLED');
    const args = resolveConflictsSchema.parse(input);
    assertWritableBranch(args.branch);
    if (!args.branch.startsWith(`mcp/${this.actor}/`)) throw new InputValidationError('Branche d’un autre compte.', 'BRANCH_OWNER_MISMATCH');
    const metadata = await this.metadata(args.repository);
    if (metadata.archived) throw new InputValidationError('Dépôt archivé.', 'REPOSITORY_ARCHIVED');
    if (args.branch.toLowerCase() === metadata.default_branch.toLowerCase()) throw new InputValidationError('Branche par défaut protégée.', 'PROTECTED_BRANCH');
    const baseBranch = args.baseBranch ?? metadata.default_branch;
    if (baseBranch.toLowerCase() === args.branch.toLowerCase()) throw new InputValidationError('Branches source et cible identiques.', 'MERGE_SAME_BRANCH');
    const message = `${args.message}\n\nMCP-Actor: ${this.actor}\nMCP-Agent: ${args.agentLabel}`;
    if (message.length > 200) throw new InputValidationError('Raccourcir le message : 200 caractères trace comprise.', 'MESSAGE_TOO_LONG');
    const result = await mutation(() => this.writes!.resolve(args.repository, args.branch, baseBranch,
      args.expectedHeadSha, args.expectedBaseSha, message, args.resolutions));
    return { repository: args.repository, ...result, baseBranch, followUp: verificationFollowUp(args.repository, result.commitSha),
      note: 'Commit de résolution créé sur la branche personnelle, sans fusion de PR. Les avis doivent être renouvelés au nouveau SHA ; suivre CI/build/qualité. Après réponse perdue, relire la branche avant tout rejeu.' };
  }
}

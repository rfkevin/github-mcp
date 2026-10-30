import { z } from 'zod';
import type { ToolContext } from '../mcp/context';
import { collectCiStatus } from '../mcp/tools/github/ci';
import { expectedCheckSchema } from '../mcp/verification';
import { verificationFollowUp } from '../workflow/follow-up';
import { agentLabelSchema, mutation } from '../writes/coordinator';
import { assertSelectedRepository, assertWritablePath } from '../security/policy';
import { GitHubApiError, InputValidationError, type GitHubPullRequest } from '../github/types';
import { SENSITIVE_FILE } from '../github/files';
import { declaredConsensus } from './consensus';
import { APPEND_ONLY_PATHS, rejectMemoryRewrite } from '../agent-memory';

const sha = z.string().regex(/^[a-f0-9]{40}$/i).transform(value => value.toLowerCase());
export const integrationPolicySchema = z.object({ version: z.literal(1), branch: z.literal('integration'),
  expectedChecks: z.array(expectedCheckSchema).min(1).max(30),
  reviewers: z.array(agentLabelSchema).min(2).max(10).refine(values => new Set(values).size === values.length),
}).strict();
export const mergeIntegrationSchema = z.object({ repository: z.string().min(3).max(200),
  number: z.number().int().positive(), expectedHeadSha: sha, expectedBaseSha: sha,
  expectedLastCommentId: z.number().int().positive(), agentLabel: agentLabelSchema,
  expectedLastReviewCommentId: z.number().int().nonnegative().default(0),
  discussionSummary: z.string().trim().min(20).max(2000),
}).strict();
const POLICY_PATH = '.mcp/integration.json';
function refuse(message: string, code: string): never { throw new InputValidationError(message, code); }

export class IntegrationCoordinator {
  constructor(private readonly actor: string, private readonly context: ToolContext,
    private readonly merge: (repo: string, head: string, message: string) => Promise<{ sha: string } | undefined>) {}

  private verifyPull(pull: GitHubPullRequest, args: z.output<typeof mergeIntegrationSchema>) {
    if (pull.state !== 'open' || pull.merged || pull.draft !== false || pull.base.ref !== 'integration' ||
        pull.head.repo?.full_name.toLowerCase() !== args.repository.toLowerCase()) {
      refuse('PR ouverte, hors brouillon, interne et ciblant integration requise.', 'INTEGRATION_PR_DENIED');
    }
    if (pull.head.sha.toLowerCase() !== args.expectedHeadSha) refuse('La PR a changé : renouveler tests et avis.', 'HEAD_CHANGED');
  }

  private async discussion(args: z.output<typeof mergeIntegrationSchema>, reviewers: string[]) {
    const [comments, reviews, inline] = await Promise.all([
      this.context.pulls.issues.listComments(args.repository, args.number, 101),
      this.context.pulls.pullRequests.listReviews(args.repository, args.number, 101),
      this.context.pulls.pullRequests.listReviewComments(args.repository, args.number, 101),
    ]);
    if (comments.length >= 101 || reviews.length >= 101 || inline.length >= 101) refuse('Discussion trop longue pour une validation complète : revue humaine requise.', 'DISCUSSION_TRUNCATED');
    if (Math.max(0, ...comments.map(item => item.id)) !== args.expectedLastCommentId) {
      refuse('La discussion a évolué : relire avant de fusionner.', 'DISCUSSION_CHANGED');
    }
    if (Math.max(0, ...inline.map(item => item.id)) !== args.expectedLastReviewCommentId) {
      refuse('Les commentaires de code ont évolué : relire avant de fusionner.', 'DISCUSSION_CHANGED');
    }
    const latest = new Map<string, string>();
    for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
      if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user?.login ?? `unknown:${review.id}`, review.state);
    }
    if ([...latest.values()].includes('CHANGES_REQUESTED')) refuse('Une revue GitHub demande encore des corrections.', 'REVIEW_BLOCKED');
    const consensus = declaredConsensus(comments, reviewers, args.expectedHeadSha, args.expectedBaseSha);
    if (!consensus.agreed) refuse('Accord des participants manquant, périmé ou bloquant : poursuivre la discussion, pas de fusion.', 'CONSENSUS_REQUIRED');
    return consensus;
  }

  private async verifyMemory(repository: string, path: string, base: string, head: string) {
    let previous = '';
    try { previous = (await this.context.reads.files.getTextFile(repository, path, base)).content; }
    catch (error) { if (!(error instanceof GitHubApiError && error.status === 404)) throw error; }
    const next = (await this.context.reads.files.getTextFile(repository, path, head)).content;
    // Ne pas normaliser ni accepter un décodage UTF-8 ambigu.
    if (previous.includes('\uFFFD') || next.includes('\uFFFD') || !next.startsWith(previous)) {
      rejectMemoryRewrite(path);
    }
  }

  async mergePullRequest(input: z.input<typeof mergeIntegrationSchema>) {
    const args = mergeIntegrationSchema.parse(input);
    const { github, reads, pulls } = this.context;
    assertSelectedRepository(args.repository, await github.repositories.listInstallationRepositories());
    const repo = await github.repositories.getRepository(args.repository);
    if (repo.archived || repo.default_branch.toLowerCase() === 'integration') refuse('Dépôt archivé ou integration devenue branche principale.', 'INTEGRATION_DISABLED');
    const policyHead = await reads.branches.getBranchHead(args.repository, repo.default_branch);
    let policyText;
    try { policyText = await reads.files.getTextFile(args.repository, POLICY_PATH, policyHead); }
    catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) refuse('Le propriétaire doit installer .mcp/integration.json sur la branche principale.', 'INTEGRATION_DISABLED');
      throw error;
    }
    let parsedPolicy;
    try { parsedPolicy = integrationPolicySchema.safeParse(JSON.parse(policyText.content)); }
    catch { refuse('Politique d’intégration JSON invalide : correction par le propriétaire requise.', 'INTEGRATION_POLICY_INVALID'); }
    if (!parsedPolicy.success) refuse('Politique d’intégration invalide : contrôles et participants distincts requis.', 'INTEGRATION_POLICY_INVALID');
    const policy = parsedPolicy.data;
    this.verifyPull(await pulls.pullRequests.getPullRequest(args.repository, args.number), args);
    const base = await reads.branches.getBranchHead(args.repository, 'integration');
    if (base.toLowerCase() !== args.expectedBaseSha) refuse('integration a changé : refaire la revue.', 'BASE_CHANGED');
    const comparison = await reads.commits.compareRefs(args.repository, args.expectedBaseSha, args.expectedHeadSha);
    if (!comparison.files || comparison.files.length >= 300) refuse('Diff incomplet : revue humaine requise.', 'DIFF_INCOMPLETE');
    for (const file of comparison.files) {
      for (const path of [file.filename, file.previous_filename].filter((value): value is string => !!value)) {
        assertWritablePath(path);
        // La fusion ne doit pas contourner les protections des commits MCP.
        if (SENSITIVE_FILE.test(path)) {
          refuse('Fichier sensible : intégration par le propriétaire requise.', 'INTEGRATION_FILE_DENIED');
        }
        const journal = APPEND_ONLY_PATHS.find(name => name.toLowerCase() === path.toLowerCase());
        if (journal) {
          if (path !== journal || file.status === 'removed' || file.previous_filename) rejectMemoryRewrite(journal);
          await this.verifyMemory(args.repository, journal, args.expectedBaseSha, args.expectedHeadSha);
        }
      }
    }
    const ci = await collectCiStatus(this.context, args.repository, args.expectedHeadSha, policy.expectedChecks);
    if (ci.sha !== args.expectedHeadSha || ci.verification.state !== 'declared_checks_passed') {
      refuse('Les contrôles attendus ne sont pas tous attestés au SHA exact.', 'CI_NOT_PASSED');
    }
    const consensus = await this.discussion(args, policy.reviewers);
    // Réduire les courses ; GitHub ne propose pas de CAS sur la base de POST /merges.
    this.verifyPull(await pulls.pullRequests.getPullRequest(args.repository, args.number), args);
    const [currentBase, currentPolicy] = await Promise.all([
      reads.branches.getBranchHead(args.repository, 'integration'),
      reads.branches.getBranchHead(args.repository, repo.default_branch),
    ]);
    if (currentBase.toLowerCase() !== args.expectedBaseSha || currentPolicy !== policyHead) refuse('Base ou politique modifiée : relire.', 'BASE_CHANGED');
    const result = await mutation(() => this.merge(args.repository, args.expectedHeadSha,
      `Integrate PR #${args.number}\n\nMCP-Actor: ${this.actor}\nMCP-Agent: ${args.agentLabel}\nMCP-Discussion: ${args.expectedLastCommentId}`));
    const mergedSha = result?.sha ?? await reads.branches.getBranchHead(args.repository, 'integration');
    if (!/^[a-f0-9]{40}$/i.test(mergedSha)) refuse('Résultat de fusion à vérifier sur GitHub ; ne pas rejouer.', 'WRITE_RESULT_UNKNOWN');
    return { repository: args.repository, number: args.number, branch: 'integration', sha: mergedSha,
      alreadyIntegrated: !result, consensus, discussionSummary: args.discussionSummary,
      followUp: { ...verificationFollowUp(args.repository, mergedSha, args.number),
        arguments: { repository: args.repository, ref: mergedSha, expectedChecks: policy.expectedChecks },
        instruction: 'Suivre les contrôles du SHA résultant sur integration, puis relire cette branche pour détecter un nouveau changement. Le headSha de la PR reste son commit source : il peut différer du commit de fusion. Vérifier séparément son état GitHub. Ne pas déclarer terminé avec une CI post-intégration absente ou incomplète.' },
      note: 'Code intégré uniquement dans integration. Relire la PR pour constater son état GitHub, puis suivre la CI du résultat. Aucun déploiement direct ni fusion principale ; les automatisations existantes peuvent néanmoins démarrer. Aucun verrou global sur les autres acteurs.' };
  }
}

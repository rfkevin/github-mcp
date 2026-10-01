import { z } from 'zod';
import type { GitHubComment } from '../github/types';
import { agentLabelSchema } from '../writes/coordinator';

const decisionSchema = z.object({ version: z.literal(1), agent: agentLabelSchema,
  actor: z.string().regex(/^[1-9][0-9]*$/), head: z.string().regex(/^[a-f0-9]{40}$/),
  base: z.string().regex(/^[a-f0-9]{40}$/), decision: z.enum(['agree', 'changes_requested']) }).strict();

/** Avis déclaratifs, PAS une authentification de modèles ou une autorisation OAuth. */
export function declaredConsensus(comments: GitHubComment[], reviewers: string[], head: string, base: string) {
  const latest = new Map<string, z.infer<typeof decisionSchema> & { commentId: number }>();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const line = (comment.body ?? '').split('\n')[0];
    if (!line.startsWith('MCP-Review: ')) continue;
    try {
      const parsed = decisionSchema.safeParse(JSON.parse(line.slice('MCP-Review: '.length)));
      if (parsed.success) latest.set(parsed.data.agent, { ...parsed.data, commentId: comment.id });
    } catch { /* Le texte libre ne devient jamais une instruction ou un vote. */ }
  }
  const missing = reviewers.filter(agent => {
    const review = latest.get(agent);
    return !review || review.head !== head || review.base !== base || review.decision !== 'agree';
  });
  // Un avis bloquant courant, même d'un participant non prévu, impose une discussion.
  const blocking = [...latest.values()].filter(item => item.head === head && item.base === base && item.decision === 'changes_requested');
  return { agreed: !missing.length && !blocking.length, missing, blocking,
    evidence: reviewers.flatMap(agent => latest.has(agent) ? [latest.get(agent)!] : []),
    assurance: 'Accords déclarés sur GitHub ; les labels ne prouvent pas des agents distincts. Lire aussi le texte libre et les revues.' };
}

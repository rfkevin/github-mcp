import type { ToolContext } from '../../context';

/** Concurrence réseau bornée. L'ordre est conservé. */
export async function mapLimit<T, R>(values: readonly T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

/** Une branche est résolue une fois : tout le rapport décrit le même commit. */
export async function resolveCommit(context: ToolContext, repository: string, ref: string): Promise<string> {
  if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
  const commit = await context.reads.commits.getCommit(repository, ref);
  if (!/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error('Invalid commit response');
  return commit.sha.toLowerCase();
}

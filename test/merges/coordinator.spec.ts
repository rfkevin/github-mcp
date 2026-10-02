import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { MergeCoordinator } from '../../src/merges/coordinator';
import { registerMergeTools } from '../../src/mcp/tools/github/merges';
import { toolRegistry } from '../mcp/tool-registry';
import { args, BASE, HEAD, ANCESTOR, OLD, OURS, THEIRS, entry, mergeFixture } from './helpers';

describe('Diagnostic et résolution MCP, permissions et erreurs', () => {
  it('annonce les SHA des trois versions et les chemins automatiques', async () => {
    const { coordinator } = mergeFixture();
    const tools = toolRegistry(registerMergeTools, { actor: '123', mergeCoordinator: coordinator } as ToolContext);
    const result = await tools.get('github_get_merge_context')!({ repository: 'o/r', branch: args.branch });
    expect(result.structuredContent).toMatchObject({ headSha: HEAD, baseSha: BASE, ancestorSha: ANCESTOR,
      conflicts: [{ path: 'app.ts', oursBlobSha: OURS, theirsBlobSha: THEIRS, ancestorBlobSha: OLD }],
      automaticPaths: ['new.ts'], canResolve: true });
    const resolved = await tools.get('github_resolve_conflicts')!(args);
    expect(resolved.structuredContent).toHaveProperty('followUp');
  });
  it('ne publie que le diagnostic pour un client en lecture seule', async () => {
    const { reads, mutations } = mergeFixture();
    const coordinator = new MergeCoordinator('123', reads);
    const tools = toolRegistry(registerMergeTools, { actor: '123', mergeCoordinator: coordinator } as ToolContext);
    expect([...tools.keys()]).toEqual(['github_get_merge_context']);
    expect((await coordinator.context({ repository: 'o/r', branch: args.branch })).canResolve).toBe(false);
    await expect(coordinator.resolve(args)).rejects.toMatchObject({ code: 'MERGE_WRITE_DISABLED' });
    expect(mutations()).toHaveLength(0);
  });
  it.each(['master', 'mcp/456/fix'])('refuse la branche %s avant toute lecture', async branch => {
    const { coordinator, request } = mergeFixture();
    await expect(coordinator.resolve({ ...args, branch })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('refuse les dépôts hors installation, archivés et la branche par défaut réelle', async () => {
    const { coordinator, reads, mutations } = mergeFixture();
    await expect(coordinator.resolve({ ...args, repository: 'else/repo' })).rejects.toThrow();
    reads.repositories.getRepository.mockResolvedValue({ full_name: 'o/r', private: true, archived: true, default_branch: 'master' });
    await expect(coordinator.resolve(args)).rejects.toMatchObject({ code: 'REPOSITORY_ARCHIVED' });
    reads.repositories.getRepository.mockResolvedValue({ full_name: 'o/r', private: true, archived: false, default_branch: args.branch });
    await expect(coordinator.resolve(args)).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    expect(mutations()).toHaveLength(0);
  });
  it('signale un blocage sans exposer un chemin sensible ou ses blobs', async () => {
    const fixture = mergeFixture({ ancestor: [entry('.env', OLD)], ours: [entry('.env', OURS)], theirs: [entry('.env', THEIRS)] });
    const result = await fixture.coordinator.context({ repository: 'o/r', branch: args.branch });
    expect(result).toMatchObject({ conflicts: [{ path: '[chemin sensible]', blocked: true }], canResolve: false });
    expect(JSON.stringify(result)).not.toContain(OURS);
    await expect(fixture.coordinator.resolve({ ...args, resolutions: [] })).rejects.toMatchObject({ code: 'MERGE_PATH_DENIED' });
    expect(fixture.mutations()).toHaveLength(0);
  });
});

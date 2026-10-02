import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { WriteCoordinator } from '../../src/writes/coordinator';
import { GitHubConflictError } from '../../src/github/types';
import { registerTargetedWriteTools } from '../../src/mcp/tools/github/targeted-write';
import { toolRegistry } from './tool-registry';
const HEAD = 'a'.repeat(40), BLOB = 'b'.repeat(40), NEXT = 'c'.repeat(40);
const args = { repository: 'o/r', branch: 'mcp/123/fix', path: 'src/app.ts', expectedHeadSha: HEAD,
    expectedSha: BLOB, oldText: 'old', newText: 'new', message: 'Fix', agentLabel: 'Codex' };
function fixture(content = 'prefix old suffix') {
    const reads = { repositories: { listInstallationRepositories: vi.fn(async () => ['o/r']),
            getRepository: vi.fn(async () => ({ full_name: 'o/r', private: true, default_branch: 'master' })) },
        branches: { getBranchHead: vi.fn(async () => HEAD) },
        files: { getTextFile: vi.fn(async () => ({ path: args.path, sha: BLOB, size: content.length, content })) },
        commits: { getCommit: vi.fn() } };
    const writes = { branches: { createWorkingBranch: vi.fn() }, changes: { applyChangeSet: vi.fn(async () => ({
                branch: args.branch, commitSha: NEXT, changedPaths: [args.path], deletedPaths: []
            })) },
        pullRequests: { createPullRequest: vi.fn(), getPullRequest: vi.fn() },
        issues: { createComment: vi.fn() }, commits: { createComment: vi.fn() } };
    const coordinator = new WriteCoordinator('123', reads, writes);
    const tools = toolRegistry(registerTargetedWriteTools, { actor: '123', reads, writeCoordinator: coordinator } as unknown as ToolContext);
    return { reads, writes, replace: (input: object = {}) => tools.get('github_replace_text')!({ ...args, ...input }) };
}
describe('Remplacement ciblé : concurrence et protections des commits', () => {
    it('préserve le reste d’un gros fichier et lit le commit immuable', async () => {
        const content = 'x'.repeat(75000) + 'old suffix';
        const { replace, reads, writes } = fixture(content);
        expect((await replace()).structuredContent).toMatchObject({ commitSha: NEXT, followUp: { taskComplete: false, arguments: { ref: NEXT } } });
        expect(reads.files.getTextFile).toHaveBeenCalledWith('o/r', args.path, HEAD);
        expect(writes.changes.applyChangeSet).toHaveBeenCalledWith('o/r', args.branch, [{ path: args.path, content: 'x'.repeat(75000) + 'new suffix', expectedSha: BLOB }], expect.stringContaining('MCP-Agent: Codex'), { expectedHeadSha: HEAD, deletions: [] });
    });
    it.each([['absent', 'TEXT_NOT_FOUND'], ['old and old', 'TEXT_NOT_UNIQUE'], ['aaa', 'TEXT_NOT_UNIQUE']])('refuse un texte absent ou ambigu : %s', async (content, code) => {
        const { replace, writes } = fixture(content);
        expect(await replace({ oldText: content === 'aaa' ? 'aa' : 'old' })).toMatchObject({ isError: true, structuredContent: { error: { code } } });
        expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    });
    it('refuse un blob périmé ou une modification vide sans écrire', async () => {
        const { replace, writes } = fixture();
        expect(await replace({ expectedSha: NEXT })).toMatchObject({ structuredContent: { error: { code: 'FILE_CHANGED' } } });
        expect(await replace({ newText: 'old' })).toMatchObject({ structuredContent: { error: { code: 'NO_CHANGE' } } });
        expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    });
    it('refuse une branche avancée avant même de lire le fichier', async () => {
        const { replace, reads, writes } = fixture();
        reads.branches.getBranchHead.mockResolvedValue(NEXT);
        expect(await replace()).toMatchObject({ structuredContent: { error: { code: 'HEAD_CHANGED' } } });
        expect(reads.files.getTextFile).not.toHaveBeenCalled();
        expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    });
    it.each([{ branch: 'master' }, { branch: 'mcp/456/fix' }, { path: '.env' }, { path: '.github/workflows/ci.yml' }])('refuse une cible protégée avant tout appel réseau : %j', async (input) => {
        const { replace, reads, writes } = fixture();
        expect(await replace(input)).toMatchObject({ isError: true });
        expect(reads.branches.getBranchHead).not.toHaveBeenCalled();
        expect(reads.files.getTextFile).not.toHaveBeenCalled();
        expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
    });
    it('conserve la validation des journaux et le SHA lors d’un conflit concurrent', async () => {
        const { replace, writes } = fixture();
        writes.changes.applyChangeSet.mockRejectedValue(new GitHubConflictError('changed'));
        expect(await replace({ path: 'AGENT_MEMORY.md' })).toMatchObject({ structuredContent: { error: { code: 'WRITE_CONFLICT' } } });
        expect(writes.changes.applyChangeSet).toHaveBeenCalledWith('o/r', args.branch, [expect.objectContaining({ path: 'AGENT_MEMORY.md', expectedSha: BLOB })], expect.any(String), { expectedHeadSha: HEAD, deletions: [] });
        expect(writes.changes.applyChangeSet).toHaveBeenCalledOnce();
    });
    it('reste caché en lecture seule', () => {
        expect(toolRegistry(registerTargetedWriteTools, { actor: '123' } as ToolContext).size).toBe(0);
    });
});

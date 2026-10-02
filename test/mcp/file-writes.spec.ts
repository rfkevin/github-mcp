import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { GitHubApiError, GitHubConflictError } from '../../src/github/types';
import { registerFileWriteTools } from '../../src/mcp/tools/github/file-writes';
import { toolRegistry } from './tool-registry';
import { args, HEAD, BLOB, NEXT, SOURCE, fileWriteFixture } from './file-write-fixture';

describe('Ajout et restauration : contenu complet, concurrence et protections', () => {
  it('ajoute exactement le texte en conservant BOM, CRLF, Unicode et gros préfixe', async () => {
    const content = '\uFEFFdébut\r\n' + 'x'.repeat(85_000);
    const { append, reads, writes } = fileWriteFixture(content);
    expect((await append({ text: 'fin' })).structuredContent).toMatchObject({ commitSha: NEXT, followUp: { arguments: { ref: NEXT } } });
    expect(reads.files.getTextFile).toHaveBeenCalledWith('o/r', args.path, HEAD);
    expect(writes.changes.applyChangeSet).toHaveBeenCalledWith('o/r', args.branch,
      [{ path: args.path, content: content + 'fin', expectedSha: BLOB }], expect.stringContaining('MCP-Agent: Codex'),
      { expectedHeadSha: HEAD, deletions: [] });
  });
  it.each(['AGENT_MEMORY.md', 'TOOL_IMPROVEMENTS.md'])('respecte les vrais contrôles append-only pour %s', async path => {
    const { append, restore, request } = fileWriteFixture('ancienne note\r\n', 'autre note', path);
    expect(await restore()).toMatchObject({ isError: true });
    expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect((await append()).structuredContent).toMatchObject({ commitSha: NEXT });
  });
  it('restaure depuis une branche résolue une fois en commit immuable', async () => {
    const source = 'x'.repeat(90_000) + '\r\nfin';
    const { restore, reads, writes } = fileWriteFixture('damaged', source);
    expect((await restore({ sourceRef: 'known-good' })).structuredContent).toMatchObject({ commitSha: NEXT, sourceSha: SOURCE, sourceBlobSha: SOURCE });
    expect(reads.commits.getCommit).toHaveBeenCalledExactlyOnceWith('o/r', 'known-good');
    expect(reads.files.getTextFile).toHaveBeenNthCalledWith(2, 'o/r', args.path, SOURCE);
    expect(writes.changes.applyChangeSet.mock.calls[0][2][0]).toEqual({ path: args.path, content: source, expectedSha: BLOB });
  });
  it('peut recréer un fichier supprimé uniquement avec absence explicitement attendue', async () => {
    const { restore, reads, request, writes } = fileWriteFixture();
    reads.files.getTextFile.mockRejectedValueOnce(new GitHubApiError(404, '/git/trees', 'missing'));
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => url.includes('/git/trees/') && !init?.method
      ? { truncated: false, tree: [] } : original(url, init));
    expect((await restore({ expectedSha: null })).structuredContent).toMatchObject({ commitSha: NEXT });
    expect(writes.changes.applyChangeSet.mock.calls[0][2][0]).not.toHaveProperty('expectedSha');
  });
  it('ne transforme pas un accès refusé en absence de fichier', async () => {
    const { restore, reads, writes } = fileWriteFixture();
    reads.files.getTextFile.mockRejectedValueOnce(new GitHubApiError(403, '/git/trees', 'forbidden'));
    expect(await restore({ expectedSha: null })).toMatchObject({ isError: true });
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse une source manquante ou un contenu inchangé sans écriture', async () => {
    const { restore, reads, writes } = fileWriteFixture('same', 'same');
    expect(await restore()).toMatchObject({ structuredContent: { error: { code: 'NO_CHANGE' } } });
    reads.files.getTextFile.mockResolvedValueOnce({ path: args.path, sha: BLOB, content: 'same', size: 4 })
      .mockRejectedValueOnce(new GitHubApiError(404, '/git/trees', 'missing source'));
    expect(await restore()).toMatchObject({ isError: true });
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it.each(['append', 'restore'] as const)('refuse un head/blob périmé pour %s', async operation => {
    const fixture = fileWriteFixture();
    expect(await fixture[operation]({ expectedSha: NEXT })).toMatchObject({ structuredContent: { error: { code: 'FILE_CHANGED' } } });
    fixture.reads.branches.getBranchHead.mockResolvedValue(NEXT);
    expect(await fixture[operation]()).toMatchObject({ structuredContent: { error: { code: 'HEAD_CHANGED' } } });
    expect(fixture.writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it.each(['append', 'restore'] as const)('refuse les cibles protégées avant tout accès pour %s', async operation => {
    for (const input of [{ branch: 'master' }, { branch: 'mcp/456/fix' }, { path: '.env' }, { path: '.github/workflows/ci.yml' }]) {
      const fixture = fileWriteFixture();
      expect(await fixture[operation](input)).toMatchObject({ isError: true });
      expect(fixture.reads.branches.getBranchHead).not.toHaveBeenCalled();
      expect(fixture.writes.changes.applyChangeSet).not.toHaveBeenCalled();
    }
  });
  it('refuse une absence attendue si le fichier existe et une taille finale supérieure au budget', async () => {
    const { restore, append, writes } = fileWriteFixture('x'.repeat(999_999));
    expect(await restore({ expectedSha: null })).toMatchObject({ structuredContent: { error: { code: 'FILE_CHANGED' } } });
    expect(await append({ text: 'é' })).toMatchObject({ isError: true });
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('ne rejoue pas un conflit survenu après la lecture', async () => {
    const { append, writes } = fileWriteFixture();
    writes.changes.applyChangeSet.mockRejectedValue(new GitHubConflictError('changed'));
    expect(await append()).toMatchObject({ structuredContent: { error: { code: 'WRITE_CONFLICT' } } });
    expect(writes.changes.applyChangeSet).toHaveBeenCalledOnce();
  });
  it('reste caché en lecture seule', () => {
    expect(toolRegistry(registerFileWriteTools, { actor: '123' } as ToolContext).size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { args, HEAD, BASE, ANCESTOR, NEXT, OLD, OURS, THEIRS, EXTRA, entry, mergeFixture } from './helpers';

describe('Commit de résolution à deux parents sans force', () => {
  it('reprend les changements automatiques et applique le contenu résolu sans perdre les autres fichiers', async () => {
    const { coordinator, mutations, heads } = mergeFixture();
    const result = await coordinator.resolve(args);
    expect(result).toMatchObject({ commitSha: NEXT, baseSha: BASE, ancestorSha: ANCESTOR, followUp: { arguments: { ref: NEXT } } });
    const bodies = mutations().map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).toEqual({ base_tree: HEAD, tree: [
      { path: 'new.ts', mode: '100644', type: 'blob', sha: EXTRA },
      { path: 'app.ts', mode: '100644', type: 'blob', content: 'merged' }] });
    expect(bodies[1]).toMatchObject({ tree: NEXT, parents: [HEAD, BASE], message: expect.stringContaining('MCP-Agent: Codex') });
    expect(bodies[2]).toEqual({ sha: NEXT, force: false });
    expect(heads.theirs).toBe(BASE);
  });
  it.each(['ours', 'theirs', 'delete'] as const)('applique le choix %s par SHA sans reconstruire le blob', async choice => {
    const { coordinator, mutations } = mergeFixture();
    await coordinator.resolve({ ...args, resolutions: [{ path: 'app.ts', choice }] });
    const tree = JSON.parse(String(mutations()[0][1]?.body)).tree;
    const edit = tree.find((item: { path: string }) => item.path === 'app.ts');
    if (choice === 'ours') expect(edit).toBeUndefined();
    else expect(edit.sha).toBe(choice === 'theirs' ? THEIRS : null);
  });
  it.each(['missing', 'duplicate', 'extra', 'markers'])('refuse une résolution %s avant toute mutation', async scenario => {
    const { coordinator, mutations } = mergeFixture();
    const resolutions = scenario === 'missing' ? [] : scenario === 'duplicate' ? [args.resolutions[0], args.resolutions[0]]
      : scenario === 'extra' ? [{ ...args.resolutions[0], path: 'new.ts' }] : [{ ...args.resolutions[0], content: '<<<<<<< ours\nstill broken\n>>>>>>> theirs' }];
    await expect(coordinator.resolve({ ...args, resolutions })).rejects.toThrow();
    expect(mutations()).toHaveLength(0);
  });
  it.each(['ours', 'theirs'] as const)('refuse un SHA périmé : %s', async side => {
    const { coordinator, mutations, heads } = mergeFixture();
    heads[side] = NEXT;
    await expect(coordinator.resolve(args)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    expect(mutations()).toHaveLength(0);
  });
  it('refuse une base avancée après création du commit, sans mettre la branche à jour', async () => {
    const { coordinator, mutations, request, heads } = mergeFixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (init?.method === 'POST' && url.endsWith('/git/commits')) heads.theirs = NEXT;
      return result;
    });
    await expect(coordinator.resolve(args)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    expect(mutations().some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(heads.ours).toBe(HEAD);
  });
  it.each(['AGENT_MEMORY.md', 'TOOL_IMPROVEMENTS.md'])('conserve les deux préfixes append-only : %s', path => {
    const fixture = mergeFixture({ ancestor: [entry(path, OLD)], ours: [entry(path, OURS)], theirs: [entry(path, THEIRS)] });
    fixture.blobs[OLD] = 'note\r\n'; fixture.blobs[OURS] = 'note\r\n'; fixture.blobs[THEIRS] = 'note\r\nbase\r\n';
    return expect(fixture.coordinator.resolve({ ...args, resolutions: [{ path, choice: 'content', content: 'note\r\nbase\r\nours\r\n' }] })).resolves.toMatchObject({ commitSha: NEXT });
  });
  it.each(['ours', 'delete', 'content'] as const)('refuse la perte d’un journal avec choice=%s', async choice => {
    const path = 'AGENT_MEMORY.md', fixture = mergeFixture({ ancestor: [entry(path, OLD)], ours: [entry(path, OURS)], theirs: [entry(path, THEIRS)] });
    fixture.blobs[OURS] = 'old note'; fixture.blobs[THEIRS] = 'old note\nbase note';
    const resolution = choice === 'content' ? { path, choice, content: 'rewritten' } : { path, choice };
    await expect(fixture.coordinator.resolve({ ...args, resolutions: [resolution] })).rejects.toThrow();
    expect(fixture.mutations()).toHaveLength(0);
  });
  it('refuse les fichiers entrants surdimensionnés avant tout POST', async () => {
    const fixture = mergeFixture({ ancestor: [], ours: [], theirs: [entry('large.txt', THEIRS, { size: 1_000_001 })] });
    await expect(fixture.coordinator.resolve({ ...args, resolutions: [] })).rejects.toMatchObject({ code: 'MERGE_FILE_TOO_LARGE' });
    expect(fixture.mutations()).toHaveLength(0);
  });
});

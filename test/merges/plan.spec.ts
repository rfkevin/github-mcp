import { describe, expect, it } from 'vitest';
import { mergeTree, planMerge } from '../../src/merges/plan';
import { entry, asTree, OLD, OURS, THEIRS } from './helpers';

describe('Plan conservateur à trois versions', () => {
  it('préserve les changements de sa branche et reprend ceux uniquement dans la base', () => {
    const old = [entry('ours.ts', OLD), entry('theirs.ts', OLD), entry('removed.ts', OLD)];
    const ours = [entry('ours.ts', OURS), entry('theirs.ts', OLD), entry('removed.ts', OLD)];
    const theirs = [entry('ours.ts', OLD), entry('theirs.ts', THEIRS), entry('added.ts', THEIRS)];
    const plan = planMerge(asTree(old), asTree(ours), asTree(theirs));
    expect([...plan.updates.keys()]).toEqual(['added.ts', 'removed.ts', 'theirs.ts']);
    expect(plan.updates.get('removed.ts')).toBeUndefined();
    expect(plan.rows.every(row => !row.conflict && !row.blocked)).toBe(true);
  });
  it.each(['different', 'modify-delete', 'add-add', 'mode'])('exige un choix pour %s', scenario => {
    const a = scenario === 'add-add' ? [] : [entry('app.ts', OLD)];
    const o = [entry('app.ts', OURS)];
    const t = scenario === 'modify-delete' ? [] : [entry('app.ts', scenario === 'mode' ? OURS : THEIRS, scenario === 'mode' ? { mode: '100755' } : {})];
    expect(planMerge(asTree(a), asTree(o), asTree(t)).rows).toMatchObject([{ path: 'app.ts', conflict: true }]);
  });
  it('ne demande pas de choix lorsque les deux côtés donnent la même version', () => {
    expect(planMerge(asTree([entry('app.ts', OLD)]), asTree([entry('app.ts', OURS)]), asTree([entry('app.ts', OURS)])).rows).toEqual([]);
  });
  it.each(['.env', '.github/workflows/ci.yml', 'scripts/deploy/a.mjs', '.mcp/integration.json'])('bloque un chemin protégé entrant : %s', path => {
    expect(planMerge(asTree([]), asTree([]), asTree([entry(path, THEIRS)])).rows[0].blocked).toBe(true);
  });
  it.each(['120000', '160000'])('bloque liens/sous-modules : %s', mode => {
    expect(planMerge(asTree([]), asTree([]), asTree([entry('link', THEIRS, { mode, type: mode === '160000' ? 'commit' : 'blob' })])).rows[0].blocked).toBe(true);
  });
  it('bloque les changements fichier/dossier, sans masquer les enfants', () => {
    const plan = planMerge(asTree([entry('dir', OLD, { mode: '040000', type: 'tree' }), entry('dir/a', OLD)]),
      asTree([entry('dir', OLD, { mode: '040000', type: 'tree' }), entry('dir/a', OLD)]), asTree([entry('dir', THEIRS)]));
    expect(plan.rows).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'dir', blocked: true })]));
  });
  it('refuse les arbres incomplets, les doublons et plus de 50 chemins', () => {
    expect(() => mergeTree({ truncated: true, tree: [] })).toThrow();
    expect(() => asTree([entry('app.ts', OLD), entry('app.ts', OURS)])).toThrow();
    expect(() => planMerge(asTree([]), asTree([]), asTree(Array.from({ length: 51 }, (_, i) => entry(`${i}.ts`, THEIRS))))).toThrow();
  });
});

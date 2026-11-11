import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { apiBranch, GitHubWriteRefused, type GitHubWrites } from '../../../src/collab-store/agentrun/github-tools';
import { MAX_EDITS, normalizeEdits } from '../../../src/collab-store/agentrun/github-write/edits';
import type { WritePolicy } from '../../../src/collab-store/agentrun/github-write/authorization';
import { createS7Tools, type ApiChecks } from '../../../src/collab-store/agentrun/github-write/tools';
import type { GitHubReads } from '../../../src/collab-store/agentrun/read-tools';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';

// CC8 U2a (#seq2189) : gardes de COMMIT communes aux modes guidé et libre (B1, B2), anti-doublon de PR (B3), édition groupée (C1).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const T = 1_990_000_000, REPO = 'rfkevin/github-mcp', BASE = 'mcp/105856986/cc3-integration';
const H = 'b'.repeat(40);
const blob = (path: string) => (path.endsWith('b.ts') ? 'd' : 'e').repeat(40);
const TEXTS: Record<string, string> = { 'src/demo/a.ts': 'alpha beta', 'src/demo/b.ts': 'gamma delta', 'src/demo/x.spec.ts': "it('x', () => {});" };
const REAL = "import { describe, expect, it } from 'vitest';\nimport { plan } from '../../src/demo/a';\ndescribe('a', () => { it('plan', () => { expect(plan(1)).toBe(2); }); });\n";
const DEMO = "import { describe, expect, it } from 'vitest';\nimport { plan } from '../../src/demo/a';\ndescribe('a', () => { it('plan', () => { expect(true).toBe(true); }); });\n";
let n = 0;

async function fixture(grantExtra: Record<string, unknown> = {}) {
  const id = ++n, cycle = 'u2a-' + id + '-' + Date.now(), participant = 'u2a-agent-' + id, run = 'run-' + cycle;
  const task = 'fix', name = 'fix', branch = apiBranch(participant, name);
  await insertCycleRow(db, cycle, 'P6');
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(participant).run();
  await insertPhaseDefinition(db, cycle, 'P6', []);
  await insertTaskRow(db, { cycle, taskId: task, owner: participant, reviewer: 'u2a-rev-' + id, tester: 'u2a-tst-' + id });
  await db.prepare("UPDATE tasks SET status='in_progress', owned_paths=?3 WHERE cycle_id=?1 AND task_id=?2").bind(cycle, task, JSON.stringify(['src/demo/'])).run();
  await createRun(db, { runId: run, cycleId: cycle, participantId: participant, taskId: task, taskKind: 'implement', prompt: 'u2a',
    maxSteps: 30, maxTokens: 100000, maxCostCents: 0, deadlineAt: T + 1000, now: T });
  const policy: WritePolicy = { writers: participant, tasks: JSON.stringify([{ cycle, task, participant, branch, paths: ['src/demo/'], ...grantExtra }]) };
  let head = H, commits = 0, openAttempts = 0, existingPr = false;
  const committed: Array<{ path: string; content: string }[]> = [];
  const writes: GitHubWrites = {
    branchHead: async () => head, createBranch: async () => ({ sha: head }),
    commitFiles: async (_r, _b, expected, _m, files) => {
      if (expected !== head) throw Error('wrong head');
      head = (++commits).toString(16).padStart(40, 'a');
      committed.push((files as Array<{ path: string; content: string }>).map(f => ({ path: f.path, content: f.content })));
      return { commit_sha: head };
    },
    recentCommits: async () => [{ sha: H, message: 'base' }],
    openDraftPullRequest: async () => ({ number: 1, head_sha: head }),
    openPullRequest: async () => {
      if (++openAttempts > 1) throw new GitHubWriteRefused('CONFLICT', 'Une Pull Request existe déjà pour ces branches.');
      existingPr = true;
      return { number: 7, head_sha: head };
    },
    findPullRequest: async () => (existingPr ? { number: 7, head_sha: head, draft: false } : null),
  };
  const reads: GitHubReads = {
    getTextFile: async (_r, path) => {
      if (!(path in TEXTS)) throw Error('404');
      return { path, sha: blob(path), content: TEXTS[path], size: TEXTS[path].length };
    },
    getPullRequest: async () => ({}), listCheckRuns: async () => [], compareRefs: async () => ({}),
  };
  let runCounter = 0;
  const checks: ApiChecks = { start: async sha => ({ runId: ++runCounter, targetSha: sha }), lookup: async () => null,
    result: async sha => ({ targetSha: sha, status: 'completed', conclusion: 'success', verifiedSuccess: true }) };
  const options = { db, repository: REPO, baseBranch: BASE, writes };
  const tools = createS7Tools(options, { policy, reads, checks });
  let effect = 0;
  const ctx = () => ({ run_id: run, effect_key: (id * 1000 + ++effect).toString(16).padEnd(64, '0') });
  const commit = (files: Array<{ path: string; content: string }>) => ({ id: 'c', name: 'github_commit_files',
    args: { name, expected_head_sha: head, message: 'u2a', files } });
  const edit = (args: Record<string, unknown>) => ({ id: 'e', name: 'github_replace_text', args: { name, expected_head_sha: head, message: 'u2a', ...args } });
  const openPr = () => ({ id: 'p', name: 'github_open_pr', args: { name, expected_head_sha: head, title: 'u2a' } });
  return { tools, ctx, commit, edit, openPr, committed, commits: () => commits, head: () => head, run };
}

describe('CC8 U2a — B1 : mission fonctionnelle refusée AU COMMIT (guidé et libre)', () => {
  it('un test de démonstration est refusé sans réservation ni commit ; un vrai test passe', async () => {
    const f = await fixture({ mission: 'functional', acceptance: ['Le plan double la valeur.'] });
    await expect(f.tools.execute(f.commit([{ path: 'src/demo/x.spec.ts', content: DEMO }]), f.ctx())).rejects.toThrow(/test_tautological : mission fonctionnelle/);
    expect(f.commits()).toBe(0);
    // Aucune réservation consommée : le premier vrai commit n'attend pas de CI rouge.
    expect(await f.tools.execute(f.commit([{ path: 'src/demo/x.spec.ts', content: REAL }]), f.ctx())).toMatchObject({ corrections_remaining: 3 });
    expect(f.commits()).toBe(1);
  });

  it('tests désactivés ou sans import du dépôt : causes typées ; fichiers source non examinés', async () => {
    const f = await fixture({ mission: 'functional', acceptance: ['x'] });
    await expect(f.tools.execute(f.commit([{ path: 'src/demo/x.spec.ts', content: REAL + "it.skip('plus tard', () => {});\n" }]), f.ctx())).rejects.toThrow('test_disabled');
    await expect(f.tools.execute(f.commit([{ path: 'src/demo/x.spec.ts', content: "import { it, expect } from 'vitest';\nit('x', () => { expect(f()).toBe(1); });\n" }]), f.ctx())).rejects.toThrow('test_no_project_import');
    expect(f.commits()).toBe(0);
    await f.tools.execute(f.commit([{ path: 'src/demo/a.ts', content: 'export const plan = (n: number) => n * 2;\n' }]), f.ctx());
    expect(f.commits()).toBe(1);
  });

  it('même contenu en mission pilote (mandat sans mission) : accepté, comportement historique', async () => {
    const f = await fixture();
    await f.tools.execute(f.commit([{ path: 'src/demo/x.spec.ts', content: DEMO }]), f.ctx());
    expect(f.commits()).toBe(1);
  });

  it('une édition groupée qui produit un test tautologique est refusée de la même façon', async () => {
    const f = await fixture({ mission: 'functional', acceptance: ['x'] });
    TEXTS['src/demo/x.spec.ts'] = DEMO.replace('expect(true).toBe(true)', 'expect(plan(1)).toBe(2)');
    try {
      await expect(f.tools.execute(f.edit({ path: 'src/demo/x.spec.ts', expected_sha: blob('src/demo/x.spec.ts'), old_text: 'expect(plan(1)).toBe(2)', new_text: 'expect(true).toBe(true)' }), f.ctx())).rejects.toThrow('test_tautological');
      expect(f.commits()).toBe(0);
    } finally { TEXTS['src/demo/x.spec.ts'] = "it('x', () => {});"; }
  });
});

describe('CC8 U2a — B2 : un commit sans changement est refusé avant toute réservation', () => {
  it('contenu identique à la tête : api_write_no_change ; fichier neuf ou modifié : accepté', async () => {
    const f = await fixture();
    await expect(f.tools.execute(f.commit([{ path: 'src/demo/a.ts', content: 'alpha beta' }]), f.ctx())).rejects.toThrow('api_write_no_change');
    await expect(f.tools.execute(f.commit([{ path: 'src/demo/a.ts', content: 'alpha beta' }, { path: 'src/demo/b.ts', content: 'gamma delta' }]), f.ctx())).rejects.toThrow('api_write_no_change');
    expect(f.commits()).toBe(0);
    // Un seul fichier modifié suffit ; un fichier neuf (lecture 404) compte comme un changement.
    await f.tools.execute(f.commit([{ path: 'src/demo/a.ts', content: 'alpha beta' }, { path: 'src/demo/b.ts', content: 'gamma CHANGED' }]), f.ctx());
    expect(f.commits()).toBe(1);
  });

  it('un remplacement qui ne change rien (old_text égal à new_text) est refusé ; aucune correction consommée', async () => {
    const f = await fixture();
    await expect(f.tools.execute(f.edit({ path: 'src/demo/a.ts', expected_sha: blob('src/demo/a.ts'), old_text: 'beta', new_text: 'beta' }), f.ctx())).rejects.toThrow('api_write_no_change');
    expect(f.commits()).toBe(0);
    expect(await f.tools.execute(f.commit([{ path: 'src/demo/new.ts', content: 'export {}' }]), f.ctx())).toMatchObject({ corrections_remaining: 3 });
  });
});

describe('CC8 U2a — C1 : plusieurs éditions littérales en UN SEUL commit', () => {
  it('deux fichiers, un commit, contenus attendus', async () => {
    const f = await fixture();
    const result = await f.tools.execute(f.edit({ edits: [
      { path: 'src/demo/a.ts', expected_sha: blob('src/demo/a.ts'), old_text: 'beta', new_text: 'BETA' },
      { path: 'src/demo/b.ts', expected_sha: blob('src/demo/b.ts'), old_text: 'gamma', new_text: 'GAMMA' }] }), f.ctx());
    expect(result).toMatchObject({ next_action: 'github_run_checks' });
    expect(f.commits()).toBe(1);
    expect(f.committed[0]).toEqual([{ path: 'src/demo/a.ts', content: 'alpha BETA' }, { path: 'src/demo/b.ts', content: 'GAMMA delta' }]);
  });

  it('une seule édition obsolète, introuvable ou hors mandat annule tout le lot', async () => {
    const f = await fixture();
    const good = { path: 'src/demo/a.ts', expected_sha: blob('src/demo/a.ts'), old_text: 'beta', new_text: 'BETA' };
    await expect(f.tools.execute(f.edit({ edits: [good, { path: 'src/demo/b.ts', expected_sha: H, old_text: 'gamma', new_text: 'G' }] }), f.ctx())).rejects.toThrow('api_edit_blob_changed');
    await expect(f.tools.execute(f.edit({ edits: [good, { path: 'src/demo/b.ts', expected_sha: blob('src/demo/b.ts'), old_text: 'absent', new_text: 'G' }] }), f.ctx())).rejects.toThrow('api_edit_not_unique');
    await expect(f.tools.execute(f.edit({ edits: [good, { path: 'src/other/b.ts', expected_sha: blob('src/other/b.ts'), old_text: 'gamma', new_text: 'G' }] }), f.ctx())).rejects.toThrow('api_write_outside_task');
    await expect(f.tools.execute(f.edit({ edits: [good], expected_head_sha: 'c'.repeat(40) }), f.ctx())).rejects.toThrow('api_write_head_changed');
    expect(f.commits()).toBe(0);
  });

  it('refus de forme : doublon de chemin, trop d’éditions, mélange avec l’ancienne forme', () => {
    const one = { path: 'src/demo/a.ts', expected_sha: blob('src/demo/a.ts'), old_text: 'a', new_text: 'b' };
    expect(normalizeEdits({ ...one })).toEqual([one]);
    expect(() => normalizeEdits({ edits: [one, one] })).toThrow('api_edit_duplicate_path');
    expect(() => normalizeEdits({ edits: Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({ ...one, path: 'src/demo/f' + i + '.ts' })) })).toThrow('api_edit_count_invalid');
    expect(() => normalizeEdits({ edits: [] })).toThrow('api_edit_count_invalid');
    expect(() => normalizeEdits({ edits: [one], path: 'src/demo/a.ts' })).toThrow('api_edit_ambiguous');
    expect(() => normalizeEdits({ edits: [{ ...one, old_text: 3 }] })).toThrow('api_edit_invalid');
    expect(() => normalizeEdits({})).toThrow('api_edit_unavailable');
  });

  it('forme historique (une édition) inchangée ; deux commits avant CI restent refusés (comptabilité des corrections)', async () => {
    const f = await fixture();
    await f.tools.execute(f.edit({ path: 'src/demo/a.ts', expected_sha: blob('src/demo/a.ts'), old_text: 'alpha', new_text: 'ALPHA' }), f.ctx());
    await expect(f.tools.execute(f.edit({ path: 'src/demo/b.ts', expected_sha: blob('src/demo/b.ts'), old_text: 'delta', new_text: 'DELTA' }), f.ctx())).rejects.toThrow('api_write_wait_for_failed_ci');
    expect(f.commits()).toBe(1);
  });
});

describe('CC8 U2a — B3 : pas de seconde PR pour la même branche', () => {
  it('le 2e github_open_pr est un refus CERTAIN (CONFLICT) et la réconciliation retrouve la PR existante', async () => {
    const f = await fixture();
    await f.tools.execute(f.commit([{ path: 'src/demo/a.ts', content: 'alpha NEW' }]), f.ctx());
    expect(await f.tools.execute(f.openPr(), f.ctx())).toMatchObject({ number: 7, draft: false });
    await expect(f.tools.execute(f.openPr(), f.ctx())).rejects.toThrow('CONFLICT');
    expect(await f.tools.lookup(f.openPr(), f.ctx())).toMatchObject({ found: true, result: { number: 7, status: 'duplicate' } });
  });
});

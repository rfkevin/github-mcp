import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { checkPlan, validateInputs, validateTarget } from './check-plan.mjs';
import { docsOnly, shouldRunChecks } from './changes.mjs';

test('quick utilise une installation et aucun déploiement', () => {
  const plan = checkPlan('quick');
  assert.equal(plan.length, 4);
  assert.equal(plan.some(args => args.some(arg => arg.includes('wrangler'))), false);
});
test('unit ciblé ne lance que le fichier choisi', () => {
  const plan = checkPlan('unit', 'test/oauth.spec.ts');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].at(-1), 'test/oauth.spec.ts');
});
test('full compile uniquement en dry-run', () => {
  const plan = checkPlan('full');
  assert.deepEqual(plan.at(-1).slice(1), ['deploy', '--dry-run', '--outdir', '.release/worker']);
});
for (const target of ['--config=evil', '../foo', 'test/../../key', 'test/a.spec.ts;ls', 'test/a.spec.ts\n', 'test/link\\a.spec.ts', 'test/$(id).spec.ts']) {
  test(`cible refusée : ${JSON.stringify(target)}`, () => assert.throws(() => validateInputs('unit', target)));
}
test('lint et e2e non installés ne prétendent pas être testés', () => {
  assert.throws(() => checkPlan('lint'));
  assert.throws(() => checkPlan('e2e'));
});
test('SHA complet et cible réservée à unit', () => {
  assert.throws(() => validateInputs('unit', '', 'master'));
  assert.throws(() => validateInputs('quick', 'test/oauth.spec.ts'));
  assert.equal(validateInputs('quick', '', 'A'.repeat(40)).sha, 'a'.repeat(40));
});
test('validation du fichier cible réel', () => {
  validateTarget(process.cwd(), 'test/oauth.spec.ts');
  assert.throws(() => validateTarget(process.cwd(), 'test/absent.spec.ts'));
});
test('le filtre de documentation ne saute aucun fichier exécutable ou de configuration', () => {
  assert.equal(docsOnly(['README.md', 'docs/setup.md']), true);
  assert.equal(docsOnly(['AGENT_MEMORY.md']), true);
  for (const file of ['package-lock.json', 'src/index.ts', '.github/workflows/ci.yml', 'wrangler.jsonc', 'docs/example.ts', 'scripts/ci/changes.mjs']) {
    assert.equal(docsOnly(['README.md', file]), false);
  }
  assert.equal(docsOnly([]), false);
});

test('le diff utilise Git absolu, sans shell ni PATH hérité', t => {
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const git = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    assert.equal(file, '/usr/bin/git');
    assert.deepEqual(args, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 30_000);
    assert.deepEqual(options.env, {
      PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    });
    return 'README.md\0docs/setup.md\0';
  });
  assert.equal(shouldRunChecks(base, head), false);
  assert.equal(git.mock.callCount(), 1);
});

test('le diff contenant du code conserve toutes les vérifications', t => {
  t.mock.method(childProcess, 'execFileSync', () => 'README.md\0src/index.ts\0');
  assert.equal(shouldRunChecks('a'.repeat(40), 'b'.repeat(40)), true);
});

test('des références invalides ne lancent aucune commande', t => {
  const git = t.mock.method(childProcess, 'execFileSync', () => 'README.md\0');
  for (const [base, head] of [['', 'b'.repeat(40)], ['a'.repeat(40), '--help'], ['master', 'HEAD']]) {
    assert.equal(shouldRunChecks(base, head), true);
  }
  assert.equal(git.mock.callCount(), 0);
});

test('Git indisponible ou en erreur ne désactive jamais les tests', t => {
  const git = t.mock.method(childProcess, 'execFileSync', () => { throw new Error('ENOENT'); });
  assert.equal(shouldRunChecks('a'.repeat(40), 'b'.repeat(40)), true);
  assert.equal(git.mock.callCount(), 1);
});

test('un diff vide ne permet pas de sauter les tests', t => {
  t.mock.method(childProcess, 'execFileSync', () => '');
  assert.equal(shouldRunChecks('a'.repeat(40), 'b'.repeat(40)), true);
});

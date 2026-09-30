import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, validateInputs, validateTarget } from './check-plan.mjs';
import { docsOnly } from './changes.mjs';

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
  assert.deepEqual(plan.at(-1).slice(-2), ['deploy', '--dry-run']);
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
  for (const file of ['package-lock.json', 'src/index.ts', '.github/workflows/ci.yml', 'wrangler.jsonc', 'docs/example.ts', 'scripts/ci/changes.mjs']) {
    assert.equal(docsOnly(['README.md', file]), false);
  }
  assert.equal(docsOnly([]), false);
});

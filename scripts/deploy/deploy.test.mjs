import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { boundedJson, deploymentConfig, fullSha, positiveId, requireProductionApproval, requireProductionReview, seal, trustedRun, verifyBundle } from './release.mjs';

const SHA = 'a'.repeat(40);
const REPO = 'owner/project';
const baseline = { account_id: 'a'.repeat(32), name: 'github-mcp', vars: { PUBLIC_ORIGIN: 'https://github-mcp.example' },
  kv_namespaces: [{ binding: 'OAUTH_KV', id: 'b'.repeat(32) }], previews: { kv_namespaces: [{ id: 'c'.repeat(32) }] } };
const env = { CF_ACCOUNT_ID: baseline.account_id, CF_WORKER_NAME: 'github-mcp-staging', CF_KV_NAMESPACE_ID: 'd'.repeat(32),
  PUBLIC_ORIGIN: 'https://staging.example', ALLOWED_GITHUB_USER_IDS: '123', GITHUB_APP_ID: '1',
  GITHUB_INSTALLATION_ID: '2', GITHUB_OAUTH_CLIENT_ID: 'client' };
const manifest = { sha: SHA, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'] };
const run = { status: 'completed', conclusion: 'success', head_branch: 'master', head_sha: SHA,
  event: 'push', path: '.github/workflows/ci.yml', head_repository: { full_name: REPO } };
const protectedEnvironment = { id: 321, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 123 } }] }],
  deployment_branch_policy: { protected_branches: true }, can_admins_bypass: false };

test('staging ne réutilise ni Worker ni origine ni KV de production ou preview', () => {
  const config = deploymentConfig(manifest, 'staging', env, baseline);
  assert.equal(config.main, 'worker/index.js');
  assert.equal(config.no_bundle, true);
  assert.equal(config.find_additional_modules, false);
  assert.equal(config.vars.BUILD_SHA, SHA);
  assert.equal(config.vars.GITHUB_WRITES_ENABLED, 'false');
  assert.equal(config.vars.GITHUB_CHECKS_CONFIG, '');
  assert.equal(config.vars.GITHUB_AUTOMATION_ENABLED, 'false');
  assert.equal(deploymentConfig(manifest, 'staging', { ...env, GITHUB_AUTOMATION_ENABLED: 'true' }, baseline).vars.GITHUB_AUTOMATION_ENABLED, 'true');
  assert.throws(() => deploymentConfig(manifest, 'staging', { ...env, GITHUB_AUTOMATION_ENABLED: 'yes' }, baseline));
  for (const change of [{ CF_WORKER_NAME: baseline.name }, { PUBLIC_ORIGIN: baseline.vars.PUBLIC_ORIGIN },
    { CF_KV_NAMESPACE_ID: 'b'.repeat(32) }, { CF_KV_NAMESPACE_ID: 'c'.repeat(32) }]) {
    assert.throws(() => deploymentConfig(manifest, 'staging', { ...env, ...change }, baseline));
  }
});
test('production exige la destination exacte et une configuration complète', () => {
  const prod = { ...env, CF_WORKER_NAME: baseline.name, PUBLIC_ORIGIN: baseline.vars.PUBLIC_ORIGIN, CF_KV_NAMESPACE_ID: 'b'.repeat(32) };
  assert.equal(deploymentConfig(manifest, 'production', prod, baseline).name, baseline.name);
  for (const change of [{ CF_ACCOUNT_ID: 'f'.repeat(32) }, { CF_WORKER_NAME: 'elsewhere' }, { PUBLIC_ORIGIN: 'http://wrong' },
    { PUBLIC_ORIGIN: 'https://u:p@wrong/' }, { GITHUB_APP_ID: 'abc' }, { GITHUB_WRITES_ENABLED: 'yes' }, { CF_KV_NAMESPACE_ID: '' }]) {
    assert.throws(() => deploymentConfig(manifest, 'production', { ...prod, ...change }, baseline));
  }
});
test('un environnement nommé production sans protection est refusé', () => {
  requireProductionReview(protectedEnvironment, { protected: true });
  assert.throws(() => requireProductionReview({}, { protected: true }));
  assert.throws(() => requireProductionReview(protectedEnvironment, { protected: false }));
  assert.throws(() => requireProductionReview({ ...protectedEnvironment, can_admins_bypass: true }, { protected: true }));
  assert.throws(() => requireProductionReview({ ...protectedEnvironment, protection_rules: [] }, { protected: true }));
});
test('refuse des artefacts de PR, fork, autre workflow, branche ou exécution en échec', () => {
  trustedRun(run, REPO, '.github/workflows/ci.yml');
  for (const change of [{ event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' },
    { head_branch: 'mcp/123/fix' }, { path: '.github/workflows/other.yml' }, { head_sha: 'master' },
    { head_repository: { full_name: 'attacker/fork' } }]) {
    assert.throws(() => trustedRun({ ...run, ...change }, REPO, '.github/workflows/ci.yml'));
  }
});
test('la production exige une approbation réelle du bon humain et du bon environnement', () => {
  const review = { state: 'approved', user: { id: 123, type: 'User' }, environments: [{ id: 321, name: 'production' }] };
  requireProductionApproval(protectedEnvironment, [review]);
  assert.throws(() => requireProductionApproval(protectedEnvironment, []));
  for (const change of [{ state: 'rejected' }, { user: { id: 123, type: 'Bot' } }, { user: { id: 999, type: 'User' } },
    { environments: [{ id: 321, name: 'staging' }] }, { environments: [{ id: 999, name: 'production' }] }]) {
    assert.throws(() => requireProductionApproval(protectedEnvironment, [{ ...review, ...change }]));
  }
});
test('n’autorise aucune expression dans les identifiants ni les SHA', () => {
  for (const value of ['--help', '12\nnext=value', '../123', '0', '1;curl']) assert.throws(() => positiveId(value));
  for (const value of ['master', 'HEAD^', 'a'.repeat(39), `${SHA}\n`]) assert.throws(() => fullSha(value));
});
test('les réponses réseau sont bornées même sans Content-Length', async () => {
  await assert.rejects(() => boundedJson(new Response('x'.repeat(200)), 100));
  assert.deepEqual(await boundedJson(Response.json({ ok: true }), 100), { ok: true });
});
test('le paquet est lié à la CI, au dépôt, au SHA et aux octets réellement compilés', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'github-mcp-release-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true }); });
  mkdirSync(resolve(root, 'worker'));
  writeFileSync(resolve(root, 'worker/index.js'), 'export default { fetch() {} };');
  seal(root, { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GITHUB_RUN_ID: '123' });
  assert.equal(verifyBundle(root, REPO, '123', SHA).sha, SHA);
  assert.throws(() => verifyBundle(root, 'other/project', '123', SHA));
  assert.throws(() => verifyBundle(root, REPO, '456', SHA));
  assert.throws(() => verifyBundle(root, REPO, '123', 'b'.repeat(40)));
  writeFileSync(resolve(root, 'worker/index.js'), 'modified');
  assert.throws(() => verifyBundle(root, REPO, '123', SHA));
});
test('les workflows n’exposent le jeton Cloudflare qu’à la publication', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const checks = readFileSync('.github/workflows/agent-checks.yml', 'utf8');
  const publish = readFileSync('.github/workflows/publish-worker.yml', 'utf8');
  assert.equal(ci.includes('CLOUDFLARE_API_TOKEN'), false);
  assert.equal(checks.includes('secrets.'), false);
  assert.equal(publish.match(/secrets\.CLOUDFLARE_API_TOKEN/g)?.length, 1);
  assert.match(publish, /environment:\s+name: \$\{\{ inputs.stage \}\}/);
  assert.match(publish, /--no-bundle/);
  assert.match(publish, /digest-mismatch: error/);
  for (const file of ['ci.yml', 'deploy-staging.yml', 'deploy-production.yml', 'publish-worker.yml']) {
    const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
    for (const use of workflow.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(use[1], /@[a-f0-9]{40}$/);
  }
});

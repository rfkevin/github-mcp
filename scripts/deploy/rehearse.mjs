// Répétition locale sans publication ni requête à l'API GitHub.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deploymentConfig, seal, verifyBundle } from './release.mjs';

const root = resolve('.release');
const baseline = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const fixture = { GITHUB_REPOSITORY: 'local/rehearsal', GITHUB_SHA: '0'.repeat(40), GITHUB_RUN_ID: '1' };
seal(root, fixture);
const manifest = verifyBundle(root, fixture.GITHUB_REPOSITORY, fixture.GITHUB_RUN_ID, fixture.GITHUB_SHA);
for (const stage of ['staging', 'production']) {
  const variables = { ...baseline.vars, CF_ACCOUNT_ID: baseline.account_id, CF_WORKER_NAME: baseline.name,
    CF_KV_NAMESPACE_ID: baseline.kv_namespaces.find(item => item.binding === 'OAUTH_KV').id };
  if (stage === 'staging') Object.assign(variables, { CF_WORKER_NAME: 'github-mcp-staging',
    CF_KV_NAMESPACE_ID: 'd'.repeat(32), PUBLIC_ORIGIN: 'https://staging.example.invalid' });
  const file = `.release/rehearsal-${stage}.json`;
  writeFileSync(file, JSON.stringify(deploymentConfig(manifest, stage, variables, baseline), null, 2));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  delete environment.CLOUDFLARE_API_TOKEN;
  delete environment.CLOUDFLARE_API_KEY;
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy',
    '--config', file, '--no-bundle', '--dry-run'], { shell: false, stdio: 'inherit', timeout: 120_000, env: environment });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log('Paquet et configurations staging/production vérifiés localement. Aucun déploiement.');

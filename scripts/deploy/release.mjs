import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function fullSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new Error('SHA complet requis.');
  return value.toLowerCase();
}
export function positiveId(value) {
  if (!/^[1-9][0-9]{0,18}$/.test(String(value))) throw new Error('Identifiant GitHub invalide.');
  return String(value);
}
export function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.includes('..')) throw new Error('Dépôt invalide.');
  return value;
}
const hash = value => createHash('sha256').update(value).digest('hex');
function workerFiles(root, dir = '') {
  if (lstatSync(resolve(root, dir)).isSymbolicLink()) throw new Error('Dossier lié interdit dans le paquet.');
  const files = [];
  for (const entry of readdirSync(resolve(root, dir))) {
    if (!/^[A-Za-z0-9_.-]+$/.test(entry) || entry.startsWith('.')) throw new Error('Nom de fichier de paquet invalide.');
    const path = dir ? `${dir}/${entry}` : entry;
    const stat = lstatSync(resolve(root, path));
    if (stat.isSymbolicLink()) throw new Error('Lien interdit dans le paquet.');
    if (stat.isDirectory()) files.push(...workerFiles(root, path));
    else if (stat.isFile() && stat.size <= 10_000_000) files.push({ path, sha256: hash(readFileSync(resolve(root, path))) });
    else throw new Error('Fichier de paquet invalide.');
  }
  if (files.length > 50) throw new Error('Trop de fichiers dans le paquet.');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export function seal(root, env = process.env) {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const manifest = { version: 1, repository: repositoryName(env.GITHUB_REPOSITORY), sha: fullSha(env.GITHUB_SHA),
    ciRunId: positiveId(env.GITHUB_RUN_ID), compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags, files: workerFiles(resolve(root, 'worker')) };
  if (!manifest.files.some(file => file.path === 'index.js')) throw new Error('Worker compilé absent.');
  writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
export function verifyBundle(root, repository, ciRunId, sha) {
  const stat = lstatSync(resolve(root, 'manifest.json'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000) throw new Error('Manifest non régulier ou trop volumineux.');
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.repository !== repositoryName(repository) ||
      manifest.ciRunId !== positiveId(ciRunId) || manifest.sha !== fullSha(sha) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(manifest.compatibilityDate) ||
      !Array.isArray(manifest.compatibilityFlags) ||
      manifest.compatibilityFlags.some(flag => !['nodejs_compat', 'global_fetch_strictly_public'].includes(flag)) ||
      !manifest.compatibilityFlags.includes('nodejs_compat') ||
      !manifest.files?.some(file => file.path === 'index.js') ||
      JSON.stringify(manifest.files) !== JSON.stringify(workerFiles(resolve(root, 'worker')))) {
    throw new Error('Paquet absent, altéré ou provenance incorrecte.');
  }
  return manifest;
}
export function deploymentConfig(manifest, stage, env, baseline) {
  if (!['staging', 'production'].includes(stage)) throw new Error('Environnement invalide.');
  const required = ['CF_ACCOUNT_ID', 'CF_WORKER_NAME', 'CF_KV_NAMESPACE_ID', 'PUBLIC_ORIGIN',
    'ALLOWED_GITHUB_USER_IDS', 'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_OAUTH_CLIENT_ID'];
  for (const key of required) if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error(`Variable absente : ${key}.`);
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.CF_WORKER_NAME) ||
      !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID) || !/^[a-f0-9]{32}$/.test(env.CF_KV_NAMESPACE_ID) ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID) || !/^[1-9][0-9]*$/.test(env.GITHUB_INSTALLATION_ID) ||
      !env.ALLOWED_GITHUB_USER_IDS.split(',').every(id => /^[1-9][0-9]*$/.test(id.trim()))) throw new Error('Configuration de déploiement invalide.');
  const productionKv = baseline.kv_namespaces.find(item => item.binding === 'OAUTH_KV').id;
  if (stage === 'production' && env.CF_ACCOUNT_ID !== baseline.account_id) throw new Error('Compte Cloudflare inattendu.');
  if (stage === 'production' && (env.CF_WORKER_NAME !== baseline.name || origin.origin !== baseline.vars.PUBLIC_ORIGIN ||
      env.CF_KV_NAMESPACE_ID !== productionKv)) throw new Error('La destination production ne correspond pas au dépôt.');
  if (stage === 'staging' && (env.CF_WORKER_NAME === baseline.name || origin.origin === baseline.vars.PUBLIC_ORIGIN ||
      env.CF_KV_NAMESPACE_ID === productionKv || baseline.previews.kv_namespaces.some(item => item.id === env.CF_KV_NAMESPACE_ID))) {
    throw new Error('Staging doit avoir son propre Worker, sa propre origine et son propre KV.');
  }
  const writes = env.GITHUB_WRITES_ENABLED || 'false';
  const automation = env.GITHUB_AUTOMATION_ENABLED || 'false';
  if (!['true', 'false'].includes(automation)) throw new Error('Interrupteur automatisation invalide.');
  if (!['true', 'false'].includes(writes)) throw new Error('Interrupteur écritures invalide.');
  const checks = env.GITHUB_CHECKS_CONFIG || '';
  if (checks) JSON.parse(checks); // Le Worker applique en plus son schéma strict au démarrage.
  return { name: env.CF_WORKER_NAME, account_id: env.CF_ACCOUNT_ID, main: 'worker/index.js',
    compatibility_date: manifest.compatibilityDate, compatibility_flags: manifest.compatibilityFlags,
    no_bundle: true, find_additional_modules: false, workers_dev: true, preview_urls: false,
    kv_namespaces: [{ binding: 'OAUTH_KV', id: env.CF_KV_NAMESPACE_ID }],
    vars: { ...Object.fromEntries(required.slice(3).map(key => [key, env[key]])),
      BUILD_SHA: manifest.sha, GITHUB_WRITES_ENABLED: writes, GITHUB_CHECKS_CONFIG: checks,
      GITHUB_AUTOMATION_ENABLED: automation },
    observability: { enabled: true }, upload_source_maps: true };
}
export function requireProductionReview(environment, branch) {
  const reviewers = environment.protection_rules?.find(rule => rule.type === 'required_reviewers')?.reviewers;
  if (!reviewers?.length || !environment.deployment_branch_policy?.protected_branches || branch.protected !== true ||
      environment.can_admins_bypass === true) throw new Error('Production exige des relecteurs et des branches protégées, sans contournement administrateur.');
}
/** Vérifier aussi l'approbation réelle : le nom de l'environnement ne suffit pas. */
export function requireProductionApproval(environment, reviews) {
  const reviewers = environment.protection_rules?.find(rule => rule.type === 'required_reviewers')?.reviewers ?? [];
  const allowed = new Set(reviewers.filter(item => item.type === 'User').map(item => item.reviewer.id));
  if (!Array.isArray(reviews) || !reviews.some(review => review.state === 'approved' &&
      review.user?.type === 'User' && allowed.has(review.user.id) &&
      review.environments?.some(item => item.id === environment.id && item.name === 'production'))) {
    throw new Error('Approbation production par un relecteur humain nommé introuvable.');
  }
}
export function trustedRun(run, repository, path) {
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.head_branch !== 'master' ||
      run.head_repository?.full_name !== repository || run.path?.split('@')[0] !== path ||
      !['push', 'workflow_run', 'workflow_dispatch'].includes(run.event)) throw new Error('Exécution non fiable ou non réussie.');
  fullSha(run.head_sha);
  return run;
}
async function github(path, env = process.env) {
  if (!env.GH_TOKEN) throw new Error('Jeton de lecture GitHub absent.');
  const response = await fetch(`https://api.github.com/repos/${repositoryName(env.GITHUB_REPOSITORY)}${path}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Vérification GitHub impossible (${response.status}).`);
  return boundedJson(response);
}
export async function boundedJson(response, maxBytes = 2_000_000) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Réponse JSON absente.');
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('Réponse trop grande.'); }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
async function main() {
  const [command, stage] = process.argv.slice(2);
  const root = resolve('.release');
  const env = process.env;
  const repo = repositoryName(env.GITHUB_REPOSITORY);
  if (command === 'seal') { seal(root); return; }
  if (!['staging', 'production'].includes(stage)) throw new Error('Environnement invalide.');
  if (command === 'select') {
    if (env.GITHUB_REF !== 'refs/heads/master') throw new Error('Le contrôleur doit provenir de master.');
    const id = positiveId(env.SOURCE_RUN_ID);
    const run = trustedRun(await github(`/actions/runs/${id}`), repo,
      stage === 'production' ? '.github/workflows/deploy-staging.yml' : '.github/workflows/ci.yml');
    if (stage === 'staging' && run.event !== 'push') throw new Error('La CI doit provenir d’un push sur master.');
    const branch = await github('/branches/master');
    if (!branch.protected) throw new Error('master doit être protégée.');
    if (stage === 'staging' && branch.commit.sha !== run.head_sha) throw new Error('CI périmée : master a avancé.');
    if (stage === 'production') requireProductionReview(await github('/environments/production'), branch);
    const artifacts = await github(`/actions/runs/${id}/artifacts?per_page=100`);
    const name = stage === 'production' ? 'staged-release' : 'worker-release';
    const artifact = artifacts.artifacts?.filter(item => item.name === name && !item.expired);
    if (artifacts.total_count > 100 || artifact?.length !== 1) throw new Error('Artefact unique non expiré requis.');
    output('artifact_id', positiveId(artifact[0].id));
    return;
  }
  const manifestStat = lstatSync(resolve(root, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32_000) throw new Error('Manifest invalide.');
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  const ci = trustedRun(await github(`/actions/runs/${positiveId(manifest.ciRunId)}`), repo, '.github/workflows/ci.yml');
  if (ci.event !== 'push') throw new Error('CI de publication invalide.');
  verifyBundle(root, repo, manifest.ciRunId, ci.head_sha);
  if (stage === 'production') {
    const receipt = JSON.parse(readFileSync(resolve(root, 'staging.json'), 'utf8'));
    if (receipt.runId !== positiveId(env.SOURCE_RUN_ID) || receipt.ciRunId !== manifest.ciRunId || receipt.sha !== manifest.sha || receipt.repository !== repo) throw new Error('Preuve staging incorrecte.');
    trustedRun(await github(`/actions/runs/${positiveId(receipt.runId)}`), repo, '.github/workflows/deploy-staging.yml');
    const production = await github('/environments/production');
    requireProductionReview(production, await github('/branches/master'));
    requireProductionApproval(production, await github(`/actions/runs/${positiveId(env.GITHUB_RUN_ID)}/approvals`));
  } else {
    if (manifest.ciRunId !== positiveId(env.SOURCE_RUN_ID)) throw new Error('CI source incorrecte.');
    if (command === 'prepare' && (await github('/branches/master')).commit.sha !== manifest.sha) throw new Error('Staging périmé : master a avancé.');
  }
  if (command === 'prepare') {
    const baseline = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
    const config = deploymentConfig(manifest, stage, env, baseline);
    writeFileSync(resolve(root, 'deploy.json'), JSON.stringify(config, null, 2));
    return;
  }
  if (command !== 'smoke') throw new Error('Commande de publication invalide.');
  const origin = new URL(env.PUBLIC_ORIGIN).origin;
  for (const path of ['/ready', '/.well-known/oauth-authorization-server', '/mcp']) {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (path === '/mcp') {
      if (response.status !== 401) throw new Error('MCP doit refuser une requête sans authentification.');
      await response.body?.cancel();
    } else {
      if (!response.ok) throw new Error(`Sonde ${path} refusée (${response.status}).`);
      const body = await boundedJson(response, 64_000);
      if (path === '/ready' && (body.status !== 'ready' || body.sha !== manifest.sha)) throw new Error('Version publiée différente du paquet attendu.');
      if (path.includes('well-known') && body.issuer !== origin) throw new Error('Émetteur OAuth incorrect.');
    }
  }
  if (stage === 'staging') writeFileSync(resolve(root, 'staging.json'), JSON.stringify({ repository: repo,
    runId: positiveId(env.GITHUB_RUN_ID), ciRunId: manifest.ciRunId, sha: manifest.sha }));
  console.log(`Sondes publiques réussies : ${manifest.sha}. OAuth authentifié et outils restent à tester.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Publication impossible.'); process.exitCode = 1; });
}

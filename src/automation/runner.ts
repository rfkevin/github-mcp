/** Exécuteur embarqué dans le workflow : aucun script de contrôle chargé depuis la cible. */
export const CHECK_RUNNER = String.raw`const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const fail = message => { throw new Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const root = fs.realpathSync(process.cwd());
const planPath = path.join(root, '.mcp/checks.json');
// Ne pas suivre de lien vers un fichier extérieur au checkout.
for (const file of [path.join(root, '.mcp'), planPath]) {
  if (fs.lstatSync(file).isSymbolicLink()) fail('Plan symbolique interdit');
}
if (fs.statSync(planPath).size > 64000) fail('Plan trop volumineux');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (!plain(plan) || plan.version !== 1 || Object.keys(plan).some(key => !['version', 'workingDirectory', 'install', 'checks'].includes(key))) fail('Plan invalide');
const directory = plan.workingDirectory ?? '.';
if (typeof directory !== 'string' || directory.length > 240 || !/^(?:\.|[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*)$/.test(directory) || directory.split('/').includes('..')) fail('Dossier invalide');
const cwd = fs.realpathSync(path.join(root, directory));
if (cwd !== root && !cwd.startsWith(root + path.sep)) fail('Dossier hors checkout');
const validCommands = (commands, min, max) => Array.isArray(commands) && commands.length >= min && commands.length <= max && commands.every(command => typeof command === 'string' && command.trim().length > 0 && command.length <= 4000 && !command.includes(String.fromCharCode(0)));
if (!plain(plan.checks) || !Object.hasOwn(plan.checks, 'quick') || Object.keys(plan.checks).length > 8 || Object.entries(plan.checks).some(([name, commands]) => !/^[a-z][a-z0-9-]{0,31}$/.test(name) || !validCommands(commands, 1, 12))) fail('Profils invalides');
if (!validCommands(plan.install ?? [], 0, 8)) fail('Installation invalide');
const scope = process.env.CHECK_SCOPE || 'quick';
const target = process.env.CHECK_TARGET || '';
if (!/^[a-z][a-z0-9-]{0,31}$/.test(scope) || !Object.hasOwn(plan.checks, scope)) fail('Profil absent');
if (target && (target.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(target) || target.split('/').some(part => !part || part === '.' || part === '..'))) fail('Cible invalide');
const sha = process.env.CHECK_SHA;
if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) fail('Commit invalide');
const actual = cp.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actual.toLowerCase() !== sha.toLowerCase()) fail('Commit inattendu');
// Le titre du run seul ne prouve pas les paramètres : vérifier leur empreinte ici.
if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) fail('Dépôt invalide');
  const key = require('node:crypto').createHash('sha256').update(JSON.stringify([
    'mcp-checks-v1', repository.toLowerCase(), sha.toLowerCase(), scope, target
  ])).digest('hex');
  if (key !== process.env.CHECK_REQUEST_ID) fail('Paramètres non corrélés');
}
// Pas de credentials de checkout persistés, pas de secrets, pas de cache partagé.
// Les commandes sont du code non fiable, PAS une preuve de sécurité du projet.
const env = { ...process.env, CI: 'true', CHECK_TARGET: target };
for (const name of Object.keys(env)) {
  if (/TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name.startsWith('ACTIONS_') || ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'].includes(name)) delete env[name];
}
for (const command of [...(plan.install ?? []), ...plan.checks[scope]]) {
  cp.execFileSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], { cwd, env, stdio: 'inherit', timeout: 600000 });
}
console.log('Vérifications terminées pour ' + sha + ' (' + scope + ')');`;

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const SCOPES = Object.freeze(['quick', 'typecheck', 'unit', 'full']);
export const PLAN_VERSION = '1';

export function validateInputs(scope, target = '', sha) {
  if (!SCOPES.includes(scope)) throw new Error('Périmètre invalide : quick, typecheck, unit ou full.');
  if (sha !== undefined && !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Un SHA complet de 40 caractères est obligatoire.');
  if (typeof target !== 'string' || target.length > 240 ||
      (target && (!/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.spec\.ts$/.test(target) || target.includes('..')))) {
    throw new Error('Cible invalide : un fichier test/*.spec.ts, sans option ni traversée de dossier.');
  }
  if (target && scope !== 'unit') throw new Error('La cible est réservée au périmètre unit.');
  return { scope, target, sha: sha?.toLowerCase(), version: PLAN_VERSION };
}

export function validateTarget(root, target) {
  if (!target) return;
  const actualRoot = realpathSync(resolve(root, 'test'));
  const actualFile = realpathSync(resolve(root, target));
  const rel = relative(actualRoot, actualFile);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(actualFile).isFile()) {
    throw new Error('La cible doit être un fichier dans le dossier test, sans lien sortant.');
  }
}

/** Arguments séparés : aucun shell, téléchargement npx ou commande fournie par l’agent. */
export function checkPlan(scope, target = '') {
  validateInputs(scope, target);
  const commands = [];
  if (scope !== 'unit') {
    commands.push(['node_modules/typescript/bin/tsc', '--noEmit']);
    commands.push(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'test/tsconfig.json']);
  }
  if (scope !== 'typecheck') {
    commands.push(['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', '--reporter=github-actions', ...(target ? [target] : [])]);
    if (!target) commands.push(['--test', 'scripts/ci/checks.test.mjs']);
  }
  if (scope === 'full') commands.push(['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run']);
  return commands;
}

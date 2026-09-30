import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Seuls les documents non exécutables permettent d'éviter l'installation. */
export function docsOnly(paths) {
  return paths.length > 0 && paths.every(path =>
    path === 'README.md' || path === 'AGENTS.md' || path === 'LICENSE' || /^docs\/[^\r\n]+\.md$/.test(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let skip = false;
  try {
    const base = process.env.CHECK_BASE ?? '';
    const head = process.env.CHECK_HEAD ?? '';
    if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head)) throw new Error('Invalid refs');
    const diff = execFileSync('git', ['diff', '--name-only', '-z', base, head, '--'], { encoding: 'utf8', maxBuffer: 2_000_000 });
    skip = docsOnly(diff.split('\0').filter(Boolean));
  } catch {
    // Historique incomplet, premier push, taille excessive : exécuter tous les tests.
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${!skip}\n`);
  console.log(skip ? 'Documentation seulement : vérifications de code non nécessaires.' : 'Vérifications complètes nécessaires.');
}

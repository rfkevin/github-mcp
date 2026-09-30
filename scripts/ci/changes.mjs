import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Seuls les documents non exécutables permettent d'éviter l'installation. */
export function docsOnly(paths) {
  return paths.length > 0 && paths.every(path =>
    path === 'README.md' || path === 'AGENTS.md' || path === 'AGENT_MEMORY.md' || path === 'LICENSE' || /^docs\/[^\r\n]+\.md$/.test(path));
}

/** Ce détecteur vise le runner Ubuntu du workflow, pas un Git découvert dans PATH. */
export function shouldRunChecks(base, head) {
  try {
    if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head)) throw new Error('Invalid refs');
    const diff = childProcess.execFileSync('/usr/bin/git',
      ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head, '--'], {
        encoding: 'utf8', maxBuffer: 2_000_000, timeout: 30_000, shell: false,
        // Répertoires système du runner ; aucun PATH/config Git hérité du job.
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    return !docsOnly(diff.split('\0').filter(Boolean));
  } catch {
    // Git absent (notamment Windows), historique incomplet ou autre doute : tous les tests.
    return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = shouldRunChecks(process.env.CHECK_BASE ?? '', process.env.CHECK_HEAD ?? '');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(run ? 'Vérifications complètes nécessaires.' : 'Documentation seulement : vérifications de code non nécessaires.');
}

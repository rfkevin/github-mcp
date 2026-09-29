// Opt-in, read-only smoke test. Never run as part of the automated test suite.
// Usage: node test/manual/github-live.mjs <app-id> <installation-id> <key-path>
import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function main() {
  const [appId, installationId, keyPath] = process.argv.slice(2);
  if (!/^\d+$/.test(appId ?? '') || !/^\d+$/.test(installationId ?? '') || !keyPath) {
    throw new Error('Arguments invalides');
  }
  // Convert GitHub's PKCS#1 download in memory. No additional key file is written.
  const privateKey = createPrivateKey(await readFile(keyPath)).export({ type: 'pkcs8', format: 'pem' });
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../src/github/client.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
  });
  const { GitHubClient } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const client = new GitHubClient({
    appId, installationId, privateKey, policy: { readOnly: true },
    tokenPermissions: { metadata: 'read' },
    fetcher: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const tokenRequest = method === 'POST' && url.pathname === `/app/installations/${installationId}/access_tokens`;
      const repositoryRequest = method === 'GET' && url.pathname === '/installation/repositories';
      if (url.origin !== 'https://api.github.com' || !(tokenRequest || repositoryRequest)) {
        throw new Error('Requête hors périmètre');
      }
      return fetch(input, { ...init, redirect: 'error' });
    },
  });
  const repositories = await client.repositories.listInstallationRepositories();
  console.log(JSON.stringify({ success: true, repositories }, null, 2));
}

main().catch(error => {
  // Do not print raw errors: bundled stack traces and response bodies may be sensitive.
  console.error(JSON.stringify({ success: false, status: typeof error?.status === 'number' ? error.status : null,
    message: 'Le test GitHub a échoué. Vérifier les identifiants, la clé et la connexion.' }));
  process.exitCode = 1;
});

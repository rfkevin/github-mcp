import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// Chrome also checks redirects following a form submission. Include the upstream
// provider and the already-validated client's origin (used when consent is denied).
export function consentPolicy(validatedRedirectUri: string): string {
  const origin = new URL(validatedRedirectUri).origin;
  const sources = ["'self'", 'https://github.com'];
  // Only serialize a literal HTTP(S) origin, never arbitrary CSP syntax or a wildcard.
  if (/^https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::[0-9]+)?$/.test(origin)) sources.push(origin);
  return `default-src 'none'; form-action ${sources.join(' ')}; frame-ancestors 'none'; base-uri 'none'`;
}

export function consentPage(details: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser GitHub MCP</title><h1>Autoriser ${escape(details.clientName)} ?</h1>
<p>${details.clientDomain ? `Domaine du client : ${escape(details.clientDomain)}` :
    'Le nom de cette application est déclaré par le client et n’est pas vérifié.'}</p>
<p>L’accès sera remis à : <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>Application locale : continuez uniquement si vous venez de lancer cette connexion sur votre ordinateur.</p>' : ''}
<p>Ce client pourra lire les dépôts sélectionnés dans la GitHub App et leurs contrôles. Il ne pourra ni modifier le code, ni fusionner, ni déployer en production.</p>
${details.scope.includes('mcp:checks') ? '<p>Vous autorisez aussi le lancement du workflow agent-checks sur les dépôts explicitement configurés. Cela exécute des tests et peut consommer des minutes GitHub Actions. Aucun autre workflow n’est autorisé.</p>' : '<p>Aucun lancement de workflow n’est autorisé par ce consentement.</p>'}
<p>Permissions : ${details.scope.map(escape).join(', ')}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Autoriser et se connecter à GitHub</button>
<button name="decision" value="deny">Refuser</button></form></html>`;
}

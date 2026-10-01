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
<p>Ce client pourra lire les dépôts sélectionnés dans la GitHub App et leurs contrôles.</p>
${details.scope.includes('mcp:write') ? '<p>Vous autorisez aussi la création de branches de travail liées à votre identité, des commits comprenant des ajouts, modifications et suppressions de fichiers, des PR (en brouillon par défaut) et des commentaires sur les commits et PR ouvertes, y compris ceux d’autres collaborateurs, dans les dépôts de cette installation. Les branches protégées et les fichiers sensibles, de contrôle CI ou de publication restent interdits. Ces actions peuvent déclencher la CI ou les déploiements automatiques déjà configurés dans ces dépôts. Vérifiez ces automatisations avant d’accepter.</p>' : '<p>Ce consentement ne permet pas de modifier le code.</p>'}
${details.scope.includes('mcp:integration') && details.scope.includes('mcp:write') ? '<p>Vous autorisez séparément la fusion de code uniquement vers integration dans les dépôts dont vous avez installé la politique .mcp/integration.json sur la branche principale. Elle exige les contrôles et accords déclarés configurés. Des noms différents ne prouvent pas des agents indépendants. Cette fusion peut déclencher les automatisations du dépôt : integration ne doit pas publier en production.</p>' : '<p>Aucun outil de fusion n’est autorisé par ce consentement.</p>'}
<p>Aucune fusion vers main/master ou la branche par défaut, aucune approbation GitHub de PR, fermeture de PR ou publication directe n’est exposée.</p>
${details.scope.includes('mcp:automation') ? '<p>Vous autorisez les vérifications multi-dépôts : lancement du workflow de tests mcp-checks et, avec le droit d’écriture, préparation de ce workflow et des commandes du projet sur vos branches. Les commandes exécutent le code du projet sur un runner GitHub hébergé, sans secret ajouté. Elles consomment des minutes Actions et peuvent déclencher des intégrations déjà présentes. Les dépôts accessibles restent ceux de votre installation GitHub App, y compris ceux ajoutés ultérieurement.</p>' : ''}
${details.scope.includes('mcp:checks') ? '<p>Vous autorisez aussi le lancement du workflow agent-checks sur les dépôts explicitement configurés. Cela exécute des tests et peut consommer des minutes GitHub Actions.</p>' : details.scope.includes('mcp:automation') ? '' : '<p>Aucun lancement direct de workflow n’est autorisé par ce consentement.</p>'}
<p>Permissions : ${details.scope.map(escape).join(', ')}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Autoriser et se connecter à GitHub</button>
<button name="decision" value="deny">Refuser</button></form></html>`;
}

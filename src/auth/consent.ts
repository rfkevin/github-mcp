import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

export function consentPage(details: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autoriser GitHub MCP</title><h1>Autoriser ${escape(details.clientName)} ?</h1>
<p>${details.clientDomain ? `Domaine du client : ${escape(details.clientDomain)}` :
    'Le nom de cette application est déclaré par le client et n’est pas vérifié.'}</p>
<p>L’accès sera remis à : <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>Application locale : continuez uniquement si vous venez de lancer cette connexion sur votre ordinateur.</p>' : ''}
<p>Ce client pourra lister les dépôts sélectionnés dans la GitHub App. Aucun outil d’écriture n’est exposé.</p>
<p>Permissions : ${details.scope.map(escape).join(', ')}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Autoriser et se connecter à GitHub</button>
<button name="decision" value="deny">Refuser</button></form></html>`;
}

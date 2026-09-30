/** Une activation globale, jamais une liste de dépôts maintenue dans le Worker. */
export function automationEnabled(value?: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('GITHUB_AUTOMATION_ENABLED doit valoir true ou false.');
}

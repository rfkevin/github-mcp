/** Interrupteur global uniquement ; les dépôts restent ceux de l'installation GitHub. */
export function writesEnabled(value?: string): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('GITHUB_WRITES_ENABLED doit valoir true ou false.');
}

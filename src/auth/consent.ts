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

// La page n'a besoin que de styles en ligne : ni script, ni image, ni police, ni requête
// réseau. default-src 'none' reste en vigueur pour tout le reste.
export function consentPagePolicy(validatedRedirectUri: string): string {
  return `${consentPolicy(validatedRedirectUri)}; style-src 'unsafe-inline'`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#eef2f1;--card:#fff;--ink:#10201f;--muted:#4f605e;--line:#d6dfdd;--accent:#0f766e;--accent-ink:#fff;--warn-edge:#d97706;--warn-bg:#fff7e8}
@media (prefers-color-scheme:dark){:root{--bg:#0a1211;--card:#101b1a;--ink:#e7f0ee;--muted:#9bafac;--line:#223a38;--accent:#5eead4;--accent-ink:#06201d;--warn-edge:#f59e0b;--warn-bg:#241a08}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:30px 28px}
.mark{display:block;margin-bottom:16px;color:var(--accent)}
h1{margin:0;font:600 1.65rem/1.2 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;letter-spacing:-.01em;overflow-wrap:anywhere}
.sub{margin:8px 0 0;color:var(--muted);font-size:.92rem;overflow-wrap:anywhere}
.dest{margin:18px 0 0;overflow-wrap:anywhere}
.notice{margin:16px 0 0;padding:12px 14px;border-left:3px solid var(--warn-edge);background:var(--warn-bg);font-size:.9rem}
h2{margin:28px 0 2px;font-size:1.02rem;font-weight:600}
.perms{list-style:none;margin:0;padding:0}
.perms li{display:flex;gap:14px;padding:14px 0}
.perms li+li{border-top:1px solid var(--line)}
.perms li.warn{padding:14px 12px;border-left:3px solid var(--warn-edge);background:var(--warn-bg)}
.perms li.warn+li{border-top-color:transparent}
.ico{flex:none;margin-top:2px;color:var(--accent)}
.warn .ico{color:var(--warn-edge)}
.perms strong{display:block;font-size:.97rem}
.perms p{margin:2px 0 0;color:var(--muted);font-size:.875rem}
.scopes{margin:16px 0 0;color:var(--muted);font-size:.85rem}
.badge{display:inline-block;margin:6px 6px 0 0;padding:1px 8px;border:1px solid var(--line);border-radius:6px;color:var(--ink);font:.8rem ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:grid;gap:10px;margin-top:26px}
button{font:inherit;font-weight:600;padding:14px 18px;border-radius:12px;border:1px solid var(--line);cursor:pointer;width:100%;color:var(--ink);background:transparent}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button:hover{filter:brightness(1.07)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.foot{margin:14px 0 0;color:var(--muted);font-size:.82rem}
@media (max-width:480px){body{padding:0;place-items:start stretch}main{min-height:100vh;border:0;border-radius:0;padding:32px 22px}}
`;

const ICONS = {
  eye: `<path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/>`,
  edit: `<path d='M12 20h9'/><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/>`,
  play: `<polygon points='6 3 20 12 6 21 6 3'/>`,
  lock: `<rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>`,
  shield: `<path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/><path d='m9 12 2 2 4-4'/>`,
} as const;

const icon = (name: keyof typeof ICONS, size = 22): string =>
  `<svg viewBox='0 0 24 24' width='${size}' height='${size}' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${ICONS[name]}</svg>`;

type Tone = 'info' | 'warn';

// Les titres et textes passés ici sont des constantes ; toute donnée du client est échappée à part.
const item = (name: keyof typeof ICONS, title: string, text: string, tone: Tone = 'info'): string =>
  `<li class='${tone}'><span class='ico'>${icon(name)}</span><div><strong>${title}</strong><p>${text}</p></div></li>`;

export function consentPage(details: ConsentDescription, handle: string): string {
  const has = (scope: string): boolean => details.scope.includes(scope);
  const items = [
    item('eye', 'Lecture des dépôts',
      'Ce client pourra lire les dépôts sélectionnés dans la GitHub App et leurs contrôles.'),
    has('mcp:write')
      ? item('edit', 'Écriture sur des branches de travail',
        'Vous autorisez aussi la création de branches de travail liées à votre identité, des commits comprenant des ajouts, modifications et suppressions de fichiers, des PR en brouillon et des commentaires sur vos PR ouvertes dans les dépôts de cette installation. Les branches protégées et les fichiers sensibles, de contrôle CI ou de publication restent interdits. Ces actions peuvent déclencher la CI ou les déploiements automatiques déjà configurés dans ces dépôts. Vérifiez ces automatisations avant d’accepter.',
        'warn')
      : item('lock', 'Aucune modification du code', 'Ce consentement ne permet pas de modifier le code.'),
    item('lock', 'Pas de fusion ni de déploiement',
      'Aucun outil de fusion, d’approbation de PR ou de déploiement direct n’est exposé.'),
    has('mcp:automation')
      ? item('play', 'Vérifications multi-dépôts',
        'Vous autorisez les vérifications multi-dépôts : lancement du workflow de tests mcp-checks et, avec le droit d’écriture, préparation de ce workflow et des commandes du projet sur vos branches. Les commandes exécutent le code du projet sur un runner GitHub hébergé, sans secret ajouté. Elles consomment des minutes Actions et peuvent déclencher des intégrations déjà présentes. Les dépôts accessibles restent ceux de votre installation GitHub App, y compris ceux ajoutés ultérieurement.',
        'warn')
      : '',
    has('mcp:checks')
      ? item('play', 'Lancement de workflow',
        'Vous autorisez aussi le lancement du workflow agent-checks sur les dépôts explicitement configurés. Cela exécute des tests et peut consommer des minutes GitHub Actions.',
        'warn')
      : has('mcp:automation')
        ? ''
        : item('lock', 'Aucun lancement de workflow',
          'Aucun lancement direct de workflow n’est autorisé par ce consentement.'),
  ].join('');
  const client = details.clientDomain
    ? `Domaine du client : <strong>${escape(details.clientDomain)}</strong>`
    : 'Le nom de cette application est déclaré par le client et n’est pas vérifié.';
  const badges = details.scope.map(scope => `<span class='badge'>${escape(scope)}</span>`).join('');
  const loopback = details.redirectIsLoopback
    ? `<p class='notice'>Application locale : continuez uniquement si vous venez de lancer cette connexion sur votre ordinateur.</p>`
    : '';
  return `<!doctype html><html lang='fr'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>Autoriser GitHub MCP</title><style>${STYLE}</style></head>
<body><main>
<span class='mark'>${icon('shield', 36)}</span>
<h1>Autoriser ${escape(details.clientName)} ?</h1>
<p class='sub'>${client}</p>
<p class='dest'>L’accès sera remis à : <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<h2>Ce que ce client pourra faire</h2>
<ul class='perms'>${items}</ul>
<p class='scopes'>Permissions :<br>${badges}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class='actions'>
<button class='primary' name='decision' value='approve'>Autoriser et se connecter à GitHub</button>
<button name='decision' value='deny'>Refuser</button>
</div></form>
<p class='foot'>Vous serez redirigé vers GitHub pour vous connecter.</p>
</main></body></html>`;
}

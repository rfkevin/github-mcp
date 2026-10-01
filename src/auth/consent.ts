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
:root{color-scheme:light dark;--bg:#f3f4f9;--card:#fff;--text:#151922;--muted:#5a6376;--line:#e2e5ee;--brand:#4f46e5;--brand-ink:#fff;--soft:#eceeff;--ok:#067647;--ok-bg:#ecfdf3;--warn:#93370d;--warn-bg:#fffaeb;--warn-line:#fedf89}
@media (prefers-color-scheme:dark){:root{--bg:#0d1017;--card:#171b25;--text:#eef0f6;--muted:#a3abbd;--line:#2a3042;--brand:#8b93ff;--brand-ink:#0d1017;--soft:#232949;--ok:#6ce9a6;--ok-bg:#10291d;--warn:#fec84b;--warn-bg:#2a2010;--warn-line:#5a4314}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:22px;padding:28px 24px;box-shadow:0 12px 32px rgba(16,24,40,.08)}
.logo{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;background:var(--soft);color:var(--brand);margin-bottom:16px}
h1{margin:0 0 6px;font-size:1.45rem;line-height:1.25;overflow-wrap:anywhere}
.sub{margin:0 0 20px;color:var(--muted);font-size:.93rem;overflow-wrap:anywhere}
.dest{padding:12px 14px;border:1px solid var(--line);border-radius:14px;margin:0 0 14px;font-size:.93rem;overflow-wrap:anywhere}
.dest span{display:block;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.notice{padding:12px 14px;border-radius:14px;margin:0 0 14px;font-size:.9rem;border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn)}
h2{margin:22px 0 10px;font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.item{display:flex;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px}
.ico{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--soft);color:var(--brand)}
.ok .ico{background:var(--ok-bg);color:var(--ok)}
.warn .ico{background:var(--warn-bg);color:var(--warn)}
.item strong{display:block;font-size:.97rem}
.item p{margin:2px 0 0;color:var(--muted);font-size:.86rem}
.scopes{margin:18px 0 0;font-size:.85rem;color:var(--muted)}
.badge{display:inline-block;margin:4px 6px 0 0;padding:2px 10px;border-radius:999px;background:var(--soft);color:var(--brand);font:600 .78rem ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:grid;gap:10px;margin-top:24px}
button{font:inherit;font-weight:600;padding:14px 18px;border-radius:14px;border:1px solid var(--line);cursor:pointer;width:100%}
.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.ghost{background:transparent;color:var(--text)}
button:hover{filter:brightness(1.06)}
button:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.foot{margin:16px 0 0;text-align:center;color:var(--muted);font-size:.8rem}
@media (max-width:420px){main{padding:22px 18px;border-radius:18px}}
`;

const ICONS = {
  eye: `<path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/>`,
  edit: `<path d='M12 20h9'/><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/>`,
  play: `<polygon points='6 3 20 12 6 21 6 3'/>`,
  lock: `<rect x='3' y='11' width='18' height='11' rx='2'/><path d='M7 11V7a5 5 0 0 1 10 0v4'/>`,
  shield: `<path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/>`,
} as const;

const icon = (name: keyof typeof ICONS, size = 20): string =>
  `<svg viewBox='0 0 24 24' width='${size}' height='${size}' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${ICONS[name]}</svg>`;

type Tone = 'info' | 'ok' | 'warn';

// Les titres et textes passés ici sont des constantes ; toute donnée du client est échappée à part.
const item = (name: keyof typeof ICONS, title: string, text: string, tone: Tone = 'info'): string =>
  `<li class='item ${tone}'><span class='ico'>${icon(name)}</span><div><strong>${title}</strong><p>${text}</p></div></li>`;

export function consentPage(details: ConsentDescription, handle: string): string {
  const has = (scope: string): boolean => details.scope.includes(scope);
  const items = [
    item('eye', 'Lecture des dépôts',
      'Ce client pourra lire les dépôts sélectionnés dans la GitHub App et leurs contrôles.'),
    has('mcp:write')
      ? item('edit', 'Écriture sur des branches de travail',
        'Vous autorisez aussi la création de branches de travail liées à votre identité, des commits comprenant des ajouts, modifications et suppressions de fichiers, des PR en brouillon et des commentaires sur vos PR ouvertes dans les dépôts de cette installation. Les branches protégées et les fichiers sensibles, de contrôle CI ou de publication restent interdits. Ces actions peuvent déclencher la CI ou les déploiements automatiques déjà configurés dans ces dépôts. Vérifiez ces automatisations avant d’accepter.',
        'warn')
      : item('lock', 'Aucune modification du code', 'Ce consentement ne permet pas de modifier le code.', 'ok'),
    item('lock', 'Pas de fusion ni de déploiement',
      'Aucun outil de fusion, d’approbation de PR ou de déploiement direct n’est exposé.', 'ok'),
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
          'Aucun lancement direct de workflow n’est autorisé par ce consentement.', 'ok'),
  ].join('');
  const client = details.clientDomain
    ? `Domaine du client : <strong>${escape(details.clientDomain)}</strong>`
    : 'Le nom de cette application est déclaré par le client et n’est pas vérifié.';
  const badges = details.scope.map(scope => `<span class='badge'>${escape(scope)}</span>`).join('');
  const loopback = details.redirectIsLoopback
    ? `<div class='notice'>Application locale : continuez uniquement si vous venez de lancer cette connexion sur votre ordinateur.</div>`
    : '';
  return `<!doctype html><html lang='fr'><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>Autoriser GitHub MCP</title><style>${STYLE}</style></head>
<body><main>
<div class='logo'>${icon('shield', 28)}</div>
<h1>Autoriser ${escape(details.clientName)} ?</h1>
<p class='sub'>${client}</p>
<div class='dest'><span>L’accès sera remis à</span><strong>${escape(details.redirectHost)}</strong></div>
${loopback}
<h2>Ce que ce client pourra faire</h2>
<ul>${items}</ul>
<p class='scopes'>Permissions :<br>${badges}</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escape(handle)}">
<div class='actions'>
<button class='primary' name='decision' value='approve'>Autoriser et se connecter à GitHub</button>
<button class='ghost' name='decision' value='deny'>Refuser</button>
</div></form>
<p class='foot'>Vous serez redirigé vers GitHub pour vous connecter.</p>
</main></body></html>`;
}

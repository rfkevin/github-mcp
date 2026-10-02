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

// This page is deliberately self-contained: no scripts, remote images, fonts or requests.
// Inline CSS is the only extra resource allowed; every other directive inherits default-src none.
export function consentPagePolicy(validatedRedirectUri: string): string {
  return `${consentPolicy(validatedRedirectUri)}; style-src 'unsafe-inline'`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f7f6;--glow:#d9f4ee;--card:rgba(255,255,255,.94);--ink:#10201f;--muted:#5a6b68;--line:#d8e2df;--soft:#f2f7f5;--accent:#0f766e;--accent-hover:#0b5f59;--accent-ink:#fff;--warn:#b45309;--warn-bg:#fff8e8;--shadow:0 24px 70px rgba(15,45,41,.13)}
@media (prefers-color-scheme:dark){:root{--bg:#081210;--glow:#123a33;--card:rgba(15,27,24,.96);--ink:#edf7f4;--muted:#9eb2ad;--line:#28403b;--soft:#14231f;--accent:#5eead4;--accent-hover:#7cf1df;--accent-ink:#05211c;--warn:#fbbf24;--warn-bg:#281e0b;--shadow:0 24px 70px rgba(0,0,0,.34)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;padding:32px 20px;display:grid;place-items:center;background:radial-gradient(circle at 50% 0,var(--glow),transparent 42%),var(--bg);color:var(--ink);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
main{width:min(100%,560px);overflow:hidden;background:var(--card);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}
.hero{padding:30px 30px 24px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;color:var(--accent);font-weight:750;letter-spacing:-.01em}
.brand-mark{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:var(--soft);border:1px solid var(--line)}
h1{margin:0;font-size:1.65rem;line-height:1.2;letter-spacing:-.035em;overflow-wrap:anywhere}
.lead{margin:10px 0 0;color:var(--muted);font-size:.95rem}
.client{margin-top:20px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--soft)}
.client-label{display:block;color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.client-value{display:block;margin-top:3px;font-weight:650;overflow-wrap:anywhere}
.notice{margin-top:14px;padding:11px 13px;border-left:3px solid var(--warn);border-radius:8px;background:var(--warn-bg);font-size:.87rem}
.content{padding:24px 30px 30px}
h2{margin:0 0 6px;font-size:1rem;letter-spacing:-.01em}
.intro{margin:0 0 8px;color:var(--muted);font-size:.9rem}
.perms{list-style:none;margin:0;padding:0}
.perms li{display:flex;gap:13px;padding:13px 0}
.perms li+li{border-top:1px solid var(--line)}
.perms li.warn{margin:5px -10px;padding:13px 10px;border:0;border-left:3px solid var(--warn);border-radius:8px;background:var(--warn-bg)}
.ico{flex:none;width:24px;height:24px;margin-top:1px;color:var(--accent)}
.warn .ico{color:var(--warn)}
.perms strong{display:block;font-size:.92rem}
.perms p{margin:2px 0 0;color:var(--muted);font-size:.84rem}
.scopes{margin:18px 0 0;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:.78rem}
.badge{display:inline-block;margin:7px 5px 0 0;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--soft);color:var(--ink);font:.75rem ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:grid;gap:9px;margin-top:24px}
button{width:100%;min-height:48px;padding:12px 18px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink);font:inherit;font-weight:700;cursor:pointer;transition:transform .12s ease,background .12s ease,border-color .12s ease}
button.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
button:not(.primary):hover{background:var(--soft)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.foot{display:flex;align-items:flex-start;gap:8px;margin:15px 0 0;color:var(--muted);font-size:.78rem}
.foot svg{flex:none;margin-top:1px}
@media (max-width:560px){body{padding:0;place-items:stretch}main{min-height:100vh;border:0;border-radius:0;box-shadow:none}.hero{padding:28px 22px 22px}.content{padding:22px}.brand{margin-bottom:22px}}
@media (prefers-reduced-motion:reduce){button{transition:none}}
`;

const ICONS = {
  eye: `<path d='M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z'/><circle cx='12' cy='12' r='2.5'/>`,
  edit: `<path d='M12 20h9'/><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'/>`,
  play: `<path d='M8 5v14l11-7Z'/>`,
  lock: `<rect x='4' y='10' width='16' height='11' rx='2'/><path d='M8 10V7a4 4 0 0 1 8 0v3'/>`,
  shield: `<path d='M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'/><path d='m9 12 2 2 4-4'/>`,
} as const;

const icon = (name: keyof typeof ICONS, size = 22): string =>
  `<svg viewBox='0 0 24 24' width='${size}' height='${size}' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>${ICONS[name]}</svg>`;

type Tone = 'info' | 'warn';
const item = (name: keyof typeof ICONS, title: string, text: string, tone: Tone = 'info'): string =>
  `<li${tone === 'warn' ? " class='warn'" : ''}><span class='ico'>${icon(name)}</span><div><strong>${title}</strong><p>${text}</p></div></li>`;

export function consentPage(details: ConsentDescription, handle: string): string {
  const write = details.scope.includes('mcp:write');
  const integration = write && details.scope.includes('mcp:integration');
  const automation = details.scope.includes('mcp:automation');
  const checks = details.scope.includes('mcp:checks');
  const permissions = [
    item('eye', 'Lire les dépôts autorisés', 'Consulter le code, les issues, les pull requests et l’état des contrôles des dépôts sélectionnés.'),
    write
      ? item('edit', 'Proposer des changements', 'Créer des branches de travail, commits, issues, pull requests et commentaires. Les fichiers sensibles et les contrôles de publication restent protégés.', 'warn')
      : item('lock', 'Accès en lecture seule', 'Ce consentement ne permet pas de modifier le code ni de créer des issues.'),
    integration
      ? item('shield', 'Intégration encadrée', 'Autoriser une fusion uniquement vers la branche integration lorsqu’une politique du propriétaire, les contrôles et les accords requis sont présents.', 'warn')
      : item('shield', 'Pas de fusion vers la branche principale', 'Aucune fusion vers main/master, approbation GitHub de PR, fermeture de PR ou publication directe n’est exposée.'),
    automation
      ? item('play', 'Lancer les vérifications du projet', 'Exécuter le workflow mcp-checks sur GitHub Actions. Avec l’écriture, le MCP peut préparer ce workflow sur une branche de travail.', 'warn')
      : checks
        ? item('play', 'Lancer les contrôles configurés', 'Exécuter agent-checks sur les dépôts explicitement configurés. Cela peut consommer des minutes GitHub Actions.', 'warn')
        : item('lock', 'Aucun workflow lancé directement', 'Ce consentement n’autorise pas le lancement direct de workflows GitHub Actions.'),
  ].join('');

  const loopback = details.redirectIsLoopback
    ? `<div class='notice'><strong>Application locale.</strong> Continuez uniquement si vous venez de lancer cette connexion sur votre appareil.</div>`
    : '';
  const writeNotice = write
    ? `<div class='notice'>Les écritures peuvent envoyer des notifications et déclencher les CI ou déploiements automatiques déjà configurés. La création d’issues exige aussi la permission GitHub Issues en écriture.</div>`
    : '';
  const automationNotice = automation
    ? `<div class='notice'>Les commandes de projet s’exécutent sur un runner GitHub hébergé, sans secret ajouté par le MCP, et peuvent consommer des minutes Actions.</div>`
    : '';
  const domain = details.clientDomain
    ? `Client déclaré sur <strong>${escape(details.clientDomain)}</strong>`
    : 'Le nom de ce client est déclaré par l’application et n’est pas vérifié.';

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Autoriser ${escape(details.clientName)} · GitHub MCP</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <section class='hero'>
    <div class='brand'><span class='brand-mark'>${icon('shield', 21)}</span><span>GitHub MCP</span></div>
    <h1>Autoriser ${escape(details.clientName)} ?</h1>
    <p class='lead'>Vérifiez ce que cette application pourra faire avant de lui donner accès à votre MCP.</p>
    <div class='client'>
      <span class='client-label'>Destination du consentement</span>
      <span class='client-value'>${escape(details.redirectHost)}</span>
      <span class='sub'>${domain}</span>
    </div>
    ${loopback}${writeNotice}${automationNotice}
  </section>
  <section class='content'>
    <h2>Accès demandé</h2>
    <p class='intro'>Les dépôts accessibles restent limités à ceux sélectionnés dans votre installation GitHub App.</p>
    <ul class='perms'>${permissions}</ul>
    <div class='scopes'><strong>Scopes OAuth demandés</strong><br>${details.scope.map(scope => `<span class='badge'>${escape(scope)}</span>`).join('')}</div>
    <form method="post" action="/authorize">
      <input type="hidden" name="handle" value="${escape(handle)}">
      <div class='actions'>
        <button class='primary' name='decision' value='approve'>Autoriser et continuer avec GitHub</button>
        <button name='decision' value='deny'>Refuser</button>
      </div>
    </form>
    <p class='foot'>${icon('lock', 15)}<span>Connexion sécurisée via GitHub. Aucun mot de passe GitHub n’est demandé par cette page.</span></p>
  </section>
</main>
</body>
</html>`;
}

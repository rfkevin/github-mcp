// Finish the form submission before navigating: form-action also applies to
// redirects, including redirects issued later by the OAuth client's callback.
export function navigationPage(target: string, headers: Headers): Response {
  const escaped = target.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
  headers.delete('Location');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'");
  headers.set('X-Frame-Options', 'DENY');
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${escaped}">
<title>Connexion en cours</title><style>body{font:1rem/1.6 system-ui;margin:3rem auto;padding:1rem;max-width:32rem;color-scheme:light dark}a{display:inline-block;padding:.7rem 1rem}</style></head>
<body><main><h1>Connexion en cours…</h1><p>Vous allez être redirigé automatiquement.</p>
<p>Si la page ne change pas, <a id="continue" href="${escaped}" rel="noreferrer">continuer la connexion</a>.</p>
<p>Ne rechargez pas cette page et ne recommencez pas la demande en cours.</p></main></body></html>`, { status: 200, headers });
}

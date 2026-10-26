/**
 * CC-7 L4b — HTML minimal du salon (même CSP que /owner).
 */
import type { SalonMessageRow } from './salon';

export const SALON_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function levelClass(level: string): string {
  if (level === 'blocking') return 'blocking';
  if (level === 'decision') return 'decision';
  return 'info';
}

export function salonPage(opts: {
  messages: SalonMessageRow[];
  mode: 'secret' | 'access';
  flash?: { text: string; error: boolean };
  enabled: boolean;
}): string {
  const rows = opts.messages.slice().reverse().map(m => {
    const when = new Date(m.at * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    const flags = [
      m.new_fact ? 'new_fact' : '',
      m.over_quota ? 'over_quota' : '',
      m.task_id ? 'task=' + m.task_id : '',
    ].filter(Boolean).join(' ');
    return `<article class="msg ${levelClass(m.level)}">`
      + `<header><strong>${esc(m.author_pid)}</strong> · <span class="lvl">${esc(m.level)}</span>`
      + ` · <time>${esc(when)}</time>${flags ? ' · <span class="flags">' + esc(flags) + '</span>' : ''}`
      + `</header><pre>${esc(m.body)}</pre></article>`;
  }).join('\n');

  const secretField = opts.mode === 'secret'
    ? `<label>Secret owner <input type="password" name="owner_secret" required autocomplete="current-password"></label>`
    : '';

  const flash = opts.flash
    ? `<p class="flash ${opts.flash.error ? 'err' : 'ok'}">${esc(opts.flash.text)}</p>`
    : '';

  const form = opts.enabled
    ? `<form method="post" action="/salon">
  ${secretField}
  <label>Niveau
    <select name="level">
      <option value="info">info</option>
      <option value="decision">decision</option>
      <option value="blocking">blocking</option>
    </select>
  </label>
  <label>Tâche (obligatoire si blocking) <input name="task" maxlength="64"></label>
  <label>Incident key <input name="incident_key" maxlength="128"></label>
  <label><input type="checkbox" name="new_fact" value="1"> Fait nouveau</label>
  <label>Message <textarea name="body" required maxlength="2000" rows="4"></textarea></label>
  <button type="submit">Publier (owner)</button>
</form>`
    : `<p class="flash err">Salon éteint (SALON_ENABLED ≠ true).</p>`;

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Salon d’équipe</title>
<style>
body{font-family:system-ui,sans-serif;margin:1.5rem;max-width:52rem;line-height:1.4}
h1{font-size:1.25rem} .msg{border-left:4px solid #888;padding:.5rem .75rem;margin:.75rem 0;background:#fafafa}
.msg.decision{border-color:#c90}.msg.blocking{border-color:#c00}
.msg header{font-size:.85rem;color:#444;margin-bottom:.35rem}
pre{white-space:pre-wrap;margin:0;font:inherit}
form{display:grid;gap:.5rem;margin:1.5rem 0;padding:1rem;border:1px solid #ddd}
label{display:grid;gap:.25rem;font-size:.9rem}
.flash{padding:.5rem .75rem;border-radius:4px}.flash.ok{background:#e8f5e9}.flash.err{background:#fdecea}
.flags{color:#a60}
</style></head><body>
<h1>Salon d’équipe</h1>
<p>Canal owner uniquement (même preuve que <code>/owner</code>). Quota agent non appliqué à Kevin. HALT respecté.</p>
${flash}
${form}
<section aria-label="Messages">
${rows || '<p>Aucun message.</p>'}
</section>
</body></html>`;
}

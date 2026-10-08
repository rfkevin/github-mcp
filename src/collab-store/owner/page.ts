/**
 * CC-3 C5 — /owner HTML. No script, no remote resource, no secret echoed:
 * every password field is rendered empty.
 */
import type { OwnerChannelConfig } from './config';
import type { PendingRequest } from './decisions';
import type { ImportedStateSummary } from './state-import';

export const OWNER_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const STYLE = [
  'body{margin:0;padding:24px;background:#f4f7f6;color:#10201f;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}',
  '@media (prefers-color-scheme:dark){body{background:#081210;color:#edf7f4}}',
  'main{max-width:820px;margin:0 auto}',
  'h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px}',
  'p.note{color:#5a6b68;margin:0 0 16px}',
  '.msg{padding:10px 12px;border-radius:8px;margin:12px 0;background:#e3f1ec}',
  '.msg.err{background:#f8e1df}',
  '@media (prefers-color-scheme:dark){.msg{background:#16302a}.msg.err{background:#3a1d1a}}',
  'table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #d8e2df;vertical-align:top}',
  'form.inline{display:inline}input,button,textarea{font:inherit}input[type=text],input[type=password],textarea{width:100%;box-sizing:border-box;padding:6px}',
  'textarea{min-height:180px;font-family:ui-monospace,monospace;font-size:13px}',
  'fieldset{border:1px solid #d8e2df;border-radius:8px;margin:0 0 12px;padding:10px 12px}',
].join('');

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => '&#' + char.charCodeAt(0) + ';');
}

function secretField(config: OwnerChannelConfig): string {
  return config.mode === 'secret'
    ? '<label>Secret owner <input type="password" name="owner_secret" autocomplete="current-password" required></label>'
    : '';
}

function layout(title: string, body: string): string {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title><style>' + STYLE + '</style></head><body><main>'
    + body + '</main></body></html>';
}

export function loginPage(config: OwnerChannelConfig, message = ''): string {
  return layout('Canal owner', '<h1>Canal owner</h1>'
    + '<p class="note">Réservé au propriétaire. Aucun agent ni outil MCP ne peut agir ici.</p>'
    + (message ? '<p class="msg err">' + escapeHtml(message) + '</p>' : '')
    + '<form method="post" action="/owner"><input type="hidden" name="action" value="view">'
    + secretField(config) + '<p><button type="submit">Ouvrir</button></p></form>');
}

export interface DashboardData {
  pending: PendingRequest[];
  participants: Array<{ participant_id: string; display_label: string; status: string }>;
  clients: Array<{ oauth_client_id: string; participant_id: string; approved_event_seq: number | null }>;
  /** CC-3 C6 : dernier état CC-STATE-1 importé par cycle. */
  imports?: ImportedStateSummary[];
  message?: { text: string; error: boolean };
}

export function dashboardPage(config: OwnerChannelConfig, data: DashboardData): string {
  const secret = secretField(config);
  const rows = data.pending.map(item => '<tr><td><code>' + escapeHtml(item.request_id) + '</code><br>'
    + escapeHtml(item.type) + ' · ' + escapeHtml(item.cycle_id) + ' · seq ' + item.seq + '</td>'
    + '<td>' + escapeHtml(item.participant_id) + '</td><td>' + escapeHtml(item.summary) + '</td><td>'
    + '<form method="post" action="/owner"><input type="hidden" name="action" value="decide">'
    + '<input type="hidden" name="request_id" value="' + escapeHtml(item.request_id) + '">' + secret
    + '<button name="decision" value="approve">Approuver</button> <button name="decision" value="deny">Refuser</button></form>'
    + '</td></tr>').join('');
  const participants = data.participants.map(item => '<tr><td><code>' + escapeHtml(item.participant_id) + '</code></td><td>'
    + escapeHtml(item.display_label) + '</td><td>' + escapeHtml(item.status) + '</td></tr>').join('');
  const clients = data.clients.map(item => '<tr><td><code>' + escapeHtml(item.oauth_client_id) + '</code></td><td>'
    + escapeHtml(item.participant_id) + '</td><td>' + (item.approved_event_seq ?? '—') + '</td></tr>').join('');
  return layout('Canal owner', '<h1>Canal owner</h1>'
    + '<p class="note">Chaque action est enregistrée comme événement owner.decision avec sa preuve (' + config.mode + ').'
    + (config.mode === 'secret' ? ' Le secret est redemandé à chaque action et n’est jamais conservé.' : '') + '</p>'
    + (data.message ? '<p class="msg' + (data.message.error ? ' err' : '') + '">' + escapeHtml(data.message.text) + '</p>' : '')
    + '<h2>Demandes en attente (' + data.pending.length + ')</h2>'
    + (rows ? '<table><tr><th>Demande</th><th>Participant</th><th>Résumé</th><th>Décision</th></tr>' + rows + '</table>'
      : '<p class="note">Aucune demande en attente.</p>')
    + '<h2>Participants</h2>'
    + (participants ? '<table><tr><th>Identifiant</th><th>Libellé (affichage)</th><th>Statut</th></tr>' + participants + '</table>' : '<p class="note">Aucun participant.</p>')
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="register">'
    + '<label>Identifiant <input type="text" name="participant_id" required pattern="[A-Za-z0-9][A-Za-z0-9:_-]{0,127}"></label>'
    + '<label>Libellé <input type="text" name="display_label" required maxlength="80"></label>' + secret
    + '<p><button type="submit">Enregistrer le participant</button></p></form></fieldset>'
    + '<h2>Clients OAuth associés</h2>'
    + (clients ? '<table><tr><th>Client OAuth</th><th>Participant</th><th>Événement</th></tr>' + clients + '</table>' : '<p class="note">Aucun client associé : tous les clients sont « unregistered ».</p>')
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="map">'
    + '<label>Client OAuth ou pseudonyme unregistered:… <input type="text" name="oauth_client_id" required maxlength="512"></label>'
    + '<label>Participant <input type="text" name="participant_id" required></label>' + secret
    + '<p><button type="submit">Associer</button></p></form></fieldset>'
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="unmap">'
    + '<label>Client OAuth <input type="text" name="oauth_client_id" required maxlength="512"></label>' + secret
    + '<p><button type="submit">Retirer l’association</button></p></form></fieldset>'
    + importSection(data.imports ?? [], secret));
}

function importSection(imports: ImportedStateSummary[], secret: string): string {
  const rows = imports.map(item => '<tr><td><code>' + escapeHtml(item.cycle_id) + '</code></td><td>' + item.state_revision
    + '</td><td><code>' + escapeHtml(item.content_sha256.slice(0, 12)) + '</code></td><td>' + item.seq + '</td></tr>').join('');
  return '<h2>États CC-STATE-1 importés</h2>'
    + '<p class="note">Importer l’état fusionné dans GitHub en fait la base de collab_export pour ce cycle : phase et tâches du store remplacées, '
    + 'enregistré comme décision owner. Les libellés des tâches doivent correspondre à des participants enregistrés.</p>'
    + (rows ? '<table><tr><th>Cycle</th><th>Révision</th><th>sha256</th><th>Événement</th></tr>' + rows + '</table>'
      : '<p class="note">Aucun état importé.</p>')
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="import_state">'
    + '<label>Cycle <input type="text" name="cycle_id" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"></label>'
    + '<label>Dépôt de l’état (owner/repo) <input type="text" name="target_repository" maxlength="200"></label>'
    + '<label>Chemin <input type="text" name="target_path" maxlength="512" placeholder="docs/coordination/cc3/state.md"></label>'
    + '<label>Branche <input type="text" name="target_ref" maxlength="240" placeholder="main"></label>'
    + '<label>Libellé owner dans l’état <input type="text" name="owner_label" maxlength="80" placeholder="Kevin"></label>'
    + '<label>Contenu CC-STATE-1 (fichier fusionné, brut) <textarea name="state" required></textarea></label>' + secret
    + '<p><button type="submit">Importer l’état</button></p></form></fieldset>';
}

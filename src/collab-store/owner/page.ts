/**
 * CC-3 C5 — /owner HTML. No script, no remote resource, no secret echoed:
 * every password field is rendered empty.
 */
import type { RelayLine } from '../controller/relay';
import type { OwnerChannelConfig } from './config';
import type { DescribedPendingPage, ExecutableView, PendingWithExecutable } from './executable';
import type { BudgetEnvelope } from './automation';
import type { CapabilityRow } from '../executors/registry';
import type { ImportedStateSummary } from './state-import';
import { OWNER_TRIAL_INSTRUCTIONS, OWNER_TRIAL_MAX_DATA } from './trials';

export const OWNER_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/**
 * CC-4 : lisible sur téléphone et en mode sombre, sans ressource externe ni
 * `url(...)` (la CSP n'autorise que les styles inline). `color-scheme` laisse le
 * navigateur assombrir les champs natifs ; sous 600 px, les tableaux défilent
 * horizontalement et les contrôles atteignent 44 px (16 px évite le zoom iOS).
 */
const STYLE = [
  ':root{color-scheme:light dark}*,*::before,*::after{box-sizing:border-box}',
  'body{margin:0;padding:24px;background:#f4f7f6;color:#10201f;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;-webkit-text-size-adjust:100%}',
  '@media (prefers-color-scheme:dark){body{background:#081210;color:#edf7f4}}',
  'main{max-width:820px;margin:0 auto}',
  'h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 8px}',
  'p.note{color:#5a6b68;margin:0 0 16px}code{overflow-wrap:anywhere}',
  '.msg{padding:10px 12px;border-radius:8px;margin:12px 0;background:#e3f1ec;overflow-wrap:anywhere}',
  '.msg.err{background:#f8e1df}',
  '@media (prefers-color-scheme:dark){p.note{color:#9fb5b0}.msg{background:#16302a}.msg.err{background:#3a1d1a}}',
  'table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #d8e2df;vertical-align:top}',
  'form.inline{display:inline}input,button,textarea,select{font:inherit}label{display:block;margin:0 0 8px}',
  'input[type=text],input[type=password],textarea,select{display:block;width:100%;padding:6px;margin-top:2px}',
  'button{min-height:36px;padding:6px 14px;margin:2px 4px 2px 0;cursor:pointer}',
  'textarea{min-height:180px;font-family:ui-monospace,monospace;font-size:13px}',
  'fieldset{border:1px solid #d8e2df;border-radius:8px;margin:0 0 12px;padding:10px 12px;min-width:0}',
  '@media (prefers-color-scheme:dark){td,th,fieldset{border-color:#2a3f3b}}',
  'pre{white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-size:12px;background:rgba(127,127,127,.08);padding:6px;border-radius:6px}',
  'dl{margin:6px 0}dt{font-weight:600}dd{margin:0 0 6px;overflow-wrap:anywhere}',
  '.halt{padding:10px 12px;border-radius:8px;background:#f8e1df;font-weight:600}',
  '@media (prefers-color-scheme:dark){.halt{background:#3a1d1a}}',
  'summary{cursor:pointer;min-height:44px;padding:10px 6px;overflow-wrap:anywhere}',
  'details.ep{border:1px solid #d8e2df;border-radius:8px;margin:8px 0;padding:2px 10px}',
  '@media (prefers-color-scheme:dark){details.ep{border-color:#2a3f3b}}',
  '@media (max-width:600px){body{padding:12px}h2{margin-top:22px}',
  'table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}td,th{padding:6px;min-width:110px}td[colspan]{min-width:0}',
  'input[type=text],input[type=password],select,button{min-height:44px;font-size:16px}textarea{font-size:16px;min-height:140px}',
  'fieldset{padding:8px 10px}pre{max-height:180px}}',
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
  /** F2/A06 : une page de demandes non tranchées, filtrées avant pagination. */
  pending: DescribedPendingPage;
  participants: Array<{ participant_id: string; display_label: string; status: string }>;
  clients: Array<{ oauth_client_id: string; participant_id: string; approved_event_seq: number | null }>;
  /** #126 : ids historiques qui représentent une même identité logique. */
  identityFamilies?: Array<{ family_id: string; members: string[]; event_seq: number | null; updated_at: number }>;
  /** CC-3 C6 : dernier état CC-STATE-1 importé par cycle. */
  imports?: ImportedStateSummary[];
  message?: { text: string; error: boolean };
  /** CC-4 A2 : arrêt d'urgence posé. */
  halted?: boolean;
  /** CC-4 A2 : enveloppe budgétaire globale (0 € par défaut). */
  budget?: BudgetEnvelope;
  /** CC-4 A4 : coordinateurs actifs, accordés uniquement par demande owner exécutable. */
  coordinators?: Array<{ participant_id: string; display_label: string; event_seq: number | null; updated_at: number }>;
  /** CC-4 A3/A4 : matrice des endpoints d'exécution (§4.1), avec notes owner. */
  executors?: CapabilityRow[];
  /** CC-5 l3d 2b-2a : décisions courantes du contrôleur à relayer aux agents (lecture seule). */
  relay?: RelayLine[];
}

export function dashboardPage(config: OwnerChannelConfig, data: DashboardData): string {
  const secret = secretField(config);
  const rows = data.pending.items.map(item => '<tr><td><code>' + escapeHtml(item.request_id || '—') + '</code><br>'
    + escapeHtml(item.type) + ' · ' + escapeHtml(item.cycle_id) + ' · seq ' + item.seq + '</td>'
    + '<td>' + escapeHtml(item.participant_id) + '</td><td>' + escapeHtml(item.summary) + executableDetail(item) + '</td><td>'
    + decisionCell(item, secret) + '</td></tr>').join('');
  const participants = data.participants.map(item => '<tr><td><code>' + escapeHtml(item.participant_id) + '</code></td><td>'
    + escapeHtml(item.display_label) + '</td><td>' + escapeHtml(item.status) + '</td></tr>').join('');
  const clients = data.clients.map(item => '<tr><td><code>' + escapeHtml(item.oauth_client_id) + '</code></td><td>'
    + escapeHtml(item.participant_id) + '</td><td>' + (item.approved_event_seq ?? '—') + '</td></tr>').join('');
  return layout('Canal owner', '<h1>Canal owner</h1>'
    + '<p class="note">Chaque action est enregistrée comme événement owner.decision avec sa preuve (' + config.mode + ').'
    + (config.mode === 'secret' ? ' Le secret est redemandé à chaque action et n’est jamais conservé.' : '') + '</p>'
    + (data.message ? '<p class="msg' + (data.message.error ? ' err' : '') + '">' + escapeHtml(data.message.text) + '</p>' : '')
    + statusBanner(data)
    + '<h2>Demandes en attente (' + data.pending.total + ')</h2>'
    + (rows ? '<table><tr><th>Demande</th><th>Participant</th><th>Résumé</th><th>Décision</th></tr>' + rows + '</table>'
      : '<p class="note">Aucune demande en attente.</p>')
    + (data.pending.next_before !== null
      ? '<form method="post" action="/owner"><input type="hidden" name="action" value="view">'
        + '<input type="hidden" name="before" value="' + data.pending.next_before + '">' + secret
        + '<p><button type="submit">Demandes plus anciennes</button></p></form>'
      : '')
    + relaySection(data.relay ?? [])
    + automationSection(data.halted ?? false, data.budget, secret)
    + coordinatorSection(data.coordinators ?? [])
    + '<h2>Mandat coordinateur par cycle (CC-5)</h2>'
    + '<p class="note">Nomination owner uniquement. Laisser participant et famille vides révoque le mandat. Époque attendue obligatoire.</p>'
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="appoint_cycle_coordinator">'
    + '<label>Cycle <input type="text" name="cycle_id" required></label>'
    + '<label>Participant (vide = révocation) <input type="text" name="participant_id"></label>'
    + '<label>Famille logique (vide = révocation) <input type="text" name="family_id"></label>'
    + '<label>Époque attendue <input type="number" name="expected_epoch" min="0" required></label>'
    + secret + '<p><button type="submit">Nommer ou révoquer</button></p></form></fieldset>'
    + executorSection(data.executors ?? [], secret)
    + '<h2>Participants</h2>'
    + (participants ? '<table><tr><th>Identifiant</th><th>Libellé (affichage)</th><th>Statut</th></tr>' + participants + '</table>' : '<p class="note">Aucun participant.</p>')
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="register">'
    + '<label>Identifiant <input type="text" name="participant_id" required pattern="[A-Za-z0-9][A-Za-z0-9:_-]{0,127}"></label>'
    + '<label>Libellé <input type="text" name="display_label" required maxlength="80"></label>' + secret
    + '<p><button type="submit">Enregistrer le participant</button></p></form></fieldset>'
    + identityFamilySection(data.identityFamilies ?? [])
    + '<h2>Clients OAuth associés</h2>'
    + (clients ? '<table><tr><th>Client OAuth</th><th>Participant</th><th>Événement</th></tr>' + clients + '</table>' : '<p class="note">Aucun client associé : tous les clients sont « unregistered ».</p>')
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="map">'
    + '<label>Client OAuth ou pseudonyme unregistered:… <input type="text" name="oauth_client_id" required maxlength="512"></label>'
    + '<label>Participant <input type="text" name="participant_id" required></label>' + secret
    + '<p><button type="submit">Associer</button></p></form></fieldset>'
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="unmap">'
    + '<label>Client OAuth <input type="text" name="oauth_client_id" required maxlength="512"></label>' + secret
    + '<p><button type="submit">Retirer l’association</button></p></form></fieldset>'
    + importSection(data.imports ?? [], secret)
    + phaseSection(secret));
}

/**
 * F2/A02 : le formulaire porte la seq immuable de la demande affichée (et son
 * cycle) ; le serveur refuse si elle ne correspond plus. Une demande bloquée
 * (identifiant déjà tranché pour une autre seq) ou invalide n'a pas de bouton.
 */
function decisionCell(item: PendingWithExecutable, secret: string): string {
  if (item.state === 'invalid') return '<em>Identifiant de demande invalide : non décidable.</em>';
  const exec = item.executable;
  // CC-4 A2 : une demande exécutable invalide ou expirée ne peut qu'être refusée.
  const approvable = !exec || (!exec.invalid && !exec.expired);
  if (item.state === 'blocked') {
    return '<em>Identifiant déjà tranché' + (item.decided_seq ? ' pour la seq ' + item.decided_seq : '')
      + ' : l’agent doit redéposer sous un nouvel identifiant.</em>';
  }
  return '<form method="post" action="/owner"><input type="hidden" name="action" value="decide">'
    + '<input type="hidden" name="request_id" value="' + escapeHtml(item.request_id) + '">'
    + '<input type="hidden" name="request_seq" value="' + item.seq + '">'
    + '<input type="hidden" name="cycle_id" value="' + escapeHtml(item.cycle_id) + '">'
    + (exec?.payload_sha256 ? '<input type="hidden" name="payload_sha256" value="' + escapeHtml(exec.payload_sha256) + '">' : '') + secret
    + (approvable ? '<button name="decision" value="approve">Approuver</button> ' : '')
    + '<button name="decision" value="deny">Refuser</button></form>';
}

const ACTION_LABELS: Record<string, string> = { install_phases: 'Installer les définitions de phase', import_state: 'Importer l’état CC-STATE-1',
  register_endpoint: 'Inscrire ou modifier un endpoint d’exécution', grant_coordinator: 'Accorder ou révoquer le rôle coordinateur',
  set_identity_family: 'Configurer une identité logique commune' };

/** CC-4 A2 : ce qui sera exécuté exactement, pourquoi, risque, retour arrière, empreinte. */
function executableDetail(item: PendingWithExecutable): string {
  const exec = item.executable;
  if (!exec) return '';
  if (exec.invalid) return '<p class="msg err">Demande exécutable invalide : ' + escapeHtml(exec.invalid) + ' Refusez-la.</p>';
  const expiry = exec.expires_at ? new Date(exec.expires_at * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'aucune';
  return '<dl>'
    + '<dt>Action exécutée à l’approbation</dt><dd>' + escapeHtml(ACTION_LABELS[exec.action ?? ''] ?? String(exec.action))
    + (exec.action === 'register_endpoint' ? ' — endpoint <code>' + escapeHtml(exec.target ?? '') + '</code>'
      : exec.action === 'grant_coordinator' ? ' — participant <code>' + escapeHtml(exec.target ?? '') + '</code>'
        : exec.action === 'set_identity_family' ? ' — identité <code>' + escapeHtml(exec.target ?? '') + '</code>'
          : ' — cycle <code>' + escapeHtml(exec.cycle_id ?? '') + '</code>') + '</dd>'
    + '<dt>Pourquoi</dt><dd>' + escapeHtml(exec.reason ?? '') + '</dd>'
    + '<dt>Risque</dt><dd>' + escapeHtml(exec.risk ?? '') + '</dd>'
    + '<dt>Retour arrière</dt><dd>' + escapeHtml(exec.rollback ?? '') + '</dd>'
    + '<dt>Précondition</dt><dd>dernier acte du même type au seq ' + (exec.previous_seq ?? 'aucun') + '</dd>'
    + stateDiffRows(exec)
    + '<dt>Coût maximal</dt><dd>' + ((exec.max_cost_cents ?? 0) / 100).toFixed(2) + ' €</dd>'
    + '<dt>Expiration</dt><dd>' + escapeHtml(expiry) + (exec.expired ? ' — <strong>expirée, non approuvable</strong>' : '') + '</dd>'
    + '<dt>Empreinte sha256</dt><dd><code>' + escapeHtml(exec.payload_sha256 ?? '') + '</code></dd>'
    + '</dl><pre>' + escapeHtml(exec.preview ?? '') + '</pre>';
}

/** CC-5 l3e 2b : verdict de l'import (même classification que la délégation du coordinateur). */
export function stateDiffRows(exec: ExecutableView): string {
  const diff = exec.state_diff;
  if (exec.action !== 'import_state' || !diff) return '';
  const verdict = diff.level === 'direct'
    ? 'Direct — statuts, version, preuves et prochaine action seulement'
      + (diff.stale ? ' — <strong>mais le dernier import a changé depuis la demande : le coordinateur ne peut pas l’exécuter, vérifiez avant d’approuver</strong>'
        : ' — le coordinateur peut l’exécuter après approbation d’un relecteur indépendant, vous pouvez approuver sans lecture détaillée')
    : '<strong>À valider par vous</strong> — le coordinateur ne peut pas l’exécuter seul';
  const list = (items: string[]) => items.length ? '<ul>' + items.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>' : '';
  return '<dt>Verdict de l’import</dt><dd>' + verdict
    + (diff.reasons.length ? '<br>Raison(s) :' + list(diff.reasons) : '')
    + (diff.changes.length ? '<br>Changements reconnus :' + list(diff.changes) : '') + '</dd>';
}

function euros(cents: number): string {
  return (cents / 100).toFixed(2) + ' €';
}

/**
 * CC-AUTO T1 : bandeau synthétique lecture seule — nombre de demandes, état de
 * l'automatisation et budget visibles avant tout défilement. Aucun bouton ici :
 * l'unique bouton halt/resume reste dans la section Automatisation.
 */
function statusBanner(data: DashboardData): string {
  const halted = data.halted ?? false;
  const budget = data.budget
    ? ' · Budget restant ' + euros(data.budget.remaining_cents) + ' / ' + euros(data.budget.limit_cents)
    : '';
  return '<p><strong>' + data.pending.total + '</strong> demande(s) en attente · Automatisation '
    + (halted ? 'HALTÉE' : 'ACTIVE') + budget + '</p>'
    + (halted
      ? '<p class="halt">Arrêt d’urgence posé : aucune action automatique ne démarre.</p>'
      : '');
}

/** CC-4 A2 : arrêt d'urgence et enveloppe budgétaire globale. */
function automationSection(halted: boolean, budget: BudgetEnvelope | undefined, secret: string): string {
  const status = halted
    ? '<p class="halt">Arrêt d’urgence posé : aucune action automatique ne démarre (avance de phase par policy, réservation budgétaire, invocation). L’état est conservé.</p>'
    : '<p class="note">Automatisation active. L’arrêt d’urgence bloque toute nouvelle action automatique sans rien effacer.</p>';
  const button = '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="' + (halted ? 'resume' : 'halt') + '">'
    + secret + '<p><button type="submit">' + (halted ? 'Reprendre l’automatisation' : 'Arrêt d’urgence') + '</button></p></form></fieldset>';
  const money = budget
    ? '<table><tr><th>Plafond</th><th>Réservé</th><th>Dépensé</th><th>Restant</th></tr><tr><td>' + euros(budget.limit_cents) + '</td><td>'
      + euros(budget.reserved_cents) + '</td><td>' + euros(budget.spent_cents) + '</td><td>' + euros(budget.remaining_cents) + '</td></tr></table>'
      + '<p class="note">Enveloppe ' + escapeHtml(budget.scope) + ' : 0 € par défaut (Free d’abord). Toute dépense exige une enveloppe approuvée par le propriétaire.</p>'
    : '';
  return '<h2>Automatisation</h2>' + status + button + '<h2>Budget</h2>' + money;
}

function identityFamilySection(rows: Array<{ family_id: string; members: string[]; event_seq: number | null }>): string {
  const body = rows.map(row => '<tr><td><code>' + escapeHtml(row.family_id) + '</code></td><td>'
    + row.members.map(member => '<code>' + escapeHtml(member) + '</code>').join(', ')
    + '</td><td>' + (row.event_seq ?? '—') + '</td></tr>').join('');
  return '<h2>Identités logiques</h2><p class="note">Les identifiants restent distincts dans l’historique, mais une même famille compte comme un seul principal D12 et partage les droits de reprise.</p>'
    + (body ? '<table><tr><th>Identité</th><th>Identifiants historiques</th><th>Décision owner</th></tr>' + body + '</table>'
      : '<p class="note">Aucune équivalence configurée.</p>');
}

function relaySection(rows: RelayLine[]): string {
  const body = rows.map(row => '<tr><td>' + escapeHtml(row.label) + '</td><td>' + escapeHtml(row.message) + '</td><td>'
    + (row.since === null ? '—' : escapeHtml(new Date(row.since * 1000).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC')
    + '</td></tr>').join('');
  return '<h2>À relayer (' + rows.length + ')</h2>'
    + '<p class="note">Décisions courantes du contrôleur, en lecture seule : rien n’est envoyé ni exécuté. Copier le message à l’agent concerné.</p>'
    + (body ? '<table><tr><th>Pour</th><th>Message</th><th>Depuis</th></tr>' + body + '</table>' : '<p class="note">Rien à relayer.</p>');
}

function coordinatorSection(rows: Array<{ participant_id: string; display_label: string; event_seq: number | null }>): string {
  const body = rows.map(row => '<tr><td><code>' + escapeHtml(row.participant_id) + '</code></td><td>'
    + escapeHtml(row.display_label) + '</td><td>' + (row.event_seq ?? '—') + '</td></tr>').join('');
  return '<h2>Coordinateurs actifs</h2>'
    + '<p class="note">Ce rôle ne peut être accordé ou retiré que par une demande <code>grant_coordinator</code> approuvée ci-dessous.</p>'
    + (body ? '<table><tr><th>Participant</th><th>Libellé</th><th>Décision owner</th></tr>' + body + '</table>'
      : '<p class="note">Aucun coordinateur actif.</p>');
}

function capabilitiesText(caps: CapabilityRow['capability_set']): string {
  const parts = [
    caps.tools?.length ? 'outils : ' + caps.tools.join(', ') : '',
    caps.network_providers?.length ? 'fournisseurs : ' + caps.network_providers.join(', ') : '',
    caps.repositories?.length ? 'dépôts : ' + caps.repositories.join(', ') : '',
    caps.branch_paths?.length ? 'branches : ' + caps.branch_paths.join(', ') : '',
    caps.token_ceiling !== undefined ? 'jetons ≤ ' + caps.token_ceiling : '',
    caps.cost_ceiling !== undefined ? 'coût ≤ ' + caps.cost_ceiling : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'aucune (rien n’est autorisé)';
}

/**
 * CC-AUTO UX-0 : catalogue compact — un endpoint par fiche <details> repliée
 * par défaut, sans script ni nouveau contrat : seules les données du registre
 * sont affichées (aucun compteur inventé). La ligne de résumé garde visible,
 * sans déplier, l’identifiant, le statut et l’état de la dernière sonde (un
 * échec reste signalé) ; les formulaires Sonde / Tâche d’essai / Notes owner
 * sont conservés à l’identique : mêmes noms de champs, même action, preuve
 * owner exigée. Le tableau plat d’origine (une table par matrice) rendait la
 * page illisible au-delà de quelques endpoints sur mobile.
 */
function executorStatusCounts(rows: CapabilityRow[]): string {
  const counts = { active: 0, probe_required: 0, retired: 0, other: 0 };
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'probe_required' || row.status === 'retired') counts[row.status] += 1;
    else counts.other += 1;
  }
  return '<h2>Exécuteurs</h2>'
    + '<p class="note"><strong>' + rows.length + '</strong> endpoint(s) — actifs ' + counts.active
    + ' · à sonder ' + counts.probe_required + ' · retirés ' + counts.retired
    + (counts.other ? ' · autre ' + counts.other : '')
    + '. Dépliez une fiche pour sonder, lancer une tâche d’essai ou annoter.</p>';
}

function executorSection(rows: CapabilityRow[], secret: string): string {
  const options = OWNER_TRIAL_INSTRUCTIONS.map(item => '<option value="' + escapeHtml(item.key) + '">' + escapeHtml(item.label) + '</option>').join('');
  const items = rows.map(row => {
    const probeDetail = row.last_probe
      ? (row.last_probe.ok ? 'réussie' : 'en échec' + (row.last_probe.error ? ' (' + row.last_probe.error + ')' : '')) + ' · seq ' + row.last_probe.seq + ' · ' + row.last_probe.latency_ms + ' ms'
      : 'jamais sondé';
    const probeShort = row.last_probe
      ? (row.last_probe.ok ? '✔ sonde ' + row.last_probe.latency_ms + ' ms'
        : '⚠ sonde en échec' + (row.last_probe.error ? ' (' + row.last_probe.error + ')' : ''))
      : 'jamais sondé';
    const head = '<summary><code>' + escapeHtml(row.endpoint_id) + '</code> · ' + escapeHtml(row.status)
      + ' · ' + escapeHtml(probeShort) + '</summary>';
    const facts = '<dl>'
      + '<dt>Principal</dt><dd><code>' + escapeHtml(row.principal_id) + '</code></dd>'
      + '<dt>Attestation</dt><dd>' + escapeHtml(row.attestation_kind) + ' · <code>' + escapeHtml(row.attestation_ref) + '</code></dd>'
      + '<dt>Statut</dt><dd>' + escapeHtml(row.status) + '</dd>'
      + '<dt>Capacités</dt><dd>' + escapeHtml(capabilitiesText(row.capability_set)) + '</dd>'
      + '<dt>Dernière sonde</dt><dd>' + escapeHtml(probeDetail) + '</dd>'
      + '</dl>';
    const probeButton = row.attestation_kind === 'provider_adapter' && row.status !== 'retired'
      ? '<form method="post" action="/owner"><input type="hidden" name="action" value="probe_endpoint">'
        + '<input type="hidden" name="endpoint_id" value="' + escapeHtml(row.endpoint_id) + '">' + secret
        + '<button type="submit">Sonder</button></form>'
      : '';
    const trialForm = row.status === 'active'
      ? '<strong>Tâche d’essai</strong><form method="post" action="/owner">'
        + '<input type="hidden" name="action" value="run_trial"><input type="hidden" name="endpoint_id" value="' + escapeHtml(row.endpoint_id) + '">'
        + '<label>Consigne <select name="trial_instruction" required>' + options + '</select></label>'
        + '<label>Données <textarea name="trial_data" maxlength="' + OWNER_TRIAL_MAX_DATA + '" required></textarea></label>'
        + secret + '<p><button type="submit">Exécuter</button></p></form>'
      : '';
    const notes = row.owner_notes;
    const notesForm = '<strong>Notes owner</strong><form method="post" action="/owner">'
      + '<input type="hidden" name="action" value="update_executor_notes"><input type="hidden" name="endpoint_id" value="' + escapeHtml(row.endpoint_id) + '">'
      + '<label>Points forts <textarea name="strengths" maxlength="1000">' + escapeHtml(notes?.strengths ?? '') + '</textarea></label>'
      + '<label>Points faibles <textarea name="weaknesses" maxlength="1000">' + escapeHtml(notes?.weaknesses ?? '') + '</textarea></label>'
      + secret + '<p><button type="submit">Enregistrer les notes</button></p></form>';
    return '<details class="ep">' + head + facts + probeButton + trialForm + notesForm + '</details>';
  }).join('');
  return executorStatusCounts(rows)
    + (items ? items
      : '<p class="note">Aucun endpoint inscrit. Un agent prépare l’inscription ; vous l’approuvez dans les demandes en attente.</p>')
    + '<p class="note">Un endpoint ne devient actif qu’après une sonde réussie puis une demande d’activation approuvée. '
    + 'La sonde et la tâche d’essai font un appel réel au fournisseur gratuit avec des consignes fixées par le serveur.</p>';
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

/** CR-A / CR-03 : installation des définitions de phase d'un cycle (décision owner). */
function phaseSection(secret: string): string {
  return '<h2>Définitions de phase</h2>'
    + '<p class="note">Installe l’ensemble des phases d’un cycle (remplace l’ensemble précédent), enregistré comme décision owner. '
    + 'Laisser vide : P1–P6 sans condition, <code>auto_advance</code> = <code>none</code> (aucune avance tant qu’une policy n’est pas nommée). '
    + 'Format : liste JSON, par ex. <code>[{"phase":"P1","auto_advance":"cc3-p1"},{"phase":"P2"}]</code> ; champs facultatifs '
    + '<code>entry_conditions</code>, <code>exit_conditions</code>, <code>expected_outputs</code> ([{role, kind, count}]).</p>'
    + '<fieldset><form method="post" action="/owner"><input type="hidden" name="action" value="install_phases">'
    + '<label>Cycle <input type="text" name="cycle_id" required pattern="[a-z0-9][a-z0-9_-]{0,63}"></label>'
    + '<label>Définitions (JSON, facultatif) <textarea name="phases"></textarea></label>' + secret
    + '<p><button type="submit">Installer les phases</button></p></form></fieldset>';
}

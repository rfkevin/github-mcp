/**
 * CC-3 C5 — /owner route (I7). Mounted outside the OAuth providers: no MCP
 * token, scope or agent label grants anything here. Every request needs the
 * owner proof; without it the answer is 403 and nothing is read or written.
 */
import { CollabStoreError } from '../store/collab-store';
import { StateContractError } from '../../collab/contracts';
import { ownerChannelConfig, type OwnerChannelEnv } from './config';
import { defaultJwksResolver, verifyOwnerProof, type JwksResolver } from './proof';
import { listPendingRequests, listRegistry, mapClient, recordOwnerDecision, registerParticipant, unmapClient } from './decisions';
import { OWNER_PAGE_CSP, dashboardPage, loginPage } from './page';
import { unregisteredParticipantId } from '../identity';
import { importStateSnapshot, listImportedStates } from './state-import';
import { parseExportTarget } from '../export/state-import-plan';

export const OWNER_PATH = '/owner';
// CC-3 C6 : un import d'état CC-STATE-1 (≤ 256 Kio) passe par ce formulaire ; marge pour l'encodage.
const MAX_FORM_BYTES = 786_432;

export interface OwnerRouteEnv extends OwnerChannelEnv {
  COLLAB_DB?: D1Database;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': OWNER_PAGE_CSP,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  } });
}

function audit(action: string, outcome: string, reason?: string): void {
  // Closed vocabulary only: never the secret, the token, a form value or a subject.
  console.info(JSON.stringify({ service: 'owner-channel', action, outcome, ...(reason ? { reason } : {}) }));
}

function denied(reason: string): Response {
  audit('access', 'denied', reason);
  return new Response('Accès owner refusé.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

const ACTIONS = ['view', 'decide', 'register', 'map', 'unmap', 'import_state'] as const;

/** null when the channel is not configured: the caller lets the request fall through (404). */
export async function handleOwnerRequest(
  request: Request,
  env: OwnerRouteEnv,
  origin: string,
  jwks: JwksResolver = defaultJwksResolver,
  listClientIds: () => Promise<string[]> = async () => [],
): Promise<Response | null> {
  const config = ownerChannelConfig(env);
  if (!config || !env.COLLAB_DB) return null;
  const db = env.COLLAB_DB;

  if (request.method === 'GET') {
    if (config.mode === 'secret') return html(loginPage(config));
    const proof = await verifyOwnerProof(request, config, null, jwks);
    if (!proof) return denied('proof_invalid');
    audit('view', 'ok');
    return html(dashboardPage(config, { pending: await listPendingRequests(db), ...await listRegistry(db), imports: await listImportedStates(db) }));
  }
  if (request.method !== 'POST') {
    return new Response('Méthode non autorisée.', { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' } });
  }
  // Same-origin form posts only (CSRF guard, in addition to the proof).
  if (request.headers.get('Origin') !== origin) return denied('origin_mismatch');
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_FORM_BYTES) return denied('form_too_large');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return denied('form_invalid');
  }
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const proof = await verifyOwnerProof(request, config, config.mode === 'secret' ? field('owner_secret') : null, jwks);
  if (!proof) {
    return config.mode === 'secret'
      ? (audit('access', 'denied', 'proof_invalid'), html(loginPage(config, 'Preuve owner invalide.'), 403))
      : denied('proof_invalid');
  }
  const action = field('action');
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return denied('unknown_action');

  let message: { text: string; error: boolean } | undefined;
  try {
    const op = crypto.randomUUID();
    if (action === 'decide') {
      const result = await recordOwnerDecision(db, { request_id: field('request_id'), decision: field('decision'), proof });
      message = { text: (result.status === 'duplicate' ? 'Déjà enregistré : ' : 'Décision enregistrée : ')
        + result.decision + ' (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'register') {
      const result = await registerParticipant(db, { participant_id: field('participant_id'), display_label: field('display_label'), proof, op });
      message = { text: 'Participant enregistré (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'map') {
      const clientId = await resolveClientReference(field('oauth_client_id'), listClientIds);
      const result = await mapClient(db, { oauth_client_id: clientId, participant_id: field('participant_id'), proof, op });
      message = { text: 'Client associé (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'unmap') {
      const result = await unmapClient(db, { oauth_client_id: await resolveClientReference(field('oauth_client_id'), listClientIds), proof, op });
      message = { text: 'Association retirée (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'import_state') {
      const result = await importStateSnapshot(db, {
        cycle_id: field('cycle_id').trim(),
        markdown: field('state'),
        owner_label: field('owner_label'),
        target: parseExportTarget(field('target_repository'), field('target_path'), field('target_ref')),
        proof,
      });
      message = { text: (result.status === 'duplicate' ? 'Déjà importé' : 'État importé') + ' : révision ' + result.state_revision
        + ', ' + result.tasks + ' tâches, sha256 ' + result.content_sha256.slice(0, 12) + ' (seq ' + result.event.seq + ')'
        + (result.issue_refs.length ? ', issues indexées : ' + result.issue_refs.join(', ') : '')
        + (result.reassigned_issues.length ? '. Issues reprises à un autre cycle : ' + result.reassigned_issues.join(', ') : '')
        + (result.dropped_tasks.length ? '. Tâches retirées du store : ' + result.dropped_tasks.join(', ') : '') + '.', error: false };
    }
    audit(action, 'ok');
  } catch (error) {
    if (!(error instanceof CollabStoreError || error instanceof StateContractError)) {
      audit(action, 'error', 'unexpected_error');
      throw error;
    }
    audit(action, 'refused', error.code.toLowerCase());
    message = { text: error.code + ' : ' + error.message, error: true };
  }
  return html(dashboardPage(config, { pending: await listPendingRequests(db), ...await listRegistry(db), imports: await listImportedStates(db), message }),
    message?.error ? 409 : 200);
}

/**
 * Accepts a raw OAuth client id or the pseudonym `unregistered:…` shown in an
 * agent's owner.request, and returns the raw client id to map.
 */
export async function resolveClientReference(reference: string, listClientIds: () => Promise<string[]>): Promise<string> {
  const value = reference.trim();
  if (!value.startsWith('unregistered:')) return value;
  for (const clientId of await listClientIds()) {
    if (await unregisteredParticipantId(clientId) === value) return clientId;
  }
  throw new CollabStoreError('UNKNOWN_CLIENT', 'Aucun client OAuth enregistré ne correspond à ce pseudonyme.');
}

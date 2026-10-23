/**
 * CC-3 C5 — /owner route (I7). Mounted outside the OAuth providers: no MCP
 * token, scope or agent label grants anything here. Every request needs the
 * owner proof; without it the answer is 403 and nothing is read or written.
 */
import { CollabStoreError } from '../store/collab-store';
import { StateContractError } from '../../collab/contracts';
import { ownerChannelConfig, type OwnerChannelEnv } from './config';
import { defaultJwksResolver, verifyOwnerProof, type JwksResolver } from './proof';
import { listClassified, listPendingPage, listRegistry, mapClient, registerParticipant, unmapClient } from './decisions';
import { decideOwnerRequest, describePending } from './executable';
import { budgetEnvelope, isAutomationHalted, setAutomationHalt } from './automation';
import { OWNER_PAGE_CSP, dashboardPage, loginPage } from './page';
import { sightedClientIds, unregisteredParticipantId } from '../identity';
import { importStateSnapshot, listImportedStates } from './state-import';
import { parseExportTarget } from '../export/state-import-plan';
import { installPhaseDefinitions } from './phase-install';
import { capabilityMatrix } from '../executors/registry';
import { parseDailyCap, parseNeuronBudget, probeEndpoint, providerAdapterFactory, type ProviderAdapterEnv } from '../executors/run';
import { runOwnerTrial } from './trials';
import { listActiveCoordinators } from './coordinators';
import { appointCycleCoordinator } from './delegation-execution';
import { closeCycle, cycleStatusCounts } from './close';
import { classifyRequest } from './classify';
import { setExecutorNotes } from './executor-notes';
import { listIdentityFamilies } from '../identity/families';
import { relayLines } from '../controller/relay';

export const OWNER_PATH = '/owner';
// CC-3 C6 : un import d'état CC-STATE-1 (≤ 256 Kio) passe par ce formulaire ; marge pour l'encodage.
const MAX_FORM_BYTES = 786_432;

export interface OwnerRouteEnv extends OwnerChannelEnv, ProviderAdapterEnv {
  COLLAB_DB?: D1Database;
  /** CC-4 A3 : plafond quotidien d'appels par endpoint (défaut 50). */
  EXECUTOR_DAILY_CAP?: string;
  /** CC-4 A3 : budget journalier de neurons Workers AI (défaut 8 000, max 9 500, sous les 10 000 gratuits). */
  WORKERS_AI_DAILY_NEURONS?: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': OWNER_PAGE_CSP,
    'X-Frame-Options': 'DENY',
    // Same-origin HTML form POSTs must retain Origin for the strict CSRF check below.
    'Referrer-Policy': 'same-origin',
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

export const ACTIONS = ['view', 'decide', 'register', 'map', 'unmap', 'import_state', 'install_phases', 'halt', 'resume', 'probe_endpoint', 'run_trial', 'update_executor_notes', 'appoint_cycle_coordinator', 'close_cycle', 'classify_request'] as const;

/** CC-4 A2 : données du tableau de bord (demandes décrites, arrêt d'urgence, budget). */
async function dashboardData(db: D1Database, before?: number) {
  return {
    pending: await describePending(await listPendingPage(db, { before }), undefined, db),
    // CC-Owner V2 L3 : audit des demandes classées (jamais effacées).
    classified: await listClassified(db),
    ...await listRegistry(db),
    identityFamilies: await listIdentityFamilies(db),
    imports: await listImportedStates(db),
    halted: await isAutomationHalted(db),
    budget: await budgetEnvelope(db),
    coordinators: await listActiveCoordinators(db),
    executors: await capabilityMatrix(db),
    // CC-5 l3d 2b-2a : messages à relayer (lecture seule ; une panne n'empêche jamais la page).
    relay: await relayLines(db).catch(() => []),
    // CC-Owner V2 L4 : synthèse des statuts de cycle pour le bandeau (lecture seule).
    cycles: await cycleStatusCounts(db),
  };
}

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
    return html(dashboardPage(config, await dashboardData(db)));
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
      // F2/A02 : la décision vise la demande affichée (seq immuable), jamais une homonyme arrivée depuis.
      const seqField = field('request_seq').trim();
      // CC-4 A2 : une demande exécutable approuvée est exécutée à l'identique (empreinte affichée), sinon décision seule.
      const result = await decideOwnerRequest(db, {
        request_id: field('request_id'), decision: field('decision'), proof,
        request_seq: seqField ? Number(seqField) : undefined, cycle_id: field('cycle_id') || undefined,
        payload_sha256: field('payload_sha256') || undefined,
      });
      message = { text: (result.status === 'duplicate' ? 'Déjà enregistré : ' : 'Décision enregistrée : ')
        + result.decision + ' (seq ' + result.event.seq + ').'
        + (result.executed ? ' Exécuté : ' + result.executed.action + ' sur ' + result.executed.cycle_id + ' — ' + result.executed.detail + '.' : '')
        // CR-F02 : reprise mémoire appliquée dans la transaction de la décision.
        + (result.memory_resume ? ' Activations mémoire reprises pour le scope ' + result.memory_resume.scope
          + ' (occurrence ' + result.memory_resume.occurrence + ').' : ''), error: false };
    } else if (action === 'appoint_cycle_coordinator') {
      const vacancy = field('participant_id').trim() === '';
      const result = await appointCycleCoordinator(db, {
        cycleId: field('cycle_id').trim(),
        participantId: vacancy ? null : field('participant_id').trim(),
        familyId: vacancy ? null : field('family_id').trim(),
        expectedEpoch: Number(field('expected_epoch')),
        proof, op,
      });
      message = { text: 'Mandat du cycle mis à jour (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'close_cycle') {
      // CC-Owner V2 L2 : clôture d'un cycle — refuse-soft (compte affiché), force avec motif et confirmation.
      const result = await closeCycle(db, {
        cycle_id: field('cycle_id'), force: field('force') === 'on',
        reason: field('reason'), confirm: field('confirm'), proof, op,
      });
      const closedAs = JSON.parse(result.event.payload_json) as { pending_requests?: number; active_tasks?: number };
      message = { text: (result.status === 'duplicate' ? 'Cycle déjà clos : ' : 'Cycle clos : ')
        + result.cycle_id + ' (seq ' + result.event.seq + ') — '
        + (closedAs.pending_requests ?? 0) + ' demande(s) d’agent encore en attente, '
        + (closedAs.active_tasks ?? 0) + ' tâche(s) active(s)'
        + (result.force ? ', clôture forcée (motif journalisé)' : '') + '.', error: false };
    } else if (action === 'classify_request') {
      // CC-Owner V2 L3 : classification owner d'une demande — drain append-only, pas une décision.
      const seqField = field('request_seq').trim();
      const result = await classifyRequest(db, {
        request_seq: seqField ? Number(seqField) : 0, verdict: field('verdict'),
        note: field('note'), proof, op,
      });
      message = { text: (result.status === 'duplicate' ? 'Déjà classée : ' : 'Demande classée : seq ')
        + result.request_seq + ' — verdict ' + result.verdict + ' (' + result.cycle_id + ', événement seq '
        + result.event.seq + ').', error: false };
    } else if (action === 'register') {
      const result = await registerParticipant(db, { participant_id: field('participant_id'), display_label: field('display_label'), proof, op });
      message = { text: 'Participant enregistré (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'map') {
      const clientId = await resolveClientReference(field('oauth_client_id'), listClientIds, db);
      const result = await mapClient(db, { oauth_client_id: clientId, participant_id: field('participant_id'), proof, op });
      message = { text: 'Client associé (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'unmap') {
      const result = await unmapClient(db, { oauth_client_id: await resolveClientReference(field('oauth_client_id'), listClientIds, db), proof, op });
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
    } else if (action === 'halt' || action === 'resume') {
      // CC-4 A2 : arrêt d'urgence de toute action automatique (état conservé).
      const result = await setAutomationHalt(db, { halted: action === 'halt', proof, op });
      message = { text: (action === 'halt' ? 'Arrêt d’urgence posé' : 'Automatisation reprise') + ' (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'probe_endpoint') {
      // CC-4 A3 : sonde réelle de l'endpoint (paquet fixe du serveur), seule preuve permettant son activation.
      const result = await probeEndpoint(db, providerAdapterFactory(env), {
        endpoint_id: field('endpoint_id'), proof, op, daily_cap: parseDailyCap(env.EXECUTOR_DAILY_CAP),
        neuron_budget: parseNeuronBudget(env.WORKERS_AI_DAILY_NEURONS),
      });
      message = { text: 'Sonde ' + (result.ok ? 'réussie' : 'en échec' + (result.error ? ' (' + result.error + ')' : '')
        + (result.error_detail ? ' : ' + result.error_detail : ''))
        + ' pour ' + field('endpoint_id') + ' (seq ' + result.event.seq + ').', error: !result.ok };
    } else if (action === 'run_trial') {
      const result = await runOwnerTrial(db, providerAdapterFactory(env), {
        endpoint_id: field('endpoint_id'), instruction: field('trial_instruction'), data: field('trial_data'),
        daily_cap: parseDailyCap(env.EXECUTOR_DAILY_CAP), neuron_budget: parseNeuronBudget(env.WORKERS_AI_DAILY_NEURONS),
      });
      message = result.status === 'succeeded'
        ? { text: 'Tâche d’essai réussie sur ' + field('endpoint_id') + '. Réponse : ' + (result.output ?? ''), error: false }
        : { text: 'Tâche d’essai non terminée (' + result.status + ')' + (result.error ? ' : ' + result.error : '') + '.', error: true };
    } else if (action === 'update_executor_notes') {
      const result = await setExecutorNotes(db, {
        endpoint_id: field('endpoint_id'), strengths: field('strengths'), weaknesses: field('weaknesses'), proof, op,
      });
      message = { text: 'Notes owner enregistrées pour ' + field('endpoint_id') + ' (seq ' + result.event.seq + ').', error: false };
    } else if (action === 'install_phases') {
      // CR-A / CR-03 : amorçage owner des définitions de phase (vide = P1–P6, auto_advance none).
      const result = await installPhaseDefinitions(db, { cycle_id: field('cycle_id'), definitions: field('phases'), proof });
      message = { text: (result.status === 'duplicate' ? 'Déjà installées' : 'Phases installées') + ' pour ' + result.event.cycle_id + ' : '
        + result.phases.map(item => item.phase + ' (' + item.auto_advance + ')').join(', ')
        + ', sha256 ' + result.definitions_sha256.slice(0, 12) + ' (seq ' + result.event.seq + ').', error: false };
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
  // F2/A06 : pagination des demandes après filtrage ; `before` vient du bouton « plus anciennes ».
  const before = action === 'view' && /^[1-9][0-9]{0,15}$/.test(field('before')) ? Number(field('before')) : undefined;
  return html(dashboardPage(config, { ...await dashboardData(db, before), message }), message?.error ? 409 : 200);
}

/**
 * Accepts a raw OAuth client id or the pseudonym `unregistered:…` shown in an
 * agent's owner.request, and returns the raw client id to map.
 *
 * A pseudonym resolves only to a client id the server knows by itself: a
 * client authenticated on /collab/mcp (client sightings, the only source for
 * CIMD clients) or a registered OAuth client (listClients). Every candidate is
 * re-hashed, so a row that does not hash to the pseudonym is ignored; a
 * pseudonym matching no client, or more than one, is refused (UNKNOWN_CLIENT).
 */
export async function resolveClientReference(
  reference: string,
  listClientIds: () => Promise<string[]>,
  db?: D1Database,
): Promise<string> {
  const value = reference.trim();
  if (!value.startsWith('unregistered:')) return value;
  const matching = async (ids: string[]) => {
    const found = new Set<string>();
    for (const clientId of ids) if (await unregisteredParticipantId(clientId) === value) found.add(clientId);
    return [...found];
  };
  let matches = db ? await matching(await sightedClientIds(db, value)) : [];
  if (matches.length === 0) matches = await matching(await listClientIds());
  if (matches.length === 1) return matches[0];
  throw new CollabStoreError('UNKNOWN_CLIENT', matches.length === 0
    ? 'Aucun client OAuth authentifié ou enregistré ne correspond à ce pseudonyme : le client doit d’abord appeler /collab/mcp avec son jeton.'
    : 'Pseudonyme ambigu : associez le client par son identifiant OAuth brut.');
}

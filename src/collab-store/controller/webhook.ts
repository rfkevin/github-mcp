/**
 * CC-5 l3d (incrément 2d) — déclenchement du contrôleur par webhook GitHub.
 *
 * Le webhook ne fait RIEN de plus que le passage programmé : il lance le même
 * passage du contrôleur (journal des décisions, rappels bornés, file des
 * échecs), plus tôt qu'un Cron. Aucune fusion, aucun dispatch, aucune dépense ;
 * HALT met le contrôleur en mode `halted`.
 *
 * Fail-closed, dans cet ordre, avant toute lecture du corps comme JSON :
 *   1. éteint (404, comme une route inconnue) sauf CONTROLLER_WEBHOOK_ENABLED
 *      exactement « true », store monté et secret GITHUB_WEBHOOK_SECRET posé ;
 *   2. POST seulement (405) ; corps borné à WEBHOOK_BODY_MAX octets (413) ;
 *   3. signature X-Hub-Signature-256 (HMAC SHA-256 du corps brut, comparaison
 *      en temps constant par crypto.subtle.verify) — sinon 401, rien n'est écrit ;
 *   4. livraison de NOTRE installation GitHub App (GITHUB_INSTALLATION_ID),
 *      sinon 403 ; le `ping` d'une GitHub App ne porte pas d'installation :
 *      il est reconnu par `hook.app_id` = GITHUB_APP_ID (sinon 403) et ne
 *      fait rien d'autre que répondre `pong` ;
 *   5. chaque X-GitHub-Delivery n'est traité qu'une fois (rejeu → 200
 *      duplicate) ; au plus un passage par WEBHOOK_MIN_INTERVAL_S, arbitré dans
 *      UN lot D1 par une ligne de verrou unique (`controller_webhook_window`) :
 *      une livraison ne lance le passage que si ELLE a réclamé la fenêtre (CAS
 *      sur la date du dernier passage, réclamation signée par son identifiant).
 *      Les autres livraisons sont consignées `coalesced` : le passage suivant ou
 *      le Cron les rattrape, le contrôleur relit tout le store.
 * Le secret est posé par Kevin (Cloudflare) et dans la GitHub App ; il n'est
 * jamais journalisé ni renvoyé.
 */
import { ensureSchema } from '../store/schema';
import { runScheduledControllers } from './scheduled';

export const WEBHOOK_PATH = '/github/webhook';
export const WEBHOOK_BODY_MAX = 256 * 1024;
export const WEBHOOK_MIN_INTERVAL_S = 60;
/** Une réclamation datée de plus que cela dans le futur (horloge reculée) est périmée : la fenêtre ne se bloque jamais. */
export const WEBHOOK_CLOCK_SKEW_S = 300;
/** Rétention des livraisons consignées (anti-rejeu) : GitHub ne rejoue pas au-delà. */
export const WEBHOOK_RETENTION_S = 7 * 24 * 3600;
/** Événements qui peuvent changer une décision du contrôleur (PR, verdicts publiés, CI). */
export const WEBHOOK_EVENTS = ['pull_request', 'pull_request_review', 'issue_comment', 'check_run', 'check_suite', 'push', 'status'] as const;

const DELIVERY_RE = /^[0-9a-f-]{8,64}$/i;
const EVENT_RE = /^[a-z_]{1,64}$/;

export interface WebhookEnv {
  COLLAB_DB?: D1Database;
  COLLAB_STORE_ENABLED?: string;
  CONTROLLER_WEBHOOK_ENABLED?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_INSTALLATION_ID?: string;
  /** Identifiant de la GitHub App : seul moyen d'attribuer son `ping` (sans installation). */
  GITHUB_APP_ID?: string;
}

export type WebhookOutcome = 'accepted' | 'coalesced' | 'ignored' | 'pong' | 'duplicate';

export function webhookEnabled(env: WebhookEnv): boolean {
  return env.CONTROLLER_WEBHOOK_ENABLED === 'true' && env.COLLAB_STORE_ENABLED === 'true' && !!env.COLLAB_DB
    && typeof env.GITHUB_WEBHOOK_SECRET === 'string' && env.GITHUB_WEBHOOK_SECRET.length >= 16;
}

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** X-Hub-Signature-256 = « sha256= » + HMAC hex du corps brut. Vérification en temps constant (WebCrypto). */
export async function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const signature = hexToBytes(header.slice('sha256='.length));
  if (!signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature, body);
}

async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let next = await reader.read();
  while (!next.done) {
    size += next.value.byteLength;
    if (size > WEBHOOK_BODY_MAX) {
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
    next = await reader.read();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

const INIT = [
  ['CREATE TABLE IF NOT EXISTS controller_webhook_deliveries (',
    '  delivery_id TEXT PRIMARY KEY,',
    '  event TEXT NOT NULL,',
    '  outcome TEXT NOT NULL,',
    '  received_at INTEGER NOT NULL',
    ')'].join(' '),
  'CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_at ON controller_webhook_deliveries(received_at)',
  // Verrou de cadence : UNE ligne (id = 1), date du dernier passage lancé et livraison qui l'a réclamé.
  ['CREATE TABLE IF NOT EXISTS controller_webhook_window (',
    '  id INTEGER PRIMARY KEY CHECK (id = 1),',
    '  last_run_at INTEGER NOT NULL,',
    '  claimed_by TEXT NOT NULL',
    ')'].join(' '),
  "INSERT OR IGNORE INTO controller_webhook_window (id, last_run_at, claimed_by) VALUES (1, 0, '')",
];

export async function ensureWebhookDeliveries(db: D1Database): Promise<void> {
  await ensureSchema(db);
  await db.batch(INIT.map(sql => db.prepare(sql)));
}

/**
 * Consigne la livraison et arbitre la fenêtre de cadence dans UN lot (transaction D1, exécutée en série) :
 *   1. purge des livraisons de plus de 7 jours ;
 *   2. réclamation CAS du verrou : seulement si l'événement peut lancer un passage, si la livraison est nouvelle
 *      et si le dernier passage date d'au moins WEBHOOK_MIN_INTERVAL_S ; la réclamation porte l'identifiant ;
 *   3. consignation de la livraison (INSERT OR IGNORE : rejeu → aucune ligne), `accepted` seulement si le verrou
 *      porte SON identifiant, sinon `coalesced` (ou `ignored` pour un événement hors liste).
 * Deux livraisons simultanées ne peuvent donc pas être toutes deux `accepted` dans la même fenêtre.
 */
async function recordDelivery(db: D1Database, deliveryId: string, event: string, at: number, runnable: boolean): Promise<WebhookOutcome> {
  const [, , inserted] = await db.batch([
    db.prepare('DELETE FROM controller_webhook_deliveries WHERE received_at < ?1').bind(at - WEBHOOK_RETENTION_S),
    db.prepare([
      'UPDATE controller_webhook_window SET last_run_at = ?1, claimed_by = ?2',
      'WHERE id = 1 AND ?3 = 1 AND (last_run_at <= ?1 - ?4 OR last_run_at > ?1 + ?5)',
      '  AND NOT EXISTS (SELECT 1 FROM controller_webhook_deliveries WHERE delivery_id = ?2)',
    ].join(' ')).bind(at, deliveryId, runnable ? 1 : 0, WEBHOOK_MIN_INTERVAL_S, WEBHOOK_CLOCK_SKEW_S),
    db.prepare([
      'INSERT OR IGNORE INTO controller_webhook_deliveries (delivery_id, event, outcome, received_at)',
      "SELECT ?1, ?2, CASE WHEN ?4 = 0 THEN 'ignored'",
      "  WHEN (SELECT claimed_by FROM controller_webhook_window WHERE id = 1) = ?1 THEN 'accepted' ELSE 'coalesced' END, ?3",
    ].join(' ')).bind(deliveryId, event, at, runnable ? 1 : 0),
  ]);
  if ((inserted.meta?.changes ?? 0) === 0) return 'duplicate';
  const row = await db.prepare('SELECT outcome FROM controller_webhook_deliveries WHERE delivery_id = ?1').bind(deliveryId)
    .first<{ outcome: WebhookOutcome }>();
  return row?.outcome ?? 'ignored';
}

/**
 * Traite POST /github/webhook. Renvoie null si le webhook est éteint (la route
 * retombe sur le 404 habituel : son existence n'est pas révélée).
 */
export async function handleGitHubWebhook(request: Request, env: WebhookEnv, ctx: { waitUntil(promise: Promise<unknown>): void },
  options: { now?: () => Date } = {}): Promise<Response | null> {
  if (!webhookEnabled(env)) return null;
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = await readBounded(request);
  if (!body) return reply(413, { error: 'payload_too_large' });
  if (!await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET!, body, request.headers.get('x-hub-signature-256'))) {
    return reply(401, { error: 'invalid_signature' });
  }
  const event = request.headers.get('x-github-event') ?? '';
  const deliveryId = request.headers.get('x-github-delivery') ?? '';
  if (!EVENT_RE.test(event) || !DELIVERY_RE.test(deliveryId)) return reply(400, { error: 'invalid_headers' });
  let payload: { installation?: { id?: unknown }; hook?: { app_id?: unknown } } | null = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(body)) as { installation?: { id?: unknown }; hook?: { app_id?: unknown } };
  } catch {
    return reply(400, { error: 'invalid_json' });
  }
  if (event === 'ping' && payload?.installation === undefined) {
    // Ping d'une GitHub App (création ou « Redeliver ») : aucune installation, seulement hook.app_id. Aucune écriture.
    const app = payload?.hook?.app_id;
    if (!env.GITHUB_APP_ID || String(app ?? '') !== env.GITHUB_APP_ID) return reply(403, { error: 'unknown_app' });
    return reply(200, { outcome: 'pong' satisfies WebhookOutcome });
  }
  const installation = payload?.installation?.id;
  if (!env.GITHUB_INSTALLATION_ID || String(installation ?? '') !== env.GITHUB_INSTALLATION_ID) {
    return reply(403, { error: 'unknown_installation' });
  }
  if (event === 'ping') return reply(200, { outcome: 'pong' satisfies WebhookOutcome });

  const db = env.COLLAB_DB!;
  await ensureWebhookDeliveries(db);
  const now = options.now ?? (() => new Date());
  const at = Math.floor(now().getTime() / 1000);
  const runnable = (WEBHOOK_EVENTS as readonly string[]).includes(event);
  const outcome = await recordDelivery(db, deliveryId, event, at, runnable);
  if (outcome === 'accepted') {
    // Même passage que le Cron, sans le chercheur L5 (déjà quotidien et indépendant des événements GitHub).
    ctx.waitUntil(runScheduledControllers(db, { now, research: false }).catch(() => undefined));
    return reply(202, { outcome });
  }
  return reply(outcome === 'duplicate' || outcome === 'ignored' ? 200 : 202, { outcome });
}

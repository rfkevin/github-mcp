import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_BODY_MAX, WEBHOOK_MIN_INTERVAL_S, WEBHOOK_PATH, handleGitHubWebhook, verifyGitHubSignature, webhookEnabled, type WebhookEnv,
} from '../../../src/collab-store/controller/webhook';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertPhaseDefinition, insertTaskRow } from '../a0-helpers';
import { createOAuthFixture } from '../../oauth/helpers';
import { racingBatch } from '../coordinator-helpers';

// CC-5 l3d (incrément 2d) — webhook GitHub du contrôleur : éteint par défaut, signature HMAC, anti-rejeu, cadence bornée.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const SECRET = 'test-only-webhook-secret-0123456789';
let n = 0;
const uniq = (label: string) => (label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);

function enabledEnv(overrides: Partial<WebhookEnv> = {}): WebhookEnv {
  return { COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', CONTROLLER_WEBHOOK_ENABLED: 'true', GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_INSTALLATION_ID: '42', GITHUB_APP_ID: '5122110', ...overrides };
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'sha256=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
}

let deliveryN = 0;
const deliveryId = () => '0000' + (++deliveryN).toString(16).padStart(4, '0') + '-' + Date.now().toString(16) + '-4c3d';

async function delivery(options: { event?: string; installation?: unknown; secret?: string; id?: string; body?: string; method?: string } = {}) {
  const body = options.body ?? JSON.stringify({ action: 'synchronize', installation: { id: options.installation ?? 42 } });
  return new Request('https://example.test' + WEBHOOK_PATH, {
    method: options.method ?? 'POST', body: options.method === 'GET' ? undefined : body,
    headers: { 'x-github-event': options.event ?? 'pull_request', 'x-github-delivery': options.id ?? deliveryId(),
      'x-hub-signature-256': await sign(options.secret ?? SECRET, body), 'content-type': 'application/json' },
  });
}

function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } };
}

let hour = 0;
/** Instant propre à chaque test (heures distinctes) : la fenêtre de cadence est globale à la base. */
const clockAt = (offsetS = 0) => { const base = Date.UTC(2031, 0, 1) + (++hour) * 3600_000; return () => new Date(base + offsetS * 1000); };

async function rows(id: string): Promise<number> {
  try {
    return (await db.prepare('SELECT COUNT(*) AS n FROM controller_webhook_deliveries WHERE delivery_id = ?1').bind(id).first<{ n: number }>())!.n;
  } catch {
    return 0; // table pas encore créée : rien n'a été écrit
  }
}

describe('CC-5 l3d 2d — webhook GitHub : fail-closed', () => {
  it('éteint par défaut : drapeau absent ou faux, secret absent ou trop court, store non monté → null (404 habituel)', async () => {
    for (const overrides of [{ CONTROLLER_WEBHOOK_ENABLED: undefined }, { CONTROLLER_WEBHOOK_ENABLED: 'TRUE' }, { GITHUB_WEBHOOK_SECRET: undefined },
      { GITHUB_WEBHOOK_SECRET: 'court' }, { COLLAB_STORE_ENABLED: 'false' }, { COLLAB_DB: undefined }] as Partial<WebhookEnv>[]) {
      expect(webhookEnabled(enabledEnv(overrides))).toBe(false);
      expect(await handleGitHubWebhook(await delivery(), enabledEnv(overrides), context().ctx)).toBeNull();
    }
  });

  it('méthode, taille, signature, en-têtes, installation : refus avant toute écriture', async () => {
    const { ctx, pending } = context();
    expect((await handleGitHubWebhook(await delivery({ method: 'GET' }), enabledEnv(), ctx))!.status).toBe(405);
    const big = await delivery({ body: JSON.stringify({ installation: { id: 42 }, pad: 'x'.repeat(WEBHOOK_BODY_MAX) }) });
    expect((await handleGitHubWebhook(big, enabledEnv(), ctx))!.status).toBe(413);
    const forgedId = deliveryId();
    expect((await handleGitHubWebhook(await delivery({ secret: 'autre-secret-de-test-0123456789', id: forgedId }), enabledEnv(), ctx))!.status).toBe(401);
    expect(await rows(forgedId)).toBe(0);
    const noSig = new Request('https://example.test' + WEBHOOK_PATH, { method: 'POST', body: '{}', headers: { 'x-github-event': 'push', 'x-github-delivery': deliveryId() } });
    expect((await handleGitHubWebhook(noSig, enabledEnv(), ctx))!.status).toBe(401);
    expect((await handleGitHubWebhook(await delivery({ id: 'pas un id !' }), enabledEnv(), ctx))!.status).toBe(400);
    const foreignId = deliveryId();
    expect((await handleGitHubWebhook(await delivery({ installation: 7, id: foreignId }), enabledEnv(), ctx))!.status).toBe(403);
    expect((await handleGitHubWebhook(await delivery({ installation: undefined, body: '{"installation":{}}' }), enabledEnv(), ctx))!.status).toBe(403);
    expect(await rows(foreignId)).toBe(0);
    expect(pending).toEqual([]); // aucun passage lancé
  });

  it('verifyGitHubSignature : seul le HMAC exact du corps brut passe', async () => {
    const body = new TextEncoder().encode('{"a":1}');
    const good = await sign(SECRET, '{"a":1}');
    expect(await verifyGitHubSignature(SECRET, body, good)).toBe(true);
    expect(await verifyGitHubSignature(SECRET, new TextEncoder().encode('{"a":2}'), good)).toBe(false);
    expect(await verifyGitHubSignature(SECRET, body, good.replace('sha256=', 'sha1='))).toBe(false);
    expect(await verifyGitHubSignature(SECRET, body, 'sha256=' + 'z'.repeat(64))).toBe(false);
    expect(await verifyGitHubSignature(SECRET, body, null)).toBe(false);
  });
});

describe('CC-5 l3d 2d — webhook GitHub : passage du contrôleur', () => {
  it('ping de GitHub App (sans installation) : pong seulement pour notre app_id, sans écriture', async () => {
    const appPing = (appId: unknown) => JSON.stringify({ zen: 'z', hook_id: 1, hook: { type: 'App', id: 1, app_id: appId } });
    const okId = deliveryId();
    const ok = await handleGitHubWebhook(await delivery({ event: 'ping', id: okId, body: appPing(5122110) }), enabledEnv(), context().ctx);
    expect(ok!.status).toBe(200);
    expect(await ok!.json()).toEqual({ outcome: 'pong' });
    expect(await rows(okId)).toBe(0);
    for (const body of [appPing(7), appPing(undefined), JSON.stringify({ zen: 'z' })]) {
      const refused = await handleGitHubWebhook(await delivery({ event: 'ping', body }), enabledEnv(), context().ctx);
      expect(refused!.status).toBe(403);
    }
    expect((await handleGitHubWebhook(await delivery({ event: 'ping', body: appPing(5122110) }), enabledEnv({ GITHUB_APP_ID: undefined }), context().ctx))!.status).toBe(403);
    // Signature fausse : 401 avant toute reconnaissance du ping.
    expect((await handleGitHubWebhook(await delivery({ event: 'ping', body: appPing(5122110), secret: 'autre-secret-0123456789' }), enabledEnv(), context().ctx))!.status).toBe(401);
    // Contre-épreuve (revue GPT-6) : un ping portant une installation étrangère suit la garde d'installation → 403, même avec notre app_id.
    const foreign = JSON.stringify({ zen: 'z', hook: { app_id: 5122110 }, installation: { id: 7 } });
    const foreignRes = await handleGitHubWebhook(await delivery({ event: 'ping', body: foreign }), enabledEnv(), context().ctx);
    expect(foreignRes!.status).toBe(403);
    expect(await foreignRes!.json()).toEqual({ error: 'unknown_installation' });
    // Un événement ordinaire ne peut pas se faire passer pour un ping d'app.
    expect((await handleGitHubWebhook(await delivery({ event: 'pull_request', body: appPing(5122110) }), enabledEnv(), context().ctx))!.status).toBe(403);
  });
  it('livraison valide → 202, le même passage que le Cron journalise les décisions ; ping → pong sans écriture', async () => {
    await ensureSchema(db);
    const cycle = uniq('wh');
    await insertCycleRow(db, cycle, 'P6');
    await insertPhaseDefinition(db, cycle, 'P6', []);
    await insertTaskRow(db, { taskId: 't0', cycle, owner: 'wa-' + cycle, reviewer: 'wb-' + cycle, tester: 'wc-' + cycle });
    const now = clockAt();
    const pongId = deliveryId();
    const pong = await handleGitHubWebhook(await delivery({ event: 'ping', id: pongId }), enabledEnv(), context().ctx, { now });
    expect(await pong!.json()).toEqual({ outcome: 'pong' });
    expect(await rows(pongId)).toBe(0);
    const { ctx, pending } = context();
    const response = await handleGitHubWebhook(await delivery(), enabledEnv(), ctx, { now });
    expect(response!.status).toBe(202);
    expect(await response!.json()).toEqual({ outcome: 'accepted' });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const journal = await db.prepare("SELECT action FROM controller_decisions WHERE cycle_id = ?1").bind(cycle).all<{ action: string }>();
    expect(journal.results.map(row => row.action)).toEqual(['implement']);
  });

  it('rejeu de la même livraison → duplicate sans second passage ; événement hors liste → ignored sans passage', async () => {
    const now = clockAt();
    const id = deliveryId();
    const first = context();
    expect((await handleGitHubWebhook(await delivery({ id }), enabledEnv(), first.ctx, { now }))!.status).toBe(202);
    const again = context();
    const replay = await handleGitHubWebhook(await delivery({ id }), enabledEnv(), again.ctx, { now });
    expect(await replay!.json()).toEqual({ outcome: 'duplicate' });
    expect(again.pending).toEqual([]);
    const star = context();
    const ignored = await handleGitHubWebhook(await delivery({ event: 'star' }), enabledEnv(), star.ctx, { now: clockAt() });
    expect(await ignored!.json()).toEqual({ outcome: 'ignored' });
    expect(star.pending).toEqual([]);
    await Promise.all(first.pending);
  });

  it('cadence : une autre livraison dans la fenêtre → coalesced sans passage ; après la fenêtre → nouveau passage', async () => {
    const base = Date.UTC(2032, 5, 1);
    const at = (s: number) => () => new Date(base + s * 1000);
    const a = context();
    expect(await (await handleGitHubWebhook(await delivery(), enabledEnv(), a.ctx, { now: at(0) }))!.json()).toEqual({ outcome: 'accepted' });
    const b = context();
    expect(await (await handleGitHubWebhook(await delivery({ event: 'check_run' }), enabledEnv(), b.ctx, { now: at(WEBHOOK_MIN_INTERVAL_S - 1) }))!.json())
      .toEqual({ outcome: 'coalesced' });
    expect(b.pending).toEqual([]);
    const c = context();
    expect(await (await handleGitHubWebhook(await delivery({ event: 'push' }), enabledEnv(), c.ctx, { now: at(WEBHOOK_MIN_INTERVAL_S + 1) }))!.json())
      .toEqual({ outcome: 'accepted' });
    expect(c.pending).toHaveLength(1);
    await Promise.all([...a.pending, ...c.pending]);
  });
});

describe('CC-5 l3d 2d — cadence sous concurrence (revue GPT-6 #180)', () => {
  it('une livraison concurrente réclame la fenêtre juste avant le lot d\'une autre : un seul passage, l\'autre coalesced', async () => {
    const now = () => new Date(Date.UTC(2033, 2, 1));
    const b = context();
    let competing: Response | null = null;
    // Juste avant le lot d'écriture de A (3 instructions), B est traitée en entier.
    const racing = racingBatch(db, 3, async () => {
      competing = await handleGitHubWebhook(await delivery({ event: 'check_run' }), enabledEnv(), b.ctx, { now });
    });
    const a = context();
    const first = await handleGitHubWebhook(await delivery(), enabledEnv({ COLLAB_DB: racing }), a.ctx, { now });
    expect(await competing!.json()).toEqual({ outcome: 'accepted' });
    expect(await first!.json()).toEqual({ outcome: 'coalesced' });
    expect(a.pending.length + b.pending.length).toBe(1);
    await Promise.all([...a.pending, ...b.pending]);
  });

  it('deux livraisons distinctes lancées en même temps : exactement une acceptée', async () => {
    const now = () => new Date(Date.UTC(2033, 3, 1));
    const x = context();
    const y = context();
    const [rx, ry] = await Promise.all([
      handleGitHubWebhook(await delivery(), enabledEnv(), x.ctx, { now }),
      handleGitHubWebhook(await delivery({ event: 'push' }), enabledEnv(), y.ctx, { now }),
    ]);
    const outcomes = [((await rx!.json()) as { outcome: string }).outcome, ((await ry!.json()) as { outcome: string }).outcome].sort();
    expect(outcomes).toEqual(['accepted', 'coalesced']);
    expect(x.pending.length + y.pending.length).toBe(1);
    await Promise.all([...x.pending, ...y.pending]);
  });

  it('horloge reculée : une réclamation datée loin dans le futur ne bloque pas la fenêtre', async () => {
    await handleGitHubWebhook(await delivery(), enabledEnv(), context().ctx, { now: () => new Date(Date.UTC(2040, 0, 1)) });
    const later = context();
    const response = await handleGitHubWebhook(await delivery(), enabledEnv(), later.ctx, { now: () => new Date(Date.UTC(2034, 0, 1)) });
    expect(await response!.json()).toEqual({ outcome: 'accepted' });
    await Promise.all(later.pending);
  });
});

describe('CC-5 l3d 2d — route du Worker', () => {
  it('éteint : POST /github/webhook répond le 404 habituel ; allumé : livraison signée acceptée', async () => {
    const off = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true' });
    const body = JSON.stringify({ installation: { id: 2 } });
    const headers = async () => ({ 'x-github-event': 'pull_request', 'x-github-delivery': deliveryId(), 'x-hub-signature-256': await sign(SECRET, body) });
    expect((await off.send(WEBHOOK_PATH, { method: 'POST', body, headers: await headers() })).status).toBe(404);
    const on = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', CONTROLLER_WEBHOOK_ENABLED: 'true', GITHUB_WEBHOOK_SECRET: SECRET });
    const response = await on.send(WEBHOOK_PATH, { method: 'POST', body, headers: await headers() });
    expect([202]).toContain(response.status);
    expect(['accepted', 'coalesced']).toContain(((await response.json()) as { outcome: string }).outcome);
  });
});

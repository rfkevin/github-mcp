/**
 * CC-7 L4b — route /salon : même preuve owner que /owner (Access JWT ou secret form).
 * Hors OAuth MCP. Porte SALON_ENABLED. Écriture auteur = « owner », hors quota agent.
 */
import { ownerChannelConfig, type OwnerChannelEnv } from '../owner/config';
import { defaultJwksResolver, verifyOwnerProof, type JwksResolver } from '../owner/proof';
import { listSalonMessages, postSalonMessage, SalonError, salonEnabled } from './salon';
import { SALON_PAGE_CSP, salonPage } from './page';

export const SALON_PATH = '/salon';

export interface SalonRouteEnv extends OwnerChannelEnv {
  COLLAB_DB?: D1Database;
  SALON_ENABLED?: string;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': SALON_PAGE_CSP,
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    },
  });
}

function denied(reason: string): Response {
  console.info(JSON.stringify({ service: 'salon-channel', action: 'access', outcome: 'denied', reason }));
  return new Response('Accès salon refusé.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

/** null = canal non configuré → 404 en aval. */
export async function handleSalonRequest(
  request: Request,
  env: SalonRouteEnv,
  origin: string,
  jwks: JwksResolver = defaultJwksResolver,
): Promise<Response | null> {
  const config = ownerChannelConfig(env);
  if (!config || !env.COLLAB_DB) return null;
  const db = env.COLLAB_DB;
  const enabled = salonEnabled(env);

  if (request.method === 'GET') {
    // Mode secret : la preuve est dans le formulaire POST ; GET affiche la page
    // (comme /owner login) sans exiger encore le secret, pour pouvoir saisir.
    if (config.mode === 'access') {
      const proof = await verifyOwnerProof(request, config, null, jwks);
      if (!proof) return denied('proof_invalid');
    }
    const messages = enabled ? await listSalonMessages(db, { limit: 50 }) : [];
    return html(salonPage({ messages, mode: config.mode, enabled }));
  }

  if (request.method !== 'POST') {
    return new Response('Méthode non autorisée.', {
      status: 405,
      headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' },
    });
  }
  if (request.headers.get('Origin') !== origin) return denied('origin_mismatch');
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return denied('form_invalid');
  }
  const field = (name: string): string => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const proof = await verifyOwnerProof(
    request,
    config,
    config.mode === 'secret' ? field('owner_secret') : null,
    jwks,
  );
  if (!proof) return denied('proof_invalid');

  const messages = enabled ? await listSalonMessages(db, { limit: 50 }) : [];
  if (!enabled) {
    return html(salonPage({
      messages, mode: config.mode, enabled,
      flash: { text: 'Salon éteint.', error: true },
    }), 403);
  }

  try {
    const level = field('level') as 'info' | 'decision' | 'blocking';
    await postSalonMessage(db, env, {
      authorPid: 'owner',
      level,
      body: field('body'),
      taskId: field('task') || undefined,
      incidentKey: field('incident_key') || undefined,
      newFact: field('new_fact') === '1',
      now: Math.floor(Date.now() / 1000),
      skipAgentQuota: true,
    });
    const after = await listSalonMessages(db, { limit: 50 });
    return html(salonPage({
      messages: after, mode: config.mode, enabled,
      flash: { text: 'Message publié.', error: false },
    }));
  } catch (error) {
    const text = error instanceof SalonError ? error.message : 'Publication impossible.';
    return html(salonPage({
      messages, mode: config.mode, enabled,
      flash: { text, error: true },
    }), 400);
  }
}

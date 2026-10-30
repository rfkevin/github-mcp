import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost, createRun, ToolRefused } from '../../../src/collab-store/agentrun';
import {
  assignResearch, createResearchTools, fetchOfficial, FETCH_TEXT_CHARS, htmlToText, officialUrl, researchCostCents,
  researchEnabled, researchPrompt, RESEARCH_SOURCES, OFFICIAL_HOSTS,
} from '../../../src/collab-store/agentrun/research';
import { listSalonMessages } from '../../../src/collab-store/salon';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { createOAuthFixture } from '../../oauth/helpers';

// CC-7 L11 — chercheurs en tournante : n'importe quel agent du canal API peut faire la veille des prix
// ou la recherche infrastructure (lecture web officielle, salon comme journal partagé, un message par passe).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const AT = 1_900_000_000; // 2030-03-17
let n = 0;

function page(body: string, init: { status?: number; type?: string; location?: string } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'text/html; charset=utf-8' });
  if (init.location) headers.set('location', init.location);
  return new Response(init.status && init.status >= 300 && init.status < 400 ? null : body, { status: init.status ?? 200, headers });
}

function scripted(responses: Response[]) {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const next = responses[seen.length - 1];
    if (!next) throw new Error('fetch_stub_exhausted');
    return next;
  }) as typeof fetch;
  return { seen, fetchImpl };
}

async function researchRun(participantId: string, subject: 'prix' | 'infra' = 'prix', taskKind = 'research') {
  await ensureSchema(db);
  const id = ++n;
  const runId = 'l11-run-' + id + '-' + Date.now().toString(36);
  const input = { runId, cycleId: 'l11-cycle-' + id, participantId, taskId: 'veille-' + subject + '-20300317', taskKind,
    prompt: 'passe', maxSteps: 10, maxTokens: 100_000, maxCostCents: 0, deadlineAt: AT + 3_600, now: AT };
  expect((await createRun(db, input)).created).toBe(true);
  return runId;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolRefused) return error.message;
    if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('CC-7 L11 — lecture web officielle', () => {
  it('hôtes officiels par égalité exacte, https seulement, sans identifiants ni port', () => {
    expect(officialUrl('https://ai.google.dev/gemini-api/docs/pricing#x')?.toString()).toBe('https://ai.google.dev/gemini-api/docs/pricing');
    expect(officialUrl('http://ai.google.dev/')).toBeNull();
    expect(officialUrl('https://ai.google.dev.evil.example/')).toBeNull();
    expect(officialUrl('https://evil.example/ai.google.dev')).toBeNull();
    // URL avec un nom d'utilisateur, construite à l'exécution : refusée comme toute URL à identifiants.
    const withUser = new URL('https://docs.x.ai/');
    withUser.username = 'u';
    expect(officialUrl(withUser.toString())).toBeNull();
    expect(officialUrl('https://docs.x.ai:8443/')).toBeNull();
    expect(officialUrl('https://' + 'a'.repeat(600))).toBeNull();
    expect(officialUrl(42)).toBeNull();
    // Chaque source de départ est elle-même officielle.
    for (const url of [...RESEARCH_SOURCES.prix, ...RESEARCH_SOURCES.infra]) expect(officialUrl(url)).not.toBeNull();
    expect(OFFICIAL_HOSTS).not.toContain('github.com');
  });

  it('HTML rendu en texte : titre, sans scripts, styles ni commentaires, entités décodées, cellules séparées', () => {
    const { title, text } = htmlToText('<html><head><title>Prix &amp; modèles</title><style>.a{}</style></head><body>'
      + '<script>alert(1)</script><!-- caché --><h1>Tarifs</h1><table><tr><td>Opus</td><td>$4 &lt; $5</td></tr></table>'
      + '<p>Contexte&nbsp;long&#8239;: &#x2014; ok</p></body></html>');
    expect(title).toBe('Prix & modèles');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('caché');
    expect(text).not.toContain('.a{}');
    expect(text).toContain('Tarifs');
    expect(text).toContain('Opus | $4 < $5 |');
    expect(text).toContain('—');
  });

  it('GET sans secret, redirection officielle suivie et revérifiée, redirection hors liste refusée, type non texte refusé', async () => {
    const ok = scripted([page('', { status: 301, location: '/developers/pricing' }), page('<title>xAI</title><p>grok-4.7 $2</p>')]);
    const result = await fetchOfficial(ok.fetchImpl, 'https://docs.x.ai/docs/models');
    expect(result).toMatchObject({ url: 'https://docs.x.ai/developers/pricing', status: 200, title: 'xAI', next_offset: null });
    expect(result.text).toContain('grok-4.7 $2');
    expect(ok.seen.map(s => s.init?.redirect)).toEqual(['manual', 'manual']);
    expect(ok.seen.every(s => !new Headers(s.init?.headers).has('authorization'))).toBe(true);

    const away = scripted([page('', { status: 302, location: 'https://evil.example/' })]);
    expect(await refusal(fetchOfficial(away.fetchImpl, 'https://docs.x.ai/'))).toBe('redirect_not_official');
    expect(await refusal(fetchOfficial(scripted([page('x', { type: 'image/png' })]).fetchImpl, 'https://docs.x.ai/'))).toBe('content_type_not_text');
    expect(await refusal(fetchOfficial(scripted([]).fetchImpl, 'https://evil.example/'))).toBe('url_not_official');
    const loop = scripted(Array.from({ length: 5 }, () => page('', { status: 301, location: '/again' })));
    expect(await refusal(fetchOfficial(loop.fetchImpl, 'https://docs.x.ai/'))).toBe('too_many_redirects');
  });

  it('texte découpé par fenêtres (offset, next_offset)', async () => {
    const long = 'x'.repeat(FETCH_TEXT_CHARS + 10);
    const first = await fetchOfficial(scripted([page(long, { type: 'text/plain' })]).fetchImpl, 'https://docs.z.ai/a');
    expect(first).toMatchObject({ offset: 0, total_chars: FETCH_TEXT_CHARS + 10, next_offset: FETCH_TEXT_CHARS });
    const second = await fetchOfficial(scripted([page(long, { type: 'text/plain' })]).fetchImpl, 'https://docs.z.ai/a', FETCH_TEXT_CHARS);
    expect(second.text).toHaveLength(10);
    expect(second.next_offset).toBeNull();
  });
});

describe('CC-7 L11 — outils de l’exécution research', () => {
  it('éteints par défaut ; allumés : kind research seulement ; publication absente si le salon est éteint', () => {
    const off = createReadToolHost({ db, repository: null, github: null });
    expect(off.spec('research', 'web_fetch_official')).toBeNull();
    const on = createReadToolHost({ db, repository: null, github: null, storeWrites: true, research: { salonEnabled: true } });
    expect(on.spec('research', 'web_fetch_official')).toEqual({ name: 'web_fetch_official', effect: 'read' });
    expect(on.spec('research', 'store_salon_read')).toEqual({ name: 'store_salon_read', effect: 'read' });
    expect(on.spec('research', 'store_salon_post')).toEqual({ name: 'store_salon_post', effect: 'write' });
    for (const kind of ['answer', 'review', 'test', 'implement', 'design']) {
      expect(on.spec(kind, 'web_fetch_official')).toBeNull();
      expect(on.spec(kind, 'store_salon_post')).toBeNull();
    }
    expect(on.schemas('research').map(s => s.name)).toEqual(expect.arrayContaining(['web_fetch_official', 'store_salon_read', 'store_salon_post']));
    const quiet = createReadToolHost({ db, repository: null, github: null, research: { salonEnabled: false } });
    expect(quiet.spec('research', 'store_salon_post')).toBeNull();
  });

  it('un seul message info par exécution, auteur = participant de l’exécution, réveil du coordinateur pour infra ; lookup', async () => {
    const runId = await researchRun('grok', 'infra');
    const tools = createResearchTools(db, { salonEnabled: true, now: () => AT });
    const posted = await tools.execute({ id: 'c1', name: 'store_salon_post', args: { body: 'Recherche infra 2030-03-17 (grok) : rien de majeur.' } },
      { run_id: runId, effect_key: runId + ':post' }) as { msg_id: string };
    const row = (await listSalonMessages(db, { sinceAt: AT - 1, limit: 100 })).find(m => m.msg_id === posted.msg_id)!;
    expect(row).toMatchObject({ author_pid: 'grok', level: 'info', task_id: 'veille-infra-20300317' });
    const wake = await db.prepare('SELECT participant_id FROM salon_wakes WHERE msg_id = ?1').bind(posted.msg_id).all<{ participant_id: string }>();
    expect(wake.results.map(w => w.participant_id)).toEqual(['claude']);
    expect(await tools.lookup({ id: 'c1', name: 'store_salon_post', args: {} }, { run_id: runId, effect_key: runId + ':post' }))
      .toEqual({ found: true, result: { msg_id: posted.msg_id, at: AT } });
    expect(await tools.lookup({ id: 'c1', name: 'store_salon_post', args: {} }, { run_id: runId, effect_key: 'other' })).toEqual({ found: false });
    expect(await refusal(tools.execute({ id: 'c1', name: 'store_salon_post', args: { body: 'encore' } }, { run_id: runId, effect_key: runId + ':post2' })))
      .toBe('one_post_per_run');
  });

  it('salon éteint : refus certain, réservation rendue ; exécution d’un autre type : refusée ; lecture du salon bornée', async () => {
    const runId = await researchRun('vibe');
    const off = createResearchTools(db, { salonEnabled: false, now: () => AT });
    expect(await refusal(off.execute({ id: 'c1', name: 'store_salon_post', args: { body: 'x' } }, { run_id: runId, effect_key: runId + ':p' }))).toBe('SALON_DISABLED');
    const on = createResearchTools(db, { salonEnabled: true, now: () => AT });
    await on.execute({ id: 'c1', name: 'store_salon_post', args: { body: 'Veille prix 2030-03-17 (vibe) : inchangé.' } }, { run_id: runId, effect_key: runId + ':p2' });
    const read = await on.execute({ id: 'c2', name: 'store_salon_read', args: {} }, { run_id: runId }) as { messages: Array<{ author: string; body: string }> };
    expect(read.messages.length).toBeLessThanOrEqual(60);
    expect(read.messages.some(m => m.author === 'vibe' && m.body.startsWith('Veille prix'))).toBe(true);
    const answer = await researchRun('vibe', 'prix', 'answer');
    expect(await refusal(on.execute({ id: 'c2', name: 'store_salon_read', args: {} }, { run_id: answer }))).toBe('unknown_run');
  });
});

describe('CC-7 L11 — passe confiée par le coordinateur', () => {
  const ENV = { AGENT_RUN_RESEARCH: 'true', AGENT_RUN_PARTICIPANTS: 'claude,grok,vibe' };

  async function seed(cycleId: string) {
    await ensureSchema(db);
    for (const pid of ['claude', 'grok', 'vibe']) {
      await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active')").bind(pid).run();
    }
    await db.prepare("INSERT OR IGNORE INTO coordinators (participant_id, status, event_seq, updated_at) VALUES ('claude', 'active', NULL, 1)").run();
    await db.prepare("INSERT OR IGNORE INTO cycles (cycle_id, status) VALUES (?1, 'open')").bind(cycleId).run();
  }

  it('porte, sujet, coordinateur, participant API et cycle ouvert exigés ; coût 0 par défaut', async () => {
    await seed('l11-assign-a');
    const base = { actor: 'claude', cycleId: 'l11-assign-a', participantId: 'grok', subject: 'prix', now: AT };
    expect(researchEnabled({})).toBe(false);
    expect(await refusal(assignResearch(db, {}, base))).toBe('RESEARCH_DISABLED');
    expect(await refusal(assignResearch(db, ENV, { ...base, subject: 'autre' }))).toBe('RESEARCH_SUBJECT_INVALID');
    expect(await refusal(assignResearch(db, ENV, { ...base, actor: 'vibe' }))).toBe('COORDINATOR_REQUIRED');
    expect(await refusal(assignResearch(db, ENV, { ...base, participantId: 'gemini' }))).toBe('RESEARCH_PARTICIPANT_NOT_API');
    expect(await refusal(assignResearch(db, ENV, { ...base, cycleId: 'l11-absent' }))).toBe('RESEARCH_CYCLE_NOT_OPEN');
    expect([researchCostCents({}), researchCostCents({ AGENT_RUN_COST_CENTS_RESEARCH: '25' }), researchCostCents({ AGENT_RUN_COST_CENTS_RESEARCH: '99999' }),
      researchCostCents({ AGENT_RUN_COST_CENTS_RESEARCH: '-1' })]).toEqual([0, 25, 0, 0]);
  });

  it('crée une exécution research avec la consigne serveur ; une seule par agent, sujet et jour', async () => {
    await seed('l11-assign-b');
    const input = { actor: 'claude', cycleId: 'l11-assign-b', participantId: 'vibe', subject: 'infra', now: AT };
    const first = await assignResearch(db, ENV, input);
    expect(first).toMatchObject({ created: true, task_id: 'veille-infra-20300317', participant: 'vibe', subject: 'infra', max_cost_cents: 0 });
    const run = await db.prepare('SELECT task_kind, participant_id, prompt, max_cost_cents, status FROM agent_runs WHERE run_id = ?1').bind(first.run_id)
      .first<{ task_kind: string; participant_id: string; prompt: string; max_cost_cents: number; status: string }>();
    expect(run).toMatchObject({ task_kind: 'research', participant_id: 'vibe', max_cost_cents: 0, status: 'running' });
    expect(run!.prompt).toContain('Recherche infra 2030-03-17 (vibe)');
    expect(run!.prompt).toContain('store_salon_read');
    const again = await assignResearch(db, ENV, { ...input, now: AT + 60 });
    expect(again).toMatchObject({ run_id: first.run_id, created: false });
    const otherSubject = await assignResearch(db, ENV, { ...input, subject: 'prix' });
    expect(otherSubject.run_id).not.toBe(first.run_id);
  });

  it('consigne prix : registre à la branche d’intégration, familles des agents, PR de faits laissée au coordinateur', () => {
    const prompt = researchPrompt('prix', 'grok', AT, 'mcp/105856986/cc3-integration');
    expect(prompt).toContain('Veille prix 2030-03-17 (grok)');
    expect(prompt).toContain('src/collab-store/executors/model-rates.ts');
    expect(prompt).toContain('ref mcp/105856986/cc3-integration');
    expect(prompt).toContain('PR de faits à faire');
    expect(prompt).toContain('https://platform.claude.com/docs/en/about-claude/pricing');
  });
});

describe('CC-7 L11 — catalogue MCP', () => {
  it('collab_research_assign présent seulement avec AGENT_RUNS_ENABLED et AGENT_RUN_RESEARCH', async () => {
    const list = async (vars: Record<string, string>) => {
      const fixture = createOAuthFixture({ COLLAB_DB: db, COLLAB_STORE_ENABLED: 'true', ...vars });
      const session = await fixture.mcpSession('mcp:read collab: offline_access', 'http://localhost:4321/callback', fixture.ORIGIN + '/collab/mcp');
      const response = await fixture.send('/collab/mcp', { method: 'POST', headers: session.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      return (fixture.rpcResult(await response.text()) as { tools: Array<{ name: string }> }).tools.map(t => t.name);
    };
    expect(await list({ AGENT_RUNS_ENABLED: 'true' })).not.toContain('collab_research_assign');
    expect(await list({ AGENT_RUNS_ENABLED: 'false', AGENT_RUN_RESEARCH: 'true' })).not.toContain('collab_research_assign');
    const on = await list({ AGENT_RUNS_ENABLED: 'true', AGENT_RUN_RESEARCH: 'true' });
    expect(on).toContain('collab_research_assign');
    // 20 = 18 outils du lot L11 + collab_memory_inventory + collab_memory_growth_simulate (M1b, toujours enregistrés).
    expect(on.length).toBe(20);
  });
});

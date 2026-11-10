import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost, createRun, ToolRefused } from '../../../src/collab-store/agentrun';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { listSalonMessages } from '../../../src/collab-store/salon';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const AT = 1_990_000_000;
let counter = 0;

async function seed(kind: 'implement' | 'review' | 'test' | 'answer', task = true) {
  await ensureSchema(db);
  const suffix = String(++counter) + '-' + Date.now().toString(36);
  const cycleId = 'cc8-salon-api-' + suffix;
  const taskId = task ? 'salon-task' : '';
  const runId = 'cc8-salon-run-' + suffix;
  await db.prepare("INSERT INTO cycles (cycle_id, phase, status, revision) VALUES (?1, 'P6', 'open', 1)")
    .bind(cycleId).run();
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('vibe','Vibe','active')").run();
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('gpt6','GPT-6','active')").run();
  await db.prepare("INSERT OR IGNORE INTO participants (participant_id, display_label, status) VALUES ('claude','Claude','active')").run();
  await db.prepare("INSERT OR REPLACE INTO coordinators (participant_id, status, event_seq, updated_at) VALUES ('gpt6','active',NULL,1)").run();
  if (taskId) await db.prepare(
    "INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)"
      + " VALUES (?1, ?2, 'vibe', 'gpt6', 'gpt6', 'in_progress', '[]', '', '', 1)"
  ).bind(taskId, cycleId).run();
  const created = await createRun(db, {
    runId, cycleId, participantId: 'vibe', taskId, taskKind: kind, prompt: 'Recherche un blocage',
    maxSteps: 8, maxTokens: 100_000, maxCostCents: 0, deadlineAt: AT + 3600, now: AT,
  });
  expect(created.created).toBe(true);
  return { runId, cycleId, taskId };
}

function host(salonEnabled = true) {
  return createReadToolHost({ db, repository: null, github: null, storeWrites: true,
    research: { salonEnabled, researchEnabled: false, now: () => AT } });
}

describe('CC8 — agents API dans le même salon que les chats', () => {
  it('expose le salon et les clarifications sur les tâches API, jamais la veille web désactivée', () => {
    const tools = host();
    for (const kind of ['implement', 'review', 'test', 'answer', 'planning', 'status', 'design']) {
      expect(tools.spec(kind, 'store_salon_read')).toEqual({ name: 'store_salon_read', effect: 'read' });
      expect(tools.spec(kind, 'store_salon_post')).toEqual({ name: 'store_salon_post', effect: 'write' });
      expect(tools.spec(kind, 'store_ask')).toEqual({ name: 'store_ask', effect: 'write' });
      expect(tools.spec(kind, 'store_answer')).toEqual({ name: 'store_answer', effect: 'write' });
      expect(tools.spec(kind, 'web_fetch_official')).toBeNull();
    }
    expect(tools.spec('unknown', 'store_salon_post')).toBeNull();
    expect(host(false).spec('implement', 'store_salon_post')).toBeNull();
  });

  it('publie blocking sous identité vérifiée et tâche D1, réveille le coordinateur, sans doublon', async () => {
    const run = await seed('implement');
    const tools = host();
    const key = 'b'.repeat(64);
    const result = await tools.execute({ id: 'p1', name: 'store_salon_post', args: {
      level: 'blocking', body: 'API Vibe: outil indisponible; aide du coordinateur requise',
      incident_key: 'cc8:incident:tool-unavailable',
    } }, { run_id: run.runId, effect_key: key }) as { msg_id: string };
    const msg = (await listSalonMessages(db, { sinceAt: AT - 1, limit: 100 })).find(m => m.msg_id === result.msg_id)!;
    expect(msg).toMatchObject({ author_pid: 'vibe', task_id: 'salon-task',
      level: 'blocking', incident_key: 'cc8:incident:tool-unavailable' });
    const wakes = await db.prepare('SELECT participant_id FROM salon_wakes WHERE msg_id=?1')
      .bind(result.msg_id).all<{ participant_id: string }>();
    expect(wakes.results.some(x => x.participant_id === 'gpt6')).toBe(true);
    expect(await tools.lookup!({ id: 'p1', name: 'store_salon_post', args: {} }, { run_id: run.runId, effect_key: key }))
      .toMatchObject({ found: true, result: { msg_id: result.msg_id } });
    await expect(tools.execute({ id: 'p2', name: 'store_salon_post', args: { level: 'blocking', body: 'encore' } },
      { run_id: run.runId, effect_key: 'c'.repeat(64) })).rejects.toThrow('one_post_per_run');
  });

  it('une API en review peut poser une clarification durable via store_ask', async () => {
    const run = await seed('review');
    const tools = host();
    const result = await tools.execute({ id: 'ask', name: 'store_ask', args: {
      question: 'Quel commit doit être testé ?', task: run.taskId, to: 'gpt6',
    } }, { run_id: run.runId, effect_key: 'd'.repeat(64) }) as { type: string; status: string };
    expect(result).toMatchObject({ type: 'clarify.ask', status: 'applied' });
    const row = await db.prepare(
      "SELECT participant_id, payload_json FROM events WHERE cycle_id=?1 AND type='clarify.ask' ORDER BY seq DESC LIMIT 1"
    ).bind(run.cycleId).first<{ participant_id: string; payload_json: string }>();
    expect(row?.participant_id).toBe('vibe');
    expect(JSON.parse(row!.payload_json)).toMatchObject({ question: 'Quel commit doit être testé ?', to: 'gpt6' });
  });

  it('blocking sans tâche refusé, et interrupteur salon désactivé ne donne aucun droit de publication', async () => {
    const run = await seed('answer', false);
    const tools = host();
    await expect(tools.execute({ id: 'no-task', name: 'store_salon_post', args: {
      level: 'blocking', body: 'Impossible de finir',
    } }, { run_id: run.runId, effect_key: 'e'.repeat(64) })).rejects.toThrow('blocking_task_required');
    expect(host(false).spec('answer', 'store_salon_post')).toBeNull();
    expect(ToolRefused).toBeDefined();
  });
  it('info puis blocking dans la même exécution, un de chaque, sans deuxième blocking', async () => {
    const run = await seed('implement');
    const tools = host();
    const infoKey = '1'.repeat(64);
    const blockerKey = '2'.repeat(64);
    const first = await tools.execute({ id: 'info', name: 'store_salon_post', args: {
      level: 'info', body: 'Avancement ordinaire',
    } }, { run_id: run.runId, effect_key: infoKey }) as { msg_id: string };
    const blocker = await tools.execute({ id: 'blocking', name: 'store_salon_post', args: {
      level: 'blocking', body: 'Bloqué : aide nécessaire', incident_key: run.runId,
    } }, { run_id: run.runId, effect_key: blockerKey }) as { msg_id: string };
    expect(first.msg_id).not.toBe(blocker.msg_id);
    const messages = await listSalonMessages(db, { sinceAt: AT - 1, limit: 100 });
    expect(messages.find(m => m.msg_id === first.msg_id)?.level).toBe('info');
    expect(messages.find(m => m.msg_id === blocker.msg_id)?.level).toBe('blocking');
    expect(await tools.lookup!({ id: 'blocking', name: 'store_salon_post', args: {} },
      { run_id: run.runId, effect_key: blockerKey })).toMatchObject({ found: true, result: { msg_id: blocker.msg_id } });
    await expect(tools.execute({ id: 'second-block', name: 'store_salon_post', args: {
      level: 'blocking', body: 'Second blocage',
    } }, { run_id: run.runId, effect_key: '3'.repeat(64) })).rejects.toThrow('one_post_per_run');
    await expect(tools.execute({ id: 'second-info', name: 'store_salon_post', args: {
      level: 'info', body: 'Second message ordinaire',
    } }, { run_id: run.runId, effect_key: '4'.repeat(64) })).rejects.toThrow('one_post_per_run');
  });

  it('HALT propriétaire refuse salon, question et réponse API sans créer de trace', async () => {
    const run = await seed('review');
    const tools = host();
    await db.prepare("INSERT INTO owner_flags (name, value, event_seq, updated_at) VALUES ('halt','1',NULL,?1) ON CONFLICT(name) DO UPDATE SET value='1', updated_at=?1")
      .bind(AT).run();
    try {
      await expect(tools.execute({ id: 'halt-salon', name: 'store_salon_post', args: {
        level: 'blocking', body: 'Blocage pendant HALT',
      } }, { run_id: run.runId, effect_key: '5'.repeat(64) })).rejects.toThrow('SALON_HALT');
      await expect(tools.execute({ id: 'halt-ask', name: 'store_ask', args: {
        question: 'Question pendant HALT ?',
      } }, { run_id: run.runId, effect_key: '6'.repeat(64) })).rejects.toThrow('HALT');
      await expect(tools.execute({ id: 'halt-answer', name: 'store_answer', args: {
        ask_seq: 1, answer: 'Réponse interdite pendant HALT',
      } }, { run_id: run.runId, effect_key: '7'.repeat(64) })).rejects.toThrow('HALT');
      const count = await db.prepare("SELECT COUNT(*) AS n FROM salon_messages WHERE body = 'Blocage pendant HALT'")
        .first<{ n: number }>();
      expect(count?.n).toBe(0);
      const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type IN ('clarify.ask','clarify.answer')")
        .bind(run.cycleId).first<{ n: number }>();
      expect(events?.n).toBe(0);
    } finally {
      await db.prepare("UPDATE owner_flags SET value='0' WHERE name='halt'").run();
    }
  });

  it.each(['review', 'test', 'design'] as const)(
    'refuse store_answer par un non-destinataire en %s', async kind => {
      const run = await seed('review');
      // Changer uniquement le kind du run ciblé, sans modifier l'identité.
      await db.prepare('UPDATE agent_runs SET task_kind = ?2 WHERE run_id = ?1').bind(run.runId, kind).run();
      const authorRun = 'cc8-salon-author-' + run.cycleId;
      const made = await createRun(db, { runId: authorRun, cycleId: run.cycleId,
        participantId: 'gpt6', taskId: run.taskId, taskKind: 'planning',
        prompt: 'Clarification adressée', maxSteps: 8, maxTokens: 100_000,
        maxCostCents: 0, deadlineAt: AT + 3600, now: AT });
      expect(made.created).toBe(true);
      const tools = host();
      const asked = await tools.execute({ id: 'author-ask', name: 'store_ask', args: {
        question: 'Question exclusivement pour Claude ?', task: run.taskId, to: 'claude',
      } }, { run_id: authorRun, effect_key: '8'.repeat(64) }) as { seq: number };
      expect(tools.spec(kind, 'store_answer')).toEqual({ name: 'store_answer', effect: 'write' });
      await expect(tools.execute({ id: 'outsider-answer', name: 'store_answer', args: {
        ask_seq: asked.seq, answer: 'Réponse non autorisée par Vibe',
      } }, { run_id: run.runId, effect_key: '9'.repeat(64) })).rejects.toThrow('CLARIFY_ANSWER_FORBIDDEN');
      const answer = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1 AND type = 'clarify.answer'")
        .bind(run.cycleId).first<{ n: number }>();
      expect(answer?.n).toBe(0);
    });

  it('reprise après coupure : réservation PENDING ne republie jamais un message', async () => {
    const run = await seed('implement');
    const tools = host();
    const effectKey = 'a'.repeat(64);
    const first = await tools.execute({ id: 'post', name: 'store_salon_post', args: {
      level: 'blocking', body: 'Blocage persistant à signaler', incident_key: run.runId,
    } }, { run_id: run.runId, effect_key: effectKey }) as { msg_id: string };
    // Simuler une coupure après postSalonMessage, mais avant écriture du reçu msg_id.
    await db.prepare('UPDATE agent_research_posts SET msg_id = ?2 WHERE effect_key = ?1')
      .bind(effectKey, 'pending').run();
    const before = await db.prepare('SELECT COUNT(*) AS n FROM salon_messages WHERE msg_id = ?1')
      .bind(first.msg_id).first<{ n: number }>();
    expect(before?.n).toBe(1);
    expect(await tools.lookup!({ id: 'post', name: 'store_salon_post', args: {} },
      { run_id: run.runId, effect_key: effectKey })).toBeNull();
    await expect(tools.execute({ id: 'retry', name: 'store_salon_post', args: {
      level: 'blocking', body: 'Blocage persistant à signaler', incident_key: run.runId,
    } }, { run_id: run.runId, effect_key: effectKey })).rejects.toThrow('one_post_per_run');
    const after = await db.prepare('SELECT COUNT(*) AS n FROM salon_messages WHERE msg_id = ?1')
      .bind(first.msg_id).first<{ n: number }>();
    expect(after?.n).toBe(1);
  });

});

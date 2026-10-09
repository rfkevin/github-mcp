import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { e2eScenario, toolCode as code } from './e2e-harness';

// CC-3 CR-A (contre-revue Codex github-mcp#79, CR-01 + CR-03), par le vrai chemin HTTP :
// OAuth + /collab/mcp pour les agents, /owner (secret) pour Kevin, D1 local partant d'une base
// vide pour ce cycle. Aucune ligne de phase_definitions, de tâche ou de cycle n'est écrite en SQL
// par le test : il ne fait que lire l'état pour vérifier qu'une mutation refusée ne change rien.
// Harnais HTTP partagé avec les autres specs E2E : e2e-harness.ts (même dossier).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;

async function state(cycle: string) {
  await ensureSchema(db);
  const row = await db.prepare('SELECT phase, revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ phase: string; revision: number }>();
  const events = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  const sealed = await db.prepare('SELECT COUNT(*) AS n FROM sealed_items WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>();
  return { phase: row?.phase, revision: row?.revision, events: events?.n, sealed: sealed?.n };
}

describe('CC-3 CR-A — amorçage owner des phases et garde d’identité de collab_phase_advance (HTTP)', () => {
  it('cycle neuf via MCP → phases installées sur /owner → seuls les participants du cycle avancent', async () => {
    const { owner, client, agent, uniq } = e2eScenario(db, 'cra', 'owner-secret-CRA-0123456789abcdefghijklmn');
    const [alpha, beta, gamma, delta] = [await agent('alpha'), await agent('beta'), await agent('gamma'), await agent('delta')];
    const stranger = await client();
    const cycle = uniq('cycle');

    // 1. Création du cycle et d'une tâche par les agents eux-mêmes (MCP).
    expect((await alpha.call('collab_append_event', { cycle, expected_rev: 0, op_id: `alpha:${cycle}:open:1`,
      type: 'checkpoint', participant_id: alpha.pid, payload_json: '{"note":"ouverture"}' })).structuredContent.status).toBe('applied');
    expect((await alpha.call('collab_append_event', { cycle, expected_rev: 1, op_id: `alpha:${cycle}:claim:1`,
      type: 'task.claim', participant_id: alpha.pid, payload_json: JSON.stringify({ task: { task_id: 'T1', owner_pid: alpha.pid,
        reviewer_pid: beta.pid, tester_pid: gamma.pid, status: 'in_progress', owned_paths: ['docs/'], next_action: 'P1' } }) }))
      .structuredContent.status).toBe('applied');

    // 2. CR-03 : sans définition, aucune avance (constat Codex).
    const missing = await alpha.call('collab_phase_advance', { cycle, expected_rev: 2, next_phase: 'P2' });
    expect(code(missing)).toBe('PHASE_DEFINITION_MISSING');

    // 3. Amorçage owner par défaut : P1–P6, auto_advance none → l'avance reste refusée.
    const defaults = await owner({ action: 'install_phases', cycle_id: cycle, phases: '' });
    expect(defaults.status).toBe(200);
    expect(await defaults.text()).toContain('Phases installées');
    const none = await alpha.call('collab_phase_advance', { cycle, expected_rev: 3, next_phase: 'P2' });
    expect(code(none)).toBe('POLICY_NOT_AUTHORIZED');

    // 4. Kevin nomme une policy pour P1 ; réinstaller le même ensemble est un doublon (idempotent).
    const phases = JSON.stringify([{ phase: 'P1', auto_advance: 'cc3-p1-open' }, { phase: 'P2' }]);
    expect(await (await owner({ action: 'install_phases', cycle_id: cycle, phases })).text()).toContain('Phases installées');
    expect(await (await owner({ action: 'install_phases', cycle_id: cycle, phases })).text()).toContain('Déjà installées');
    const invalid = await owner({ action: 'install_phases', cycle_id: cycle, phases: '[{"phase":"P1"},{"phase":"P1"}]' });
    expect(invalid.status).toBe(409);
    expect(await invalid.text()).toContain('INVALID_PHASE_DEFINITIONS');
    const before = await state(cycle);
    expect(before).toMatchObject({ phase: 'P1', revision: 4 });

    // 5. CR-01 : client non enregistré et participant sans rôle → refus, état inchangé.
    const strangerTry = await stranger.call('collab_phase_advance', { cycle, expected_rev: 4, next_phase: 'P2' });
    expect(code(strangerTry)).toBe('UNREGISTERED_CLIENT');
    const outsider = await delta.call('collab_phase_advance', { cycle, expected_rev: 4, next_phase: 'P2' });
    expect(code(outsider)).toBe('PHASE_ADVANCE_FORBIDDEN');
    expect(await state(cycle)).toEqual(before);

    // 6. Un participant du cycle déclenche la policy ; un autre rôle rejoue la même intention.
    const advanced = await alpha.call('collab_phase_advance', { cycle, expected_rev: 4, next_phase: 'P2' });
    expect(advanced.structuredContent).toMatchObject({ status: 'applied', revision: 5 });
    const replay = await gamma.call('collab_phase_advance', { cycle, expected_rev: 4, next_phase: 'P2' });
    expect(replay.structuredContent).toMatchObject({ status: 'duplicate', event_seq: advanced.structuredContent.event_seq });
    // Le rejeu ne contourne pas la garde : un client non enregistré reste refusé.
    expect(code(await stranger.call('collab_phase_advance', { cycle, expected_rev: 4, next_phase: 'P2' }))).toBe('UNREGISTERED_CLIENT');
    expect(await state(cycle)).toMatchObject({ phase: 'P2', revision: 5 });

    // 7. P2 n'a pas de policy (défaut none) : l'avance suivante attend une nouvelle décision owner.
    expect(code(await beta.call('collab_phase_advance', { cycle, expected_rev: 5, next_phase: 'P3' }))).toBe('POLICY_NOT_AUTHORIZED');
  });
});

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { installPhaseDefinitions, normalizePhaseDefinitions } from '../../../src/collab-store/owner/phase-install';
import { inspectPhase } from '../../../src/collab-store/phases';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-3 CR-A / CR-03 — installation owner des définitions de phase : validée, idempotente, sûre par défaut.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const proof = { kind: 'secret' as const, subject: 'owner-secret' };
let n = 0;
const uniq = (label: string) => `crp-${label}-${Date.now().toString(36)}-${++n}`;

async function rows(cycle: string) {
  await ensureSchema(db);
  return (await db.prepare('SELECT phase, auto_advance, entry_conditions FROM phase_definitions WHERE cycle_id = ?1 ORDER BY phase')
    .bind(cycle).all<{ phase: string; auto_advance: string; entry_conditions: string }>()).results;
}

describe('CC-3 CR-03 — définitions de phase installées par le propriétaire', () => {
  it('vide → P1–P6 sans condition, auto_advance none ; le cycle est créé et lisible par le moteur', async () => {
    const cycle = uniq('defaults');
    const result = await installPhaseDefinitions(db, { cycle_id: cycle, definitions: '  ', proof });
    expect(result.status).toBe('applied');
    expect(result.phases).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(phase => ({ phase, auto_advance: 'none' })));
    expect((await rows(cycle)).map(row => [row.phase, row.auto_advance, row.entry_conditions]))
      .toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map(phase => [phase, 'none', '[]']));
    const facts = await inspectPhase(db, cycle);
    expect(facts).toMatchObject({ phase: 'P1', definition: { auto_advance: 'none' } });
    const event = JSON.parse(result.event.payload_json) as Record<string, unknown>;
    expect(event).toMatchObject({ action: 'install_phases', cycle_id: cycle, definitions_sha256: result.definitions_sha256 });
    expect(result.event).toMatchObject({ type: 'owner.decision', participant_id: 'owner' });
  });

  it('idempotent pour le même ensemble (ordre indifférent), remplace l’ensemble quand il change', async () => {
    const cycle = uniq('replace');
    const first = await installPhaseDefinitions(db, { cycle_id: cycle, proof,
      definitions: JSON.stringify([{ phase: 'P2' }, { phase: 'P1', auto_advance: 'cc3-p1', entry_conditions: [] }]) });
    const again = await installPhaseDefinitions(db, { cycle_id: cycle, proof,
      definitions: JSON.stringify([{ phase: 'P1', auto_advance: 'cc3-p1' }, { phase: 'P2', auto_advance: 'none' }]) });
    expect(again).toMatchObject({ status: 'duplicate', event: { seq: first.event.seq } });
    const changed = await installPhaseDefinitions(db, { cycle_id: cycle, proof,
      definitions: JSON.stringify([{ phase: 'P1', auto_advance: 'none', exit_conditions: ['revue'] }]) });
    expect(changed.status).toBe('applied');
    expect(await rows(cycle)).toEqual([{ phase: 'P1', auto_advance: 'none', entry_conditions: '[]' }]);
    // Revenir à l'ensemble initial après un changement est un nouvel acte owner, pas un doublon.
    const back = await installPhaseDefinitions(db, { cycle_id: cycle, proof,
      definitions: JSON.stringify([{ phase: 'P1', auto_advance: 'cc3-p1' }, { phase: 'P2' }]) });
    expect(back.status).toBe('applied');
    expect(back.event.seq).toBeGreaterThan(changed.event.seq);
  });

  it('refuse les définitions invalides sans rien écrire', () => {
    const cases: Array<[string, string]> = [
      ['{', 'INVALID_PHASE_DEFINITIONS'],
      ['[]', 'INVALID_PHASE_DEFINITIONS'],
      ['{"phase":"P1"}', 'INVALID_PHASE_DEFINITIONS'],
      ['[{"phase":"P1"},{"phase":"P1"}]', 'INVALID_PHASE_DEFINITIONS'],
      ['[{"phase":"P7"}]', 'INVALID_PHASE'],
      ['[{"phase":"P1","auto_advance":"policy avec espace"}]', 'INVALID_PHASE_DEFINITIONS'],
      ['[{"phase":"P1","auto_advance":""}]', 'INVALID_PHASE_DEFINITIONS'],
      ['[{"phase":"P1","entry_conditions":"x"}]', 'INVALID_PHASE_DEFINITIONS'],
      ['[{"phase":"P1","expected_outputs":[{"role":"author","kind":"proposal.submit","count":0}]}]', 'INVALID_PHASE_OUTPUT'],
      [JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ phase: 'P' + ((i % 6) + 1) }))), 'INVALID_PHASE_DEFINITIONS'],
    ];
    for (const [source, expected] of cases) {
      expect(() => normalizePhaseDefinitions('crp-invalid', source), source).toThrow(expect.objectContaining({ code: expected }));
    }
    expect(() => normalizePhaseDefinitions('Cycle Invalide', '')).toThrow(expect.objectContaining({ code: 'INVALID_CYCLE_ID' }));
  });

  it('une installation refusée ne crée ni cycle ni définition', async () => {
    const cycle = uniq('refused');
    await expect(installPhaseDefinitions(db, { cycle_id: cycle, definitions: '[{"phase":"P1"},{"phase":"P1"}]', proof }))
      .rejects.toMatchObject({ code: 'INVALID_PHASE_DEFINITIONS' });
    expect(await rows(cycle)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ n: number }>()).toEqual({ n: 0 });
  });
});

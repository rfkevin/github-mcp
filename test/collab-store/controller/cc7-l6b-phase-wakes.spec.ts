import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createProduct, proposalTaskId } from '../../../src/collab-store/owner/product';
import { normalizePhaseDefinitions } from '../../../src/collab-store/owner/phase-install';
import { registerParticipant } from '../../../src/collab-store/owner/decisions';
import { nextActors, readControllerSnapshot } from '../../../src/collab-store/controller';
import { advanceGuarded, inspectPhase } from '../../../src/collab-store/phases';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import type { StoreEventType } from '../../../src/collab-store/contracts/events';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { ciGreen, parseRequiredChecks, taskKindCostCents, RUN_COST_CENTS_CEILING, VERDICT_REQUIRED_CHECKS } from '../../../src/collab-store/agentrun';
import { OWNER_PROOF, uniqueIds } from '../coordinator-helpers';

// CC-7 L6b — un produit avance seul de P1 à P5 : réveils des sorties attendues, vote P4 sans OBJECTION, P5 au choix de Kevin.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('l6b');

async function product(autoP5: boolean) {
  await ensureSchema(db);
  const pids = [uid('a'), uid('b'), uid('c')];
  for (const pid of pids) {
    await registerParticipant(db, { participant_id: pid, display_label: 'L ' + pid, proof: OWNER_PROOF, op: 'reg-' + pid });
  }
  const cycle = uid('c');
  await createProduct(db, { enabled: true, cycle_id: cycle, goal: 'Outil de notes', participants: pids, auto_p5: autoP5, proof: OWNER_PROOF });
  const store = new CollabStore(db, { dailyWriteLimit: 100_000 });
  let op = 0;
  const revision = async () => (await db.prepare('SELECT revision FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ revision: number }>())!.revision;
  const phase = async () => (await db.prepare('SELECT phase FROM cycles WHERE cycle_id = ?1').bind(cycle).first<{ phase: string }>())!.phase;
  const append = async (pid: string, type: StoreEventType, role: string, payload: unknown) => {
    const result = await store.appendEvent({ cycle_id: cycle, type, participant_id: pid, role, expected_rev: await revision(),
      op_id: pid.replace(/:/g, '.') + ':' + cycle + ':l6b:' + (++op), payload_json: JSON.stringify(payload) });
    expect(result.status).toBe('applied');
  };
  const wakes = async () => {
    const snapshot = await readControllerSnapshot(db, cycle, async id => {
      const facts = await inspectPhase(db, id);
      return { satisfied: facts.outputsSatisfied, outputs: facts.outputs };
    });
    return nextActors(snapshot).decisions;
  };
  const contribute = async () => (await wakes()).filter(d => d.action === 'contribute').map(d => [d.actor, d.task_id, d.subject]);
  const advance = (to: 'P2' | 'P3' | 'P4' | 'P5' | 'P6') => revision().then(rev => advanceGuarded(db, { cycle_id: cycle, expected_revision: rev, next_phase: to }));
  return { cycle, pids, append, wakes, contribute, advance, phase };
}

describe('CC-7 L6b — sorties attendues avec états (contrat)', () => {
  it('states conservé à l’installation ; jetons invalides refusés (INVALID_PHASE_OUTPUT_STATES)', () => {
    const [def] = normalizePhaseDefinitions('c-x', JSON.stringify([{ phase: 'P4', auto_advance: 'p',
      expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, task_id: 'synthesis', states: ['AGREE', 'AMEND'] }] }]));
    expect(def.expected_outputs[0].states).toEqual(['AGREE', 'AMEND']);
    for (const states of [[], ['agree'], ['A'.repeat(40)], Array(9).fill('X'), 'AGREE']) {
      expect(() => normalizePhaseDefinitions('c-x', JSON.stringify([{ phase: 'P4',
        expected_outputs: [{ role: 'reviewer', kind: 'evidence.add', count: 1, states }] }])))
        .toThrow(expect.objectContaining({ code: 'INVALID_PHASE_OUTPUT_STATES' }));
    }
  });
});

describe('CC-7 L6b — un produit avance seul de P1 à P5', () => {
  it('chaque phase réveille exactement les titulaires manquants, sans doublon avec les réveils de tâche', async () => {
    const q = await product(false);
    const [a, b, c] = q.pids;
    // P1 : chaque auteur est réveillé pour PROPOSER (contribute) ; L6b-2 : le réveil « no-submission »
    // (implémenter) de la même tâche est remplacé, jamais doublé.
    expect((await q.wakes()).filter(d => d.rule === 'no-submission')).toEqual([]);
    expect((await q.contribute()).sort()).toEqual([a, b, c].map(pid => [pid, proposalTaskId(pid), 'P1:proposal.submit:author']).sort());
    for (const pid of q.pids) await q.append(pid, 'proposal.submit', 'author', { task: proposalTaskId(pid), content: 'idée ' + pid });
    await q.advance('P2');

    // P2 : chaque relecteur est réveillé sur la proposition qu'il critique (rotation : a relit b, b relit c, c relit a).
    expect((await q.contribute()).sort()).toEqual([
      [a, proposalTaskId(c), 'P2:evidence.add:reviewer'], [b, proposalTaskId(a), 'P2:evidence.add:reviewer'],
      [c, proposalTaskId(b), 'P2:evidence.add:reviewer']].sort());
    await q.append(a, 'evidence.add', 'reviewer', { task: proposalTaskId(c), source: 'critique', state: 'AMEND', review: 'x' });
    expect((await q.contribute()).map(w => w[0]).sort()).toEqual([b, c].sort());
    await q.append(b, 'evidence.add', 'reviewer', { task: proposalTaskId(a), source: 'critique', state: 'AGREE', review: 'x' });
    await q.append(c, 'evidence.add', 'reviewer', { task: proposalTaskId(b), source: 'critique', state: 'AGREE', review: 'x' });
    await q.advance('P3');

    // P3 : seul le coordinateur est réveillé, sur la synthèse (tâche bloquée, nommée par le gabarit).
    expect(await q.contribute()).toEqual([[a, 'synthesis', 'P3:proposal.submit:author:synthesis']]);
    await q.append(a, 'proposal.submit', 'author', { task: 'synthesis', content: 'plan' });
    await q.advance('P4');

    // P4 : relecteur (b) et testeur (c) de la synthèse votent ; une OBJECTION bloque, son retrait débloque.
    expect((await q.contribute()).sort()).toEqual([
      [b, 'synthesis', 'P4:evidence.add:reviewer:synthesis'], [c, 'synthesis', 'P4:evidence.add:tester:synthesis']].sort());
    await q.append(b, 'evidence.add', 'reviewer', { task: 'synthesis', source: 'vote', state: 'AGREE', review: 'ok' });
    await q.append(c, 'evidence.add', 'tester', { task: 'synthesis', source: 'vote', state: 'OBJECTION', review: 'non' });
    expect(await q.contribute()).toEqual([[c, 'synthesis', 'P4:evidence.add:tester:synthesis']]);
    await expect(q.advance('P5')).rejects.toBeTruthy();
    expect((await q.wakes()).some(d => d.kind === 'advance_phase')).toBe(false);
    await q.append(c, 'evidence.add', 'tester', { task: 'synthesis', source: 'vote', state: 'AMEND', review: 'avec S7 amendé' });
    expect((await q.wakes()).filter(d => d.kind === 'advance_phase').map(d => d.subject)).toEqual(['P4->P5']);
    await q.advance('P5');
    expect(await q.phase()).toBe('P5');

    // P5 sans le choix de Kevin : aucune policy, la validation reste la sienne.
    await expect(q.advance('P6')).rejects.toMatchObject({ code: 'POLICY_NOT_AUTHORIZED' });
  });

  it('auto_p5 choisi par Kevin à la création : P5 → P6 sans lui', async () => {
    const q = await product(true);
    const [a, b, c] = q.pids;
    for (const pid of q.pids) await q.append(pid, 'proposal.submit', 'author', { task: proposalTaskId(pid), content: 'i' });
    await q.advance('P2');
    for (const [who, task] of [[a, c], [b, a], [c, b]]) {
      await q.append(who, 'evidence.add', 'reviewer', { task: proposalTaskId(task), source: 'critique', state: 'AGREE', review: 'x' });
    }
    await q.advance('P3');
    await q.append(a, 'proposal.submit', 'author', { task: 'synthesis', content: 'plan' });
    await q.advance('P4');
    await q.append(b, 'evidence.add', 'reviewer', { task: 'synthesis', source: 'vote', state: 'AGREE', review: 'ok' });
    await q.append(c, 'evidence.add', 'tester', { task: 'synthesis', source: 'vote', state: 'AGREE', review: 'ok' });
    await q.advance('P5');
    expect((await q.wakes()).filter(d => d.kind === 'advance_phase').map(d => d.subject)).toEqual(['P5->P6']);
    await q.advance('P6');
    expect(await q.phase()).toBe('P6');
  });
});

describe('CC-7 L6b — plafonds de coût owner et CI nommée', () => {
  it('AGENT_RUN_COST_CENTS_<KIND> : entier 0 à 1 000 posé par Kevin, sinon 0', () => {
    expect(taskKindCostCents({}, 'review')).toBe(0);
    expect(taskKindCostCents({ AGENT_RUN_COST_CENTS_REVIEW: '150' }, 'review')).toBe(150);
    expect(taskKindCostCents({ AGENT_RUN_COST_CENTS_REVIEW: '150' }, 'test')).toBe(0);
    expect(taskKindCostCents({ AGENT_RUN_COST_CENTS_IMPLEMENT: String(RUN_COST_CENTS_CEILING) }, 'implement')).toBe(RUN_COST_CENTS_CEILING);
    for (const raw of [String(RUN_COST_CENTS_CEILING + 1), '-1', '1.5', '012', 'abc', '']) {
      expect(taskKindCostCents({ AGENT_RUN_COST_CENTS_ANSWER: raw }, 'answer'), raw).toBe(0);
    }
  });

  it('store_verdict : les 4 contrôles nommés doivent avoir réussi et aucun n’être en cours', () => {
    const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
    const four = VERDICT_REQUIRED_CHECKS.map(ok);
    expect(ciGreen(four, VERDICT_REQUIRED_CHECKS)).toBe(true);
    expect(ciGreen([...four, { name: 'deploy', status: 'in_progress', conclusion: null }], VERDICT_REQUIRED_CHECKS)).toBe(true);
    expect(ciGreen(four.slice(1), VERDICT_REQUIRED_CHECKS)).toBe(false);
    expect(ciGreen([...four.slice(1), { name: 'ci', status: 'completed', conclusion: 'failure' }], VERDICT_REQUIRED_CHECKS)).toBe(false);
    expect(ciGreen([...four, { name: 'ci', status: 'in_progress', conclusion: null }], VERDICT_REQUIRED_CHECKS)).toBe(false);
    expect(ciGreen([ok('autre')], [])).toBe(true);
    expect(ciGreen([], [])).toBe(false);
    expect(parseRequiredChecks(undefined)).toEqual(VERDICT_REQUIRED_CHECKS);
    expect(parseRequiredChecks(' ci , build ,ci')).toEqual(['ci', 'build']);
    expect(parseRequiredChecks(' , ')).toEqual(VERDICT_REQUIRED_CHECKS);
  });
});

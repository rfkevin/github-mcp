import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CollabStore } from '../../../src/collab-store/store/collab-store';
import { citesPullRequest, isPrVerdict, isVerdictEvidence, verdictClaimOf } from '../../../src/collab-store/store/verdict-guard';
import { previewNextActions } from '../../../src/collab-store/controller';
import { ensureSchema } from '../../../src/collab-store/store/schema';

// CC-7 L14 (décision de Kevin du 2026-10-30 : « ça doit être obligatoire pour éviter les confusions ») —
// un verdict D12 déposé par evidence.add n'est accepté que rattaché à une tâche du store, par son relecteur
// ou son testeur, avec un couple head/base structuré. Avant : ignoré en silence par le contrôleur.
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
let n = 0;
const uniq = (label: string) => ('l14-' + label + '-' + (++n) + '-' + Date.now().toString(36)).slice(0, 48);

async function participants(...ids: string[]) {
  await ensureSchema(db);
  for (const id of ids) {
    await db.prepare("INSERT INTO participants (participant_id, display_label, status) VALUES (?1, ?1, 'active') ON CONFLICT(participant_id) DO NOTHING")
      .bind(id).run();
  }
}

/** Cycle ouvert + tâche t1 ouverte par son auteur (task.claim) ; renvoie le store et la révision courante. */
async function seed(label: string) {
  const store = new CollabStore(db, { now: () => new Date('2033-03-0' + ((n % 9) + 1) + 'T10:00:00.000Z') });
  const cycle = uniq(label);
  const [author, reviewer, tester, other] = ['au-' + n, 'rv-' + n, 'ts-' + n, 'ot-' + n];
  await participants(author, reviewer, tester, other);
  let rev = (await store.appendEvent({ cycle_id: cycle, type: 'checkpoint', participant_id: author, expected_rev: 0,
    payload_json: '{}', op_id: author + ':' + cycle + ':cp:1' })).status === 'applied' ? 1 : 0;
  const claim = await store.appendEvent({ cycle_id: cycle, type: 'task.claim', participant_id: author, expected_rev: rev, op_id: author + ':' + cycle + ':claim:1',
    payload_json: JSON.stringify({ task: { task_id: 't1', owner_pid: author, reviewer_pid: reviewer, tester_pid: tester } }) });
  if (claim.status === 'applied') rev = claim.revision;
  let op = 0;
  const append = async (participant: string, payload: Record<string, unknown>, role?: string) => {
    const out = await store.appendEvent({ cycle_id: cycle, type: 'evidence.add', participant_id: participant, expected_rev: rev,
      op_id: participant + ':' + cycle + ':ev:' + (++op), payload_json: JSON.stringify(payload), ...(role ? { role } : {}) });
    if (out.status === 'applied') rev = out.revision;
    return out;
  };
  const code = (promise: Promise<unknown>) => promise.then(() => 'NO_ERROR', (error: { code?: string }) => error.code ?? 'UNKNOWN');
  const count = async () => (await db.prepare("SELECT COUNT(*) AS c FROM events WHERE cycle_id = ?1 AND type = 'evidence.add'").bind(cycle).first<{ c: number }>())!.c;
  return { store, cycle, author, reviewer, tester, other, append, code, count, rev: () => rev };
}

describe('CC-7 L14 — reconnaissance d’un verdict', () => {
  it('verdict = état AGREE/PASS/CHANGES_REQUESTED/FAIL… ou rôle reviewer/tester ; preuve d’auteur non', () => {
    for (const state of ['AGREE', 'PASS — CI vérifiée', 'CHANGES_REQUESTED', 'changes requested', 'FAIL', 'BLOCK', 'OK', 'APPROVE']) {
      expect(isVerdictEvidence({ state }, undefined), state).toBe(true);
    }
    expect(isVerdictEvidence({ verdict: 'agree', state: 'rapport' }, undefined)).toBe(true);
    for (const state of ['CI_PASSED 4/4', 'SUBMITTED', 'bilan', '']) expect(isVerdictEvidence({ state }, undefined), state).toBe(false);
    expect(isVerdictEvidence({ state: 'rapport' }, 'reviewer')).toBe(true);
    expect(isVerdictEvidence({ state: 'rapport' }, 'tester')).toBe(true);
    expect(isVerdictEvidence(null, 'author')).toBe(false);
  });

  it('seuls les verdicts qui citent une PR sont soumis à la règle (pas les critiques de conception L6b)', () => {
    expect(citesPullRequest({ pr: 239 }, undefined)).toBe(true);
    expect(citesPullRequest({ source: 'PR #238 + #239' }, undefined)).toBe(true);
    expect(citesPullRequest({ review: 'voir PR 239' }, undefined)).toBe(true);
    expect(citesPullRequest({ state: 'AGREE' }, 'https://github.com/rfkevin/github-mcp/pull/239')).toBe(true);
    expect(citesPullRequest({ source: 'github-mcp#70 test' }, undefined)).toBe(false);
    expect(citesPullRequest({ source: 'critique', state: 'AMEND' }, '')).toBe(false);
    expect(isPrVerdict({ task: 'synthesis', source: 'vote', state: 'AGREE' }, 'reviewer', '')).toBe(false);
    expect(isPrVerdict({ task: 'l12', source: 'PR #239', state: 'PASS' }, 'tester', '')).toBe(true);
    expect(isPrVerdict({ pr: 239, state: 'SUBMITTED : CI 4/4' }, undefined, '')).toBe(false);
  });

  it('forme : task exigée, head/base structurés exigés (pas extraits du texte)', () => {
    expect(verdictClaimOf({ state: 'AGREE', head: HEAD, base: BASE })).toMatchObject({ code: 'VERDICT_TASK_REQUIRED' });
    expect(verdictClaimOf({ task: 'L 12', head: HEAD, base: BASE })).toMatchObject({ code: 'VERDICT_TASK_REQUIRED' });
    expect(verdictClaimOf({ task: 't1', state: 'AGREE head ' + HEAD + ' base ' + BASE })).toMatchObject({ code: 'VERDICT_PAIR_REQUIRED' });
    expect(verdictClaimOf({ task: 't1', head: HEAD.slice(0, 8), base: BASE })).toMatchObject({ code: 'VERDICT_PAIR_REQUIRED' });
    expect(verdictClaimOf({ task: 't1', head: HEAD, base: BASE })).toEqual({ task: 't1', head: HEAD, base: BASE });
    expect(verdictClaimOf({ task_id: 't1', pr: { head_sha: HEAD.toUpperCase(), base_sha: BASE } })).toEqual({ task: 't1', head: HEAD, base: BASE });
  });
});

describe('CC-7 L14 — le store refuse les verdicts non rattachés (rien n’est écrit)', () => {
  it('tâche inconnue (cas « L12 » du 2026-10-30) → TASK_UNKNOWN', async () => {
    const s = await seed('unknown');
    expect(await s.code(s.append(s.reviewer, { task: 'l12', source: 'PR #239', state: 'AGREE', head: HEAD, base: BASE }, 'reviewer'))).toBe('TASK_UNKNOWN');
    expect(await s.count()).toBe(0);
  });

  it('sans task, sans couple structuré → VERDICT_TASK_REQUIRED / VERDICT_PAIR_REQUIRED', async () => {
    const s = await seed('shape');
    expect(await s.code(s.append(s.reviewer, { pr: 239, state: 'AGREE', head: HEAD, base: BASE }))).toBe('VERDICT_TASK_REQUIRED');
    expect(await s.code(s.append(s.tester, { task: 't1', pr: 239, state: 'PASS au head ' + HEAD }, 'tester'))).toBe('VERDICT_PAIR_REQUIRED');
    expect(await s.count()).toBe(0);
  });

  it('déposant sans rôle sur la tâche, ou l’auteur lui-même → VERDICT_ROLE_REQUIRED', async () => {
    const s = await seed('role');
    expect(await s.code(s.append(s.other, { task: 't1', pr: 239, state: 'AGREE', head: HEAD, base: BASE }))).toBe('VERDICT_ROLE_REQUIRED');
    expect(await s.code(s.append(s.author, { task: 't1', pr: 239, state: 'PASS', head: HEAD, base: BASE }))).toBe('VERDICT_ROLE_REQUIRED');
    expect(await s.count()).toBe(0);
  });

  it('rôle déclaré inversé (le relecteur se déclare tester) → VERDICT_ROLE_REQUIRED', async () => {
    const s = await seed('swap');
    expect(await s.code(s.append(s.reviewer, { task: 't1', pr: 239, state: 'PASS', head: HEAD, base: BASE }, 'tester'))).toBe('VERDICT_ROLE_REQUIRED');
    expect(await s.code(s.append(s.tester, { task: 't1', pr: 239, state: 'AGREE', head: HEAD, base: BASE }, 'reviewer'))).toBe('VERDICT_ROLE_REQUIRED');
    expect(await s.count()).toBe(0);
  });

  it('un refus ne consomme pas de révision', async () => {
    const s = await seed('rev');
    const before = await s.store.currentRevision(s.cycle);
    await s.code(s.append(s.other, { task: 't1', pr: 239, state: 'AGREE', head: HEAD, base: BASE }));
    expect(await s.store.currentRevision(s.cycle)).toBe(before);
  });
});

describe('CC-7 L14 — ce qui reste accepté', () => {
  it('critiques et votes de conception (L6b) sans PR : acceptés, même sur une tâche virtuelle et sans SHA', async () => {
    const s = await seed('design');
    expect((await s.append(s.reviewer, { task: 'p2-proposal-x', source: 'critique', state: 'AMEND', review: 'S3 à préciser' }, 'reviewer')).status).toBe('applied');
    expect((await s.append(s.tester, { task: 'synthesis', source: 'vote', state: 'AGREE', review: 'ok' }, 'tester')).status).toBe('applied');
    expect((await s.append(s.other, { task: 't1', source: 'bilan', state: 'ok' })).status).toBe('applied');
  });

  it('preuves d’auteur (soumission, CI) inchangées, même sans tâche', async () => {
    const s = await seed('author');
    expect((await s.append(s.author, { task: 't1', pr: 239, head: HEAD, base: BASE, state: 'SUBMITTED : CI 4/4' })).status).toBe('applied');
    expect((await s.append(s.author, { source: 'bilan libre', state: 'CI_PASSED 4/4' })).status).toBe('applied');
    expect(await s.count()).toBe(2);
  });

  it('verdicts rattachés : acceptés, et le contrôleur rend merge_ready au couple exact', async () => {
    const s = await seed('ok');
    await s.append(s.author, { task: 't1', pr: 239, head: HEAD, base: BASE, state: 'SUBMITTED' });
    expect((await s.append(s.reviewer, { task: 't1', pr: 239, state: 'AGREE', head: HEAD, base: BASE }, 'reviewer')).status).toBe('applied');
    expect((await s.append(s.tester, { task: 't1', verdict: 'PASS', state: 'tests verts', pr: { number: 239, head_sha: HEAD, base_sha: BASE } }, 'tester')).status).toBe('applied');
    const view = await previewNextActions(db, s.cycle, s.author, { all: true });
    const ready = view.all?.find(d => d.kind === 'merge_ready' && d.task_id === 't1') ?? null;
    expect(ready?.subject).toBe(HEAD + '..' + BASE);
  });

  it('verdict négatif rattaché accepté (CHANGES_REQUESTED du testeur)', async () => {
    const s = await seed('neg');
    expect((await s.append(s.tester, { task: 't1', pr: 239, state: 'CHANGES_REQUESTED : cas A/B/B manquant', head: HEAD, base: BASE }, 'tester')).status).toBe('applied');
  });
});

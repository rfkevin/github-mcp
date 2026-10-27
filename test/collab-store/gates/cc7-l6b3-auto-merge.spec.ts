import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  announceReadyToPromote, autoMergeCandidates, autoMergeConfig, runAutoMergePass, AUTO_MERGE_DEFAULT_CHECKS, type AutoMergeGitHub,
} from '../../../src/collab-store/gates/auto-merge';
import { autoMergeGitHubFrom } from '../../../src/auto-merge-root';
import { listSalonMessages } from '../../../src/collab-store/salon';
import { insertCycleRow, insertEventRow, insertTaskRow } from '../a0-helpers';
import { uniqueIds } from '../coordinator-helpers';

// CC-7 L6b-3 (S11, Q4) — fusion automatique vers l'intégration par la porte CC-5 L4, éteinte par défaut ;
// annonce « prêt à promouvoir » au salon (S8).
const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const uid = uniqueIds('l6b3');
const BRANCH = 'mcp/105856986/cc3-integration';
const REPO = 'rfkevin/github-mcp';
const ON = { AUTO_MERGE_INTEGRATION: 'true', AUTO_MERGE_REPOSITORY: REPO, AUTO_MERGE_BRANCH: BRANCH, SALON_ENABLED: 'true' };
const T = 1_997_000_000;
let n = 0;
const sha = (c: string) => (c + (++n).toString(16)).padEnd(40, c).slice(0, 40);

/** Cycle P6, tâche « l » soumise en PR #pr au couple (head, base) ; verdicts du relecteur et du testeur au choix. */
async function seed(opts: { verdicts?: Array<'reviewer' | 'tester'>; head?: string; base?: string } = {}) {
  const cycle = uid('c');
  const roles = { owner: uid('own'), reviewer: uid('rev'), tester: uid('tst') };
  const head = opts.head ?? sha('a');
  const base = opts.base ?? sha('b');
  await insertCycleRow(db, cycle, 'P6');
  await insertTaskRow(db, { taskId: 'l', cycle, ...roles });
  const events: Array<{ participant: string; role: string; payload: unknown }> = [
    { participant: roles.owner, role: 'owner', payload: { task: 'l', pr: 321, head, base, state: 'SUBMITTED', source: 'github' } },
    ...(opts.verdicts ?? ['reviewer', 'tester']).map(who => ({ participant: roles[who], role: who,
      payload: { task: 'l', pr: 321, head, base, state: who === 'reviewer' ? 'AGREE' : 'PASS', source: 'github' } })),
  ];
  for (const [index, event] of events.entries()) {
    await insertEventRow(db, { cycle, type: 'evidence.add', ...event, key: cycle + ':e' + index, expectedRev: 1 });
  }
  return { cycle, head, base, roles };
}

/** Faux GitHub : PR #321, branche d'intégration dont la tête avance au fast-forward. */
function fakeGitHub(opts: { head: string; base: string; tip?: string; files?: string[]; draft?: boolean; checks?: string[] }) {
  const mergeSha = sha('c');
  let tip = opts.tip ?? opts.base;
  const writes: string[] = [];
  const github: AutoMergeGitHub = {
    async request<T>(path: string, init?: { method: 'POST' | 'PATCH' | 'DELETE'; body?: string }): Promise<T> {
      const method = init?.method ?? 'GET';
      writes.push(method + ' ' + path);
      if (method === 'GET' && path.endsWith('/pulls/321')) return { head: { sha: opts.head } } as T;
      if (method === 'GET' && path.includes('/git/refs/heads/')) return { object: { sha: tip } } as T;
      if (method === 'POST' && path.endsWith('/git/refs')) return {} as T;
      if (method === 'POST' && path.endsWith('/merges')) return { sha: mergeSha } as T;
      if (method === 'PATCH') { tip = (JSON.parse(init!.body!) as { sha: string; force: boolean }).sha; return {} as T; }
      if (method === 'DELETE') return undefined as T;
      throw new Error('route inattendue ' + method + ' ' + path);
    },
    async pull() { return { head: opts.head, draft: opts.draft === true, mergeable: true, state: 'open', baseRef: BRANCH }; },
    async checks() { return (opts.checks ?? [...AUTO_MERGE_DEFAULT_CHECKS]).map(name => ({ name, status: 'completed', conclusion: 'success' })); },
    async changedFiles() { return opts.files ?? ['src/collab-store/controller/rules.ts']; },
    async branchSha() { return tip; },
  };
  return { github, mergeSha, writes, tip: () => tip };
}

describe('CC-7 L6b-3 — configuration (éteinte par défaut)', () => {
  it('« true » exact, dépôt et branche valides, jamais main ni master ; contrôles par défaut ou nommés', () => {
    expect(autoMergeConfig({})).toBeNull();
    expect(autoMergeConfig({ ...ON, AUTO_MERGE_INTEGRATION: 'TRUE' })).toBeNull();
    for (const branch of ['main', 'master', 'MAIN', 'refs/heads/x', 'a..b', '']) {
      expect(autoMergeConfig({ ...ON, AUTO_MERGE_BRANCH: branch }), branch).toBeNull();
    }
    expect(autoMergeConfig({ ...ON, AUTO_MERGE_REPOSITORY: 'pas un dépôt' })).toBeNull();
    expect(autoMergeConfig(ON)).toEqual({ repository: REPO, branch: BRANCH, checks: [...AUTO_MERGE_DEFAULT_CHECKS] });
    expect(autoMergeConfig({ ...ON, AUTO_MERGE_REQUIRED_CHECKS: 'ci, build,ci' })?.checks).toEqual(['ci', 'build']);
  });

  it('éteint : aucun passage, aucun appel GitHub ; racine sans configuration ni secrets = aucun port', async () => {
    const q = await seed();
    const f = fakeGitHub({ head: q.head, base: q.base });
    expect(await runAutoMergePass(db, {}, f.github, { now: () => T })).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(autoMergeGitHubFrom({})).toBeNull();
    expect(autoMergeGitHubFrom(ON)).toBeNull();
  });
});

describe('CC-7 L6b-3 — fusion par la porte CC-5 L4', () => {
  it('deux verdicts au couple exact, CI 4/4, base = tête d’intégration : fusion confirmée, intention merged, trace salon', async () => {
    const q = await seed();
    const f = fakeGitHub({ head: q.head, base: q.base });
    const results = (await runAutoMergePass(db, ON, f.github, { now: () => T })).filter(r => r.cycle_id === q.cycle);
    expect(results).toEqual([expect.objectContaining({ task_id: 'l', pr: 321, outcome: 'merged', detail: f.mergeSha })]);
    expect(f.tip()).toBe(f.mergeSha);
    expect(f.writes.some(w => w.startsWith('PATCH ') && w.includes('/git/refs/heads/'))).toBe(true);
    const intent = await db.prepare('SELECT state, merge_sha FROM cc5_merge_intents WHERE cycle = ?1 AND task = ?2').bind(q.cycle, 'l').first();
    expect(intent).toEqual({ state: 'merged', merge_sha: f.mergeSha });
    const trace = (await listSalonMessages(db, { sinceAt: T - 1 })).find(m => m.body.includes(q.cycle));
    expect(trace).toMatchObject({ author_pid: 'controller', level: 'info' });
  });

  it('refus : verdict manquant (aucun candidat), chemin protégé, base dépassée, PR brouillon, CI incomplète, HALT', async () => {
    const lone = await seed({ verdicts: ['reviewer'] });
    expect((await autoMergeCandidates(db, 200)).some(c => c.cycle_id === lone.cycle)).toBe(false);

    const outcome = async (q: Awaited<ReturnType<typeof seed>>, fake: ReturnType<typeof fakeGitHub>) => {
      const result = (await runAutoMergePass(db, ON, fake.github, { now: () => T })).find(r => r.cycle_id === q.cycle);
      expect(fake.writes.filter(w => w.startsWith('PATCH '))).toEqual([]);
      return result;
    };
    const protectedPath = await seed();
    expect(await outcome(protectedPath, fakeGitHub({ head: protectedPath.head, base: protectedPath.base, files: ['.github/workflows/ci.yml'] })))
      .toMatchObject({ outcome: 'denied', detail: expect.stringContaining('protected_or_invalid_path') });
    const stale = await seed();
    expect(await outcome(stale, fakeGitHub({ head: stale.head, base: stale.base, tip: sha('d') })))
      .toMatchObject({ outcome: 'denied', detail: expect.stringContaining('integration_base_mismatch') });
    const draft = await seed();
    expect(await outcome(draft, fakeGitHub({ head: draft.head, base: draft.base, draft: true })))
      .toMatchObject({ outcome: 'denied', detail: expect.stringContaining('draft_pr') });
    const ci = await seed();
    expect(await outcome(ci, fakeGitHub({ head: ci.head, base: ci.base, checks: ['ci', 'Workers Builds: github-mcp'] })))
      .toMatchObject({ outcome: 'denied', detail: expect.stringContaining('ci_not_green') });

    // Équité : un refus récent attend la fin du bail (300 s) avant d'être retenté ; une fusion faite ne l'est plus.
    const again = fakeGitHub({ head: protectedPath.head, base: protectedPath.base, files: ['.github/workflows/ci.yml'] });
    expect((await runAutoMergePass(db, ON, again.github, { now: () => T + 10 })).some(r => r.cycle_id === protectedPath.cycle)).toBe(false);
    const later = await runAutoMergePass(db, ON, again.github, { now: () => T + 301 });
    expect(later.find(r => r.cycle_id === protectedPath.cycle)).toMatchObject({ outcome: 'denied' });
    expect(later.some(r => r.outcome === 'merged')).toBe(false);

    const halted = await seed();
    await db.prepare("INSERT INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', ?1) ON CONFLICT(name) DO UPDATE SET value = '1'").bind(T).run();
    try {
      // HALT : le contrôleur ne rend plus aucune décision merge_ready, donc aucun candidat.
      expect((await runAutoMergePass(db, ON, fakeGitHub({ head: halted.head, base: halted.base }).github, { now: () => T }))
        .some(r => r.cycle_id === halted.cycle)).toBe(false);
    } finally {
      await db.prepare("UPDATE owner_flags SET value = '0' WHERE name = 'halt'").run();
    }
  });
});

describe('CC-7 L6b-3 — prêt à promouvoir (S8)', () => {
  it('P6 et toutes les tâches terminées : un seul message decision au salon ; salon éteint = rien', async () => {
    const q = await seed();
    await db.prepare("UPDATE tasks SET status = 'done' WHERE cycle_id = ?1").bind(q.cycle).run();
    const open = await seed();
    expect(await announceReadyToPromote(db, {}, { now: () => T })).toEqual([]);
    const first = await announceReadyToPromote(db, ON, { now: () => T });
    expect(first).toContain(q.cycle);
    expect(first).not.toContain(open.cycle);
    expect(await announceReadyToPromote(db, ON, { now: () => T + 1 })).not.toContain(q.cycle);
    const messages = (await listSalonMessages(db, { sinceAt: T - 1, limit: 100 })).filter(m => m.incident_key === 'promote:' + q.cycle);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ level: 'decision', author_pid: 'controller' });
  });
});

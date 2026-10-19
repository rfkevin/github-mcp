import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureContextSchema, mapIssueToCycle, resolveContextTarget } from '../../../src/collab-store/context';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
let n = 0;
const uniq = (label: string) => 'c3r-' + label + '-' + (++n);

async function setup(repository = 'rfkevin/project-mcp-collab') {
  await ensureContextSchema(db);
  const cycle = uniq('cycle');
  await db.prepare(
    "INSERT INTO cycles (cycle_id, project, phase, revision, status) VALUES (?1, ?2, 'P5', 1, 'open')"
  ).bind(cycle, repository).run();
  await mapIssueToCycle(db, 'issue 24', cycle);
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('c3', ?1, 'sol', 'muse', 'vibe', 'in_progress', '[]', 'ref-c3', 'implement', 1)",
  ].join(' ')).bind(cycle).run();
  await db.prepare([
    'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
    "VALUES ('c4', ?1, 'grok', 'sol', 'claude', 'proposed', '[]', 'ref-c4', 'wait', 1)",
  ].join(' ')).bind(cycle).run();
  return cycle;
}

describe('CC-3 C3 — issue -> cycle -> participant -> task', () => {
  it('la seule instruction issue 24 résout une tâche différente pour deux participants', async () => {
    const cycle = await setup();
    const sol = await resolveContextTarget(db, { issue: 'issue 24', participant_id: 'muse' });
    const vibe = await resolveContextTarget(db, { issue: '#24', participant_id: 'vibe' });
    expect(sol.cycle_id).toBe(cycle);
    expect(sol.task).toMatchObject({ task_id: 'c3', participation: 'reviewer' });
    expect(vibe.task).toMatchObject({ task_id: 'c3', participation: 'tester' });
  });

  it('échoue fermé sur ambiguïté de tâche', async () => {
    const cycle = await setup('rfkevin/project-mcp-collab-' + n);
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c6', ?1, 'muse', 'claude', 'vibe', 'proposed', '[]', '', '', 1)",
    ].join(' ')).bind(cycle).run();
    await expect(resolveContextTarget(db, { cycle, participant_id: 'vibe' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_TASK' });
  });

  it('namespace les issues par dépôt et échoue fermé si #24 est ambigu inter-dépôts', async () => {
    const repoA = 'rfkevin/project-mcp-collab-a-' + n;
    const a = await setup(repoA);
    const repoB = 'rfkevin/github-mcp-b-' + n;
    const b = await setup(repoB);
    await expect(resolveContextTarget(db, { issue: '24', participant_id: 'muse' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_ISSUE' });
    const exact = await resolveContextTarget(db, {
      issue: '24',
      repository: repoA,
      participant_id: 'muse',
    });
    expect(exact.cycle_id).toBe(a);
    expect(exact.cycle_id).not.toBe(b);
  });

  it('retourne INVALID_ISSUE_REF plutôt qu’une erreur brute', async () => {
    await expect(resolveContextTarget(db, { issue: 'pas-une-issue', participant_id: 'muse' }))
      .rejects.toMatchObject({ code: 'INVALID_ISSUE_REF' });
  });
});


describe('CC-5 L2 — sélection de tâche explicite', () => {
  it('TASK_UNKNOWN : un task fourni absent du cycle échoue explicitement', async () => {
    const cycle = await setup();
    await expect(resolveContextTarget(db, { cycle, participant_id: 'vibe', task: 'ghost' }))
      .rejects.toMatchObject({ code: 'TASK_UNKNOWN' });
  });

  it('TASK_NOT_HELT : la tâche existe mais le participant ne la tient pas', async () => {
    const cycle = await setup();
    await expect(resolveContextTarget(db, { cycle, participant_id: 'grok', task: 'c3' }))
      .rejects.toMatchObject({
        code: 'TASK_NOT_HELT',
        message: expect.stringContaining('« c3 »'),
      });
  });

  it('TASK_NOT_HELT précise le rôle tenu quand un role différent est exigé', async () => {
    const cycle = await setup();
    await expect(resolveContextTarget(db, { cycle, participant_id: 'vibe', task: 'c3', role: 'reviewer' }))
      .rejects.toMatchObject({
        code: 'TASK_NOT_HELT',
        message: expect.stringContaining('vous êtes tester, pas reviewer'),
      });
  });

  it('AMBIGUOUS_TASK suggère la sélection au lieu de rendre un packet sans tâche', async () => {
    const cycle = await setup();
    await db.prepare([
      'INSERT INTO tasks (task_id, cycle_id, owner_pid, reviewer_pid, tester_pid, status, owned_paths, target_ref, next_action, revision)',
      "VALUES ('c6', ?1, 'muse', 'claude', 'vibe', 'proposed', '[]', '', '', 1)",
    ].join(' ')).bind(cycle).run();
    const outcome = await resolveContextTarget(db, { cycle, participant_id: 'vibe' })
      .then(() => null, e => e as { code: string; message: string });
    expect(outcome).not.toBeNull();
    expect(outcome!.code).toBe('AMBIGUOUS_TASK');
    expect(outcome!.message).toContain('c3 (tester)');
    expect(outcome!.message).toContain('Fournissez task');
  });
});
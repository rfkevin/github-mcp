import { describe, expect, it } from 'vitest';
import { guidedBareDependencies, guidedPrecheck, GUIDED_PRECHECK_TOOL } from '../../../src/collab-store/agentrun/s7-guided';
import type { ToolCall } from '../../../src/collab-store/agentrun/engine';
import { BRANCH, C1, commitAs, db, drive, FAILED, HEAD, host, newRun, PATH, row, SCOPE, scripted, T } from './s7-guided-harness';

const SOURCE = "import { describe, it, expect } from 'vitest';\n"
  + "import { planGuidedS7 } from '../../../src/collab-store/agentrun/s7-guided';\n"
  + "describe('x', () => { it('y', () => { expect(planGuidedS7([], 'p-api-x', 't', 0).kind).toBe('server'); }); });\n";
const commit = (content: string): ToolCall => ({ id: 'c', name: 'github_commit_files',
  args: { message: 'fix', files: [{ path: PATH, content }] } });
const guided = (runId: string, grants: Awaited<ReturnType<typeof newRun>>['grants'],
  model: ReturnType<typeof scripted>, h: ReturnType<typeof host>) =>
  ({ model: model.client, tools: h.tools, now: () => T + 100, workerId: runId, githubCompletionGrants: grants, guidedS7: true });

describe('CC8 S7 precheck U1/U2/U3', () => {
  it('U1 : expect utilisé sans import nommé Vitest est refusé ; commentaires/chaînes ignorés', () => {
    const bad = SOURCE.replace('describe, it, expect', 'describe, it');
    expect(guidedPrecheck(commit(bad), [PATH])).toBe('test_vitest_symbol_missing');
    expect(guidedPrecheck(commit(SOURCE), [PATH])).toBeNull();
    expect(guidedPrecheck(commit(SOURCE + '// beforeEach(() => {})\nconst s = "expect(x)";'), [PATH])).toBeNull();
  });
  it('U1 : aliases importés, fonctions de hook absentes refusées', () => {
    const alias = "import { expect as check, it } from 'vitest';\nit('x', () => check(1).toBe(1));";
    expect(guidedPrecheck(commit(alias), [PATH])).toBeNull();
    expect(guidedPrecheck(commit(SOURCE + "beforeEach(() => {});"), [PATH])).toBe('test_vitest_symbol_missing');
  });
  it('U2 : dépendance absente / déclarée / manifeste indisponible', () => {
    const content = SOURCE + "import { v4 } from 'uuid';";
    expect(guidedBareDependencies(commit(content))).toEqual(['uuid']);
    expect(guidedPrecheck(commit(content), [PATH], undefined, { declaredDependencies: new Set(['vitest']) }))
      .toBe('dependency_not_declared');
    expect(guidedPrecheck(commit(content), [PATH], undefined, { declaredDependencies: new Set(['uuid']) })).toBeNull();
    expect(guidedPrecheck(commit(content), [PATH])).toBe('dependency_manifest_unavailable');
    expect(guidedBareDependencies(commit(SOURCE + "import { randomUUID } from 'node:crypto';"))).toEqual([]);
  });
  it('U3 : seul un diff réellement nul après CI rouge est refusé', () => {
    expect(guidedPrecheck(commit(SOURCE), [PATH], undefined,
      { correction: true, currentFiles: { [PATH]: SOURCE } })).toBe('correction_no_diff');
    expect(guidedPrecheck(commit(SOURCE + '// fix\n'), [PATH], undefined,
      { correction: true, currentFiles: { [PATH]: SOURCE } })).toBeNull();
    expect(guidedPrecheck(commit(SOURCE), [PATH], undefined,
      { correction: false, currentFiles: { [PATH]: SOURCE } })).toBeNull();
  });
  it('D1 : deux corrections sans diff refusées ; aucun second commit ou run CI', async () => {
    const { runId, grants } = await newRun('precheck-noop');
    const model = scripted([commitAs('github_commit_files', SOURCE),
      commitAs('github_commit_files', SOURCE, C1), commitAs('github_commit_files', SOURCE, C1)]);
    const h = host({
      github_write_scope: [SCOPE],
      github_create_branch: [{ branch: BRANCH, sha: HEAD }],
      github_read_file: [() => { throw new Error('new file'); },
        { path: PATH, sha: 'e'.repeat(40), content: SOURCE },
        { path: PATH, sha: 'e'.repeat(40), content: SOURCE }],
      github_commit_files: [{ branch: BRANCH, commit_sha: C1 }],
      github_run_checks: [{ targetSha: C1, runId: 99 }],
      github_check_result: [FAILED(C1)],
    });
    const outcomes = await drive(runId, guided(runId, grants, model, h));
    expect(outcomes.at(-1)).toBe('failed');
    expect((await row(runId)).stop_reason).toBe('guided_stop:precheck_failed');
    expect(h.calls.filter(c => c.name === 'github_commit_files')).toHaveLength(1);
    expect(h.calls.filter(c => c.name === 'github_run_checks')).toHaveLength(1);
    expect(model.seen).toHaveLength(3);
    const entries = await db.prepare('SELECT result FROM agent_run_effects WHERE run_id = ?1 AND tool = ?2')
      .bind(runId, GUIDED_PRECHECK_TOOL).all<{ result: string }>();
    expect(entries.results).toHaveLength(2);
    expect(entries.results.every(x => JSON.parse(x.result).cause === 'correction_no_diff')).toBe(true);
  });
});

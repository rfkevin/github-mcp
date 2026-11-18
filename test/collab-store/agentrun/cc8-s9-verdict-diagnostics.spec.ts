import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createReadToolHost } from '../../../src/collab-store/agentrun/read-tools';
import { createRun } from '../../../src/collab-store/agentrun/engine';
import { safeVerdictMismatchRecovery } from '../../../src/collab-store/agentrun/read-tools';
import { ensureSchema } from '../../../src/collab-store/store/schema';
import { insertCycleRow, insertTaskRow } from '../a0-helpers';

const db = (env as unknown as { COLLAB_DB_C2: D1Database }).COLLAB_DB_C2;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const LIVE_HEAD = 'c'.repeat(40);
const LIVE_BASE = 'd'.repeat(40);

const mismatch = (extra: Record<string, unknown> = {}) => JSON.stringify({
  error: 'VERDICT_COUPLE_MISMATCH',
  recovery: {
    requested_pr: 353, requested_head: HEAD, requested_base: BASE,
    github_head: LIVE_HEAD, github_base: LIVE_BASE,
    github_state: 'open', github_merged: false,
    secret: 'PRIVATE_RECOVERY_DO_NOT_EXPOSE',
    ...extra,
  },
  trace: 'PRIVATE_RAW_RESULT_DO_NOT_EXPOSE',
});

describe('CC8 S9 — diagnostics du verdict API réellement exécutés', () => {
  it('ne conserve que les métadonnées de récupération validées et jamais les champs libres', () => {
    expect(safeVerdictMismatchRecovery(mismatch())).toEqual({
      requested_pr: 353, requested_head: HEAD, requested_base: BASE,
      github_head: LIVE_HEAD, github_base: LIVE_BASE,
      github_state: 'open', github_merged: false,
    });

    for (const invalid of [
      null, '{malformed', JSON.stringify({ error: 'VERDICT_ARGS_INVALID', recovery: {} }),
      mismatch({ requested_pr: -1 }),
      mismatch({ requested_pr: 1.2 }),
      mismatch({ requested_head: 'invalid-sha' }),
      mismatch({ github_base: 'PRIVATE_WRONG_SHA' }),
      mismatch({ github_state: 'secret' }),
      mismatch({ github_merged: 'false' }),
    ]) {
      expect(safeVerdictMismatchRecovery(invalid)).toBeNull();
    }
  });

  it('lit de vrais effets D1 en masquant les secrets et refuse le diagnostic d’un autre participant', async () => {
    await ensureSchema(db);
    const unique = crypto.randomUUID();
    const cycle = 's9-diag-' + unique;
    const task = 's9-diag-task';
    const at = 2_000_000_000;
    await insertCycleRow(db, cycle, 'P6');
    await insertTaskRow(db, { taskId: task, cycle, owner: 'gemini', reviewer: 'vibe', tester: 'grok' });

    const newRun = async (participantId: string, suffix: string) => {
      const runId = 's9-diag-' + suffix + '-' + unique;
      expect((await createRun(db, {
        runId, cycleId: cycle, participantId, taskId: task,
        taskKind: 'implement', prompt: 'test', maxSteps: -1, maxTokens: -1,
        maxCostCents: 0, deadlineAt: at + 3600, now: at,
      })).created).toBe(true);
      return runId;
    };
    const previous = await newRun('gemini', 'failed');
    // La même identité ne peut pas avoir deux runs actifs sur ce bail.
    // Le diagnostic porte sur une WorkSession réellement terminée.
    await db.prepare("UPDATE agent_runs SET status='failed', stop_reason='incomplete_final' WHERE run_id=?1")
      .bind(previous).run();
    const caller = await newRun('gemini', 'caller');
    const stranger = await newRun('vibe', 'stranger');

    for (const [index, result] of [mismatch(), mismatch({ requested_pr: '353' })].entries()) {
      await db.prepare([
        'INSERT INTO agent_run_effects',
        '(effect_key,run_id,n,idx,tool,args,status,updated_at,result)',
        "VALUES (?1,?2,?3,0,'store_verdict',?4,'failed',?5,?6)",
      ].join(' ')).bind(
        's9-diag-effect-' + index + '-' + unique, previous, index,
        'PRIVATE_ARGS_DO_NOT_EXPOSE', at, result,
      ).run();
    }

    const host = createReadToolHost({ db, repository: null, github: null });
    const tool = { id: 'diag', name: 'store_run_diagnostics', args: { run_id: previous } };
    const report = await host.execute(tool, { run_id: caller }) as {
      run_id: string; errors: Array<{ error: string; recovery?: Record<string, unknown> }>;
    };
    expect(report.run_id).toBe(previous);
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0]).toMatchObject({
      error: 'VERDICT_COUPLE_MISMATCH',
      recovery: { requested_pr: 353, github_head: LIVE_HEAD, github_state: 'open' },
    });
    expect(report.errors[1]).toMatchObject({ error: 'VERDICT_COUPLE_MISMATCH' });
    expect(report.errors[1].recovery).toBeUndefined();
    const visible = JSON.stringify(report);
    expect(visible).not.toContain('PRIVATE_RECOVERY_DO_NOT_EXPOSE');
    expect(visible).not.toContain('PRIVATE_RAW_RESULT_DO_NOT_EXPOSE');
    expect(visible).not.toContain('PRIVATE_ARGS_DO_NOT_EXPOSE');

    await expect(host.execute(tool, { run_id: stranger })).rejects.toThrow('run_not_owned_or_unknown');
  });
});

import { describe, expect, it } from 'vitest';
import type { ToolHost } from '../../../src/collab-store/agentrun/engine';
import {
  createReadToolHost, requiredUnifiedCapability, runVerifiedClaims, READ_TOOLS_BY_KIND,
  READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, type ReadToolHostOptions,
} from '../../../src/collab-store/agentrun/read-tools';
import { resolveUnifiedCapabilities } from '../../../src/collab-store/agentrun/agent-capabilities';
import { WRITE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/store-tools';
import { GITHUB_WRITE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/github-tools';
import { S7_SCHEMAS } from '../../../src/collab-store/agentrun/github-write/tools';
import { VERDICT_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/verdict-tools';
import { CONTRIBUTION_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/contribution-tools';
import { MODEL_CHOICE_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/model-choice-tools';
import { RESEARCH_TOOL_SCHEMAS } from '../../../src/collab-store/agentrun/research';
import { db, NOW, seeded, github, writes, messageOf } from './cc8-capability-fixture';

describe('CC8 C2c — le catalogue runtime consomme le contrat unique C0', () => {
  it("l'allowlist par kind est conservée à l'identique ; deux outils restent hors vocabulaire C0", () => {
    expect(READ_TOOLS_BY_KIND).toEqual({
      research: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs'],
      answer: ['store_context', 'store_delta'],
      planning: ['store_context', 'store_delta', 'github_read_file'],
      status: ['store_context', 'store_delta', 'github_check_runs'],
      implement: ['store_context', 'store_delta', 'github_list_directory', 'github_read_file', 'github_pull_request', 'github_check_runs'],
      review: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
      test: ['store_context', 'store_delta', 'github_read_file', 'github_pull_request', 'github_check_runs', 'github_diff'],
      design: ['store_context', 'store_delta'],
    });
    expect(requiredUnifiedCapability('store_choose_model')).toBe('model.choose');
    expect(requiredUnifiedCapability('web_fetch_official')).toBe('web.read');
  });

  it('caractérisation : chaque outil du runtime exige une capacité C0 ou est explicitement hors vocabulaire', () => {
    const ungated = new Set<string>();
    const groups = [READ_TOOL_SCHEMAS, CONTINUITY_TOOL_SCHEMAS, WRITE_TOOL_SCHEMAS, GITHUB_WRITE_TOOL_SCHEMAS,
      S7_SCHEMAS, VERDICT_TOOL_SCHEMAS, CONTRIBUTION_TOOL_SCHEMAS, MODEL_CHOICE_TOOL_SCHEMAS, RESEARCH_TOOL_SCHEMAS];
    let mapped = 0;
    for (const group of groups) {
      for (const schema of group) {
        if (ungated.has(schema.name)) continue;
        expect(requiredUnifiedCapability(schema.name)).not.toBeNull();
        mapped += 1;
      }
    }
    expect(mapped).toBeGreaterThanOrEqual(20);
    expect(requiredUnifiedCapability('github_write_scope')).toBe('github.write');
    expect(requiredUnifiedCapability('store_salon_post')).toBe('salon.announce');
    expect(requiredUnifiedCapability('store_verdict')).toBe('review.verdict');
    expect(requiredUnifiedCapability('store_memory')).toBe('memory.read');
  });

  it('porte absente (défaut) : comportement inchangé, aucun refus de capacité', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github });
    const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
    expect(context.cycle_id).toBeDefined();
    // L'outil d'écriture hors allowlist est refusé par l'allowlist, PAS par le contrat.
    await expect(h.execute({ id: 't2', name: 'github_create_branch', args: {} }, { run_id: runId }))
      .rejects.toThrow(/tool_not_allowlisted/);
  });

  it('porte active : auteur enregistré — socle complet, lectures servies, aucun argument du modèle', async () => {
    const { runId, scope } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const options: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, continuity: true, storeWrites: true };
    const h = createReadToolHost(options);
    const caps = resolveUnifiedCapabilities(await runVerifiedClaims(db, scope, options));
    for (const expected of ['cycle.read', 'memory.read', 'github.read', 'question.ask', 'question.answer',
      'task.status', 'task.handover', 'memory.propose', 'memory.rewrite', 'salon.announce']) {
      expect(caps).toContain(expected);
    }
    const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
    expect(context.cycle_id).toBe(scope.cycle_id);
    const delta = await h.execute({ id: 't2', name: 'store_delta', args: { since_seq: 0 } }, { run_id: runId }) as Record<string, unknown>;
    expect(delta).toHaveProperty('events');
    try {
      // La capacité question.ask est tenue : tout refus éventuel ne vient JAMAIS du contrat.
      await h.execute({ id: 't3', name: 'store_ask', args: { question: 'C2c ?' } }, { run_id: runId });
    } catch (error) {
      expect(messageOf(error)).not.toMatch(/capability_not_held/);
    }
  });

  it('porte active : participant non enregistré — aucun outil servi (fail-closed C0)', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-ghost' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true });
    await expect(h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }))
      .rejects.toThrow(/capability_not_held:cycle\.read/);
  });

  it('porte active : enregistré sans rôle dans le cycle — refus', async () => {
    const { runId } = await seeded({ kind: 'research', participant: 'c2c-intruder' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true });
    await expect(h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }))
      .rejects.toThrow(/capability_not_held:cycle\.read/);
  });

  it('porte active : HALT conserve les lectures, refuse tout effet', async () => {
    const { runId } = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const h: ToolHost = createReadToolHost({ db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, storeWrites: true });
    await db.prepare("INSERT INTO owner_flags (name, value, updated_at) VALUES ('halt', '1', ?1)").bind(NOW).run();
    try {
      const context = await h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
      expect(context.cycle_id).toBeDefined();
      await expect(h.execute({ id: 't2', name: 'store_ask', args: { question: 'bloqué ?' } }, { run_id: runId }))
        .rejects.toThrow(/capability_not_held:question\.ask/);
    } finally {
      await db.prepare("DELETE FROM owner_flags WHERE name = 'halt'").run();
    }
  });

  it('porte active : github.write exige le grant EXACT statique/dynamique S7, pas la configuration de l’hôte (R2)', async () => {
    const author = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const noGrant = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const noPaths = await seeded({ kind: 'implement', participant: 'c2c-author', ownedPaths: '[]' });
    const reviewer = await seeded({ kind: 'review', participant: 'c2c-reviewer' });
    const optionsFor = (cycle: string, task: string, tasks: string): ReadToolHostOptions => ({
      db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true,
      githubWrites: { writes, baseBranch: 'mcp/105856986/cc3-integration',
        s7: { policy: { writers: 'c2c-author', tasks }, reads: null, checks: null } } });
    const grantFor = (cycle: string, task: string) => JSON.stringify([
      { cycle, task, participant: 'c2c-author', branch: 'mcp/105856986/c2c-static', paths: ['src/x.ts'] }]);
    // Grant statique exact : l'auteur tient github.write.
    const withGrant = optionsFor(author.scope.cycle_id, author.scope.task_id, grantFor(author.scope.cycle_id, author.scope.task_id));
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, author.scope, withGrant))).toContain('github.write');
    // Hôte configuré mais SANS grant exact (statique ou dynamique) : plus
    // d'attestation github.write depuis la seule configuration de l'hôte (R2).
    const configured = optionsFor(noGrant.scope.cycle_id, noGrant.scope.task_id, '[]');
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, noGrant.scope, configured))).not.toContain('github.write');
    const h = createReadToolHost(configured);
    await expect(h.execute({ id: 't', name: 'github_write_scope', args: {} },
      { run_id: noGrant.runId, effect_key: 'a'.repeat(64) }))
      .rejects.toThrow(/capability_not_held:github\.write/);
    // Grant statique mais mandat de tâche vide : fail-closed (assertPaths borne chaque effet à grant ∩ owned_paths).
    const emptyMandate = optionsFor(noPaths.scope.cycle_id, noPaths.scope.task_id, grantFor(noPaths.scope.cycle_id, noPaths.scope.task_id));
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, noPaths.scope, emptyMandate))).not.toContain('github.write');
    // Relecteur : jamais github.write (writers exclu, canWriteGitHub exige l'auteur).
    const reviewerOpts = optionsFor(reviewer.scope.cycle_id, reviewer.scope.task_id, grantFor(reviewer.scope.cycle_id, reviewer.scope.task_id));
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, reviewer.scope, reviewerOpts))).not.toContain('github.write');
    // Grant dynamique expiré dans D1 : refusé comme à chaque effet, l'attestation suit (R2).
    const dyn = await seeded({ kind: 'implement', participant: 'c2c-author' });
    const dynOpts = optionsFor(dyn.scope.cycle_id, dyn.scope.task_id, '[]');
    dynOpts.githubWrites!.s7!.policy.dynamic = JSON.stringify(
      { cycle: dyn.scope.cycle_id, participants: ['c2c-author'], path_prefixes: ['src/'], max_paths: 5, max_grants: 10 });
    await db.prepare('INSERT INTO api_dynamic_grants (cycle, task, participant, branch, paths_json, acceptance_json, created_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(dyn.scope.cycle_id, dyn.scope.task_id, 'c2c-author', 'mcp/105856986/c2c-dyn',
        JSON.stringify(['src/x.ts']), JSON.stringify(['critère']), 'gpt6', 1, 1).run();
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, dyn.scope, dynOpts))).not.toContain('github.write');
  });

  it('porte active : réponse adressée sans tâche — relation au cycle prouvée par la question X13 (R1)', async () => {
    const { runId, scope } = await seeded({ kind: 'answer', participant: 'c2c-answerer', taskless: true });
    const options: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true };
    const h: ToolHost = createReadToolHost(options);
    // Aucune question adressée : pas de relation prouvée au cycle, refus (aucun élargissement).
    await expect(h.execute({ id: 't', name: 'store_context', args: {} }, { run_id: runId }))
      .rejects.toThrow(/capability_not_held:cycle\.read/);
    // Question adressée au participant (X13) : la relation est prouvée SANS tâche.
    await db.prepare("INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES (?1, ?2, 'clarify.ask', 'c2c-author', ?3, ?4)")
      .bind(scope.cycle_id, NOW, JSON.stringify({ question: 'Pourquoi C2c ?', to: 'c2c-answerer' }), 'c2c-ask-' + crypto.randomUUID()).run();
    expect((await runVerifiedClaims(db, scope, options)).cycle_member).toBe(true);
    const context = await h.execute({ id: 't2', name: 'store_context', args: {} }, { run_id: runId }) as Record<string, unknown>;
    expect(context.cycle_id).toBe(scope.cycle_id);
    // La relation survit à la fermeture de la question : existence, pas ouverture (pas de rupture en plein run).
    const ask = await db.prepare("SELECT seq FROM events WHERE cycle_id = ?1 AND type = 'clarify.ask'").bind(scope.cycle_id).first<{ seq: number }>();
    await db.prepare("INSERT INTO events (cycle_id, at, type, participant_id, payload_json, idempotency_key) VALUES (?1, ?2, 'clarify.answer', 'c2c-answerer', ?3, ?4)")
      .bind(scope.cycle_id, NOW, JSON.stringify({ ask_seq: ask!.seq, answer: 'Fait.' }), 'c2c-ans-' + crypto.randomUUID()).run();
    expect((await runVerifiedClaims(db, scope, options)).cycle_member).toBe(true);
  });

  it('porte active : review.verdict réservé au pair D12 (reviewer/tester) avec verdicts actifs', async () => {
    const reviewer = await seeded({ kind: 'review', participant: 'c2c-reviewer' });
    const author = await seeded({ kind: 'review', participant: 'c2c-author' });
    const withVerdicts: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, verdicts: true, requiredChecks: [] };
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, reviewer.scope, withVerdicts))).toContain('review.verdict');
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, author.scope, withVerdicts))).not.toContain('review.verdict');
    const h = createReadToolHost(withVerdicts);
    await expect(h.execute({ id: 't', name: 'store_verdict', args: { decision: 'agree' } }, { run_id: author.runId }))
      .rejects.toThrow(/capability_not_held:review\.verdict/);
    // Sans l'option verdicts, même le reviewer titulaire n'obtient pas la capacité d'affichage.
    const without: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true };
    const h2 = createReadToolHost(without);
    await expect(h2.execute({ id: 't2', name: 'store_verdict', args: { decision: 'agree' } }, { run_id: reviewer.runId }))
      .rejects.toThrow(/capability_not_held:review\.verdict/);
  });

  it('porte active : design.contribute et la mémoire, uniquement par grant serveur', async () => {
    const designer = await seeded({ kind: 'design', participant: 'c2c-author' });
    const on: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github,
      unifiedCapabilities: true, contributions: true };
    const caps = resolveUnifiedCapabilities(await runVerifiedClaims(db, designer.scope, on));
    expect(caps).toContain('design.contribute');
    expect(caps).not.toContain('memory.propose');
    const off: ReadToolHostOptions = { db, repository: 'rfkevin/github-mcp', github, unifiedCapabilities: true };
    expect(resolveUnifiedCapabilities(await runVerifiedClaims(db, designer.scope, off))).not.toContain('design.contribute');
  });

});

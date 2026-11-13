import { describe, expect, it } from 'vitest';
import { providerMessagesFromHistory, type CompletedHistoryStep } from '../../../src/collab-store/agentrun/engine';

const makeStep = (id: string, tool: string, receipt: unknown): CompletedHistoryStep => ({
  model_output: JSON.stringify({ text: 'lecture ' + id, tool_calls: [{ id, name: tool, args: {} }] }),
  results: JSON.stringify([{ id, content: JSON.stringify(receipt) }]),
});

describe('CC8 S7 — compaction de la vue fournisseur, sans toucher au journal D1', () => {
  it('ne compacte rien si option absente (compatibilité historique)', () => {
    const steps = [makeStep('a', 'store_context', { data: 'X'.repeat(8000) }),
      makeStep('b', 'github_write_scope', { branch: 'mcp/test', base_sha: 'a'.repeat(40) })];
    const history = providerMessagesFromHistory('mission', steps);
    expect(history.map(x => x.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(history[2].content).toContain('X'.repeat(8000));
  });

  it('compacte les anciens résultats et conserve la dernière paire appel/réponse intacte', () => {
    const base = 'a'.repeat(40);
    const steps = [makeStep('a', 'store_context', { registry: 'X'.repeat(60000), password: 'NE_PAS_EXPOSER' }),
      makeStep('b', 'github_write_scope', { branch: 'mcp/105856986/vibe-api-s7-live', base_sha: base, padding: 'Y'.repeat(60000) }),
      makeStep('c', 'github_create_branch', { branch: 'mcp/105856986/vibe-api-s7-live', sha: base })];
    const compact = providerMessagesFromHistory('mission', steps, true);
    const full = providerMessagesFromHistory('mission', steps, false);
    expect(compact.map(x => x.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
    expect(compact[0].content).not.toContain('NE_PAS_EXPOSER');
    expect(compact[0].content).not.toContain('X'.repeat(100));
    expect(compact[0].content).toContain(base);
    expect(compact[1].tool_calls?.[0].id).toBe('c');
    expect(compact[2].tool_call_id).toBe('c');
    expect(compact[2].content).toBe(JSON.parse(steps[2].results)[0].content);
    // Reconstruction au retour d'un Worker : aucune mémoire volatile ni résumé LLM.
    expect(providerMessagesFromHistory('mission', steps, true)).toEqual(compact);
  });

  it('borne la taille du checkpoint sans perdre le dernier résultat', () => {
    const earlier = Array.from({ length: 70 }, (_, i) => makeStep(String(i), 'github_check_result',
      { branch: 'test-' + i, status: 'completed', sha: 'b'.repeat(40), next_action: 'wait', padding: 'X'.repeat(1000) }));
    const last = makeStep('last', 'github_check_result', { verifiedSuccess: true, sha: 'c'.repeat(40) });
    const messages = providerMessagesFromHistory('mission', [...earlier, last], true);
    expect(messages[0].content.length).toBeLessThan(3900);
    expect(messages[0].content).toContain('Étapes anciennes omises');
    expect(messages.at(-1)?.tool_call_id).toBe('last');
  });
});


  it('garde les jalons de branche et commit même lorsque leurs anciens tours sont éliminés', () => {
    const base = 'a'.repeat(40);
    const branch = 'mcp/105856986/gemini-api-c4';
    const milestones = [
      makeStep('scope', 'github_write_scope', { branch, base_sha: base, branch_head: null }),
      makeStep('create', 'github_create_branch', { branch, sha: base }),
      makeStep('commit', 'github_commit_files', { commit_sha: 'b'.repeat(40) }),
    ];
    const filler = Array.from({ length: 75 }, (_, i) => makeStep(String(i), 'github_read_file',
      { content: 'PRIVATE_SOURCE_' + i + 'X'.repeat(1000), sha: base }));
    const last = makeStep('last', 'github_read_file', { content: 'new', sha: base });
    const messages = providerMessagesFromHistory('mission', [...milestones, ...filler, last], true);
    const context = messages[0].content;
    expect(context).toContain('Jalons déjà exécutés');
    expect(context).toContain(branch);
    expect(context).toContain('github');
    expect(context).toContain('b'.repeat(40));
    expect(context).not.toContain('PRIVATE_SOURCE_0');
    expect(context.length).toBeLessThan(4500);
  });
  it('ne transforme jamais une CI rouge ou un outil refusé en réussite portable', () => {
    const failed = (id: string, tool: string, result: unknown) => ({
      model_output: JSON.stringify({ text: '', tool_calls: [{ id, name: tool, args: {} }] }),
      results: JSON.stringify([{ id, content: JSON.stringify(result), error: true }]),
    });
    const steps = [
      failed('x', 'github_create_branch', { error: 'rejected', sha: 'e'.repeat(40) }),
      makeStep('y', 'github_check_result', { status: 'completed', verifiedSuccess: false }),
      makeStep('z', 'github_read_file', { content: 'ok' }),
    ];
    const compact = providerMessagesFromHistory('mission', steps, true);
    expect(compact[0].content).not.toContain('Jalons déjà exécutés');
  });

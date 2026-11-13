import { describe, expect, it } from 'vitest';
import { providerMessagesFromHistory } from '../../../src/collab-store/agentrun/engine';
import { recentHistoryOffset, RECENT_HISTORY_BYTES, answerPublicationReminder } from '../../../src/collab-store/agentrun/history-policy';
import { toGeminiContents } from '../../../src/collab-store/agentrun/gemini-model';
import { toProviderMessages } from '../../../src/collab-store/agentrun/workers-ai-model';

const step = (id: string, content: string) => ({
  model_output: JSON.stringify({ text: 'analyse-' + id,
    tool_calls: [{ id, name: 'github_read_file', args: { path: 'engine.ts', offset: Number(id) * 12000 } }] }),
  results: JSON.stringify([{ id, content: JSON.stringify({ content, next_offset: (Number(id) + 1) * 12000 }) }]),
});

describe('CC8 recent evidence survives provider changes', () => {
  it('keeps several pages and analysis together instead of forgetting all but the last read', () => {
    const steps = [step('0', 'PAGE_ZERO'), step('1', 'PAGE_ONE'), step('2', 'PAGE_TWO')];
    const before = JSON.stringify(steps);
    const messages = providerMessagesFromHistory('Mission', steps, true);
    expect(messages).toHaveLength(7);
    for (const converter of [() => toProviderMessages('system', messages), () => toGeminiContents('system', messages)]) {
      const body = JSON.stringify(converter());
      for (const text of ['PAGE_ZERO', 'PAGE_ONE', 'PAGE_TWO', 'analyse-0', 'analyse-1', 'analyse-2']) expect(body).toContain(text);
    }
    expect(JSON.stringify(steps)).toBe(before);
  });

  it('evicts whole old units at a UTF-8 budget, preserving recent tool pairs and pagination', () => {
    const steps = [step('0', 'OLD'.repeat(20_000)), step('1', 'ONE'), step('2', 'TWO')];
    expect(recentHistoryOffset(steps, true)).toBe(1);
    const messages = providerMessagesFromHistory('Mission', steps, true);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(messages[0].content).toContain('next_offset');
    expect(messages[1].tool_calls?.[0].id).toBe('1');
    expect(messages[2].tool_call_id).toBe('1');
    expect(messages[3].tool_calls?.[0].id).toBe('2');
    expect(messages[4].tool_call_id).toBe('2');
    expect(JSON.stringify(messages)).not.toContain('OLDOLDOLD');
    const utf8 = [step('0', 'é'.repeat(RECENT_HISTORY_BYTES / 2)), step('1', 'tail')];
    expect(recentHistoryOffset(utf8, true)).toBe(1);
    expect(recentHistoryOffset(utf8, false)).toBe(0);
  });

  it('keeps the latest complete unit even if larger than the view budget', () => {
    const steps = [step('0', 'old'), step('1', 'x'.repeat(RECENT_HISTORY_BYTES + 1))];
    expect(recentHistoryOffset(steps, true)).toBe(1);
    expect(providerMessagesFromHistory('Mission', steps, true).at(-1)?.content).toContain('x'.repeat(RECENT_HISTORY_BYTES + 1));
    expect(recentHistoryOffset([], true)).toBe(0);
  });

  it('retains a steer delivered between recent reads at its chronological position', () => {
    const messages = providerMessagesFromHistory('Mission', [step('0', 'ONE'), step('1', 'TWO')], true,
      [{ message_id: 1, delivered_step: 1, sender_pid: 'gpt6', body: 'RECadrage' }]);
    expect(messages.findIndex(m => m.content.includes('RECadrage'))).toBe(3);
    expect(messages[4].tool_calls?.[0].id).toBe('1');
  });
});

describe('answer publication reminder never fabricates an effect', () => {
  it('pins the original question and allows further evidence gathering', () => {
    const message = answerPublicationReminder('answer', 'Question #2425 du cycle cc8 : analyse', ['store_answer']);
    expect(message).toContain('ask_seq:2425');
    expect(message).toContain('poursuivez les lectures utiles');
    expect(message).toContain('Un texte final seul ne publie rien');
  });
  it('does not infer a target or expose an unavailable publication tool', () => {
    expect(answerPublicationReminder('answer', 'Question #0 du cycle cc8', ['store_answer'])).toBeNull();
    expect(answerPublicationReminder('answer', 'Question #2425 du cycle cc8', [])).toBeNull();
    expect(answerPublicationReminder('review', 'Question #2425 du cycle cc8', ['store_answer'])).toBeNull();
    expect(answerPublicationReminder('answer', 'citation Question #2425 du cycle cc8', ['store_answer'])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MAX_OUTPUT_TOKENS,
  MODEL_TOKEN_CEILING,
  PROVIDER_RATE_WINDOWS,
  TASK_KIND_BOUNDS,
  normalizeTaskKind,
  resolveEffectiveMaxTokens,
  thinkingForTaskKind,
  truncateToUtf8Bytes,
} from '../../../src/collab-store/executors/task-profiles';
import { MAX_OUTPUT_TOKENS as ADAPTER_MAX } from '../../../src/collab-store/executors/adapter';

describe('CC-5 L1 task profiles', () => {
  it('retire le plafond global 2048 au profit de ABSOLUTE_MAX', () => {
    expect(ADAPTER_MAX).toBe(ABSOLUTE_MAX_OUTPUT_TOKENS);
    expect(ABSOLUTE_MAX_OUTPUT_TOKENS).toBeGreaterThan(2048);
  });

  it('résout min(modèle, tâche, endpoint, demandé)', () => {
    expect(resolveEffectiveMaxTokens({
      task_kind: 'probe', model: '@cf/zai-org/glm-4.7-flash', endpoint_ceiling: 4096, requested: 1000,
    })).toBe(256);
    expect(resolveEffectiveMaxTokens({
      task_kind: 'design', model: 'openai/gpt-oss-20b', endpoint_ceiling: 2048, requested: 8000,
    })).toBe(2048);
    expect(resolveEffectiveMaxTokens({
      task_kind: 'review', model: '@cf/google/gemma-4-26b-a4b-it', requested: 512,
    })).toBe(512);
  });

  it('normalise task_kind et thinking', () => {
    expect(normalizeTaskKind('design')).toBe('design');
    expect(normalizeTaskKind('unknown')).toBe('default');
    expect(thinkingForTaskKind('probe')).toBe('off');
    expect(thinkingForTaskKind('review')).toBe('low');
    expect(TASK_KIND_BOUNDS.design.max_tokens).toBe(4096);
  });

  it('documente les plafonds modèle et fenêtres de débit', () => {
    expect(MODEL_TOKEN_CEILING['openai/gpt-oss-20b']).toBe(4096);
    expect(PROVIDER_RATE_WINDOWS.groq.rpm).toBe(30);
    expect(PROVIDER_RATE_WINDOWS.groq.rpd).toBe(1000);
  });

  it('tronque sur frontière UTF-8 (pas au milieu d\'un code point)', () => {
    const text = 'a\u{1F600}b';
    const encoded = new TextEncoder().encode(text);
    expect(encoded.length).toBe(6);
    expect(truncateToUtf8Bytes(text, 3)).toBe('a');
    expect(truncateToUtf8Bytes(text, 5)).toBe('a\u{1F600}');
    expect(truncateToUtf8Bytes(text, 100)).toBe(text);
    expect(truncateToUtf8Bytes(text, 0)).toBe('');
  });
});

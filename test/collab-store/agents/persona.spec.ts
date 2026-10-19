import { describe, expect, it } from 'vitest';
import { AGENT_PERSONAS, assertApiPersona, personaOf, AgentDenied } from '../../../src/collab-store/agents';

describe('CC-5 L3b — personas', () => {
  it('expose les quatre collaborateurs avec api_enabled et modèle free', () => {
    for (const id of ['grok', 'vibe', 'gpt6', 'claude']) {
      const p = personaOf(id)!;
      expect(p.api_enabled).toBe(true);
      expect(p.preferred_free_model.length).toBeGreaterThan(0);
      expect(p.system_duty.toLowerCase()).toContain('d12');
    }
    expect(Object.keys(AGENT_PERSONAS).sort()).toEqual(['claude', 'gpt6', 'grok', 'vibe']);
  });

  it('refuse un participant inconnu ou non API', () => {
    expect(() => assertApiPersona('inconnu')).toThrow(AgentDenied);
    expect(() => assertApiPersona('owner')).toThrow('persona_not_api_enabled');
  });
});

/**
 * cc8-systeme-unique — Tâche S9-api-vibe-implement-pilot
 * 
 * Tests d'intégration pour l'offset compact history-policy.
 * Titre : cc8-s9-api-vibe-pilot
 * Description : Ces tests prouvent le comportement attendu de recentHistoryOffset avec compact=false et compact=true.
 * Rôles D12 : Grok (reviewer), Gemini (tester), Kevin seul fusionne. Pas de déployer/supprimer/autoriser/ignorer HALT/D12.
 *
 * @module test/collab-store/agentrun/cc8-s9-api-vibe-pilot.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { recentHistoryOffset, HistoryPolicy } from '../../../src/collab-store/agentrun/history-policy';

describe('cc8-s9-api-vibe-pilot', () => {
  describe('compact=false', () => {
    it('should return offset 0 for multiple {model_output, results}', () => {
      // Given: multiple {model_output, results} in history
      const history = [
        { model_output: 'output1', results: 1 },
        { model_output: 'output2', results: 2 },
        { model_output: 'output3', results: 3 },
      ];
      // When: compact=false
      const offset = recentHistoryOffset(history, { compact: false });
      // Then: offset should be 0
      expect(offset).toBe(0);
    });
  });

  describe('compact=true', () => {
    it('should preserve all short units and return offset 0', () => {
      // Given: history with short units
      const history = [
        { model_output: 'output1', results: 1 },
        { model_output: 'output2', results: 2 },
      ];
      // When: compact=true
      const offset = recentHistoryOffset(history, { compact: true });
      // Then: offset should be 0 (all short units preserved)
      expect(offset).toBe(0);
    });
  });

  describe('large unit (>48KB)', () => {
    it('should keep two recent short units and return offset 1', () => {
      // Given: large unit (>48KB) with two recent short units before it
      const largeUnit = { model_output: 'a'.repeat(49000), results: 1 };
      const shortUnit1 = { model_output: 'short1', results: 1 };
      const shortUnit2 = { model_output: 'short2', results: 1 };
      const history = [largeUnit, shortUnit1, shortUnit2];
      // When: compact=true (default)
      const offset = recentHistoryOffset(history, { compact: true });
      // Then: two recent short units preserved, offset=1
      expect(offset).toBe(1);
    });
  });
});

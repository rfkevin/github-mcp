import { describe, it, expect } from 'vitest';
import { controllerCronEnabled, scheduledResearchPassId } from '../../../src/collab-store/controller/scheduled';
import workerSource from '../../../src/index.ts?raw';

describe('CC-8 S8c Cron Monitor Safety Tests', () => {
  it('controllerCronEnabled evaluates string boolean correctly', () => {
    expect(controllerCronEnabled('true')).toBe(true);
    expect(controllerCronEnabled('false')).toBe(false);
    expect(controllerCronEnabled(undefined)).toBe(false);
  });

  it('scheduledResearchPassId formats daily pass ID correctly without executing agents', () => {
    const fixedDate = new Date('2025-05-15T10:00:00Z');
    const passId = scheduledResearchPassId(fixedDate);
    expect(passId).toBe('rp-daily-2025-05-15');
  });

  it('scheduled handler is monitor-only: no model run planning, retry or auto-merge', () => {
    // Le raw de la vraie racine Worker vérifie l'absence d'appel agentRunPass
    // ou intégration auto depuis le handler cron, pas juste une fonction auxiliaire.
    const scheduled = workerSource.slice(workerSource.indexOf('async scheduled('));
    expect(scheduled).not.toContain('scheduleAgentRunPass(env, ctx)');
    expect(scheduled).not.toContain('integrationPass(db, env)');
    expect(scheduled).toContain('runScheduledControllers(db');
    // Les webhooks et les événements conservent leur circuit de réveil propre.
    expect(workerSource).toContain('scheduleAgentRunPass(env, ctx)');
  });
});

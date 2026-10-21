/**
 * CC-5 l7 (incrément 7b) — Durable Object SQLite de l'orchestrateur, un objet par
 * clé de bail (idFromName(lease_key)). Coquille : toute la logique est dans
 * `orchestrator.ts` ; D1 reste la source de vérité.
 *
 * Inactif tant que AGENT_RUNS_ENABLED n'est pas « true ». Binding AGENT_RUN
 * déclaré pour l'env cc3-test seulement (wrangler.jsonc).
 */
import { DurableObject } from 'cloudflare:workers';
import {
  objectAlarm, objectWake, SIMULATED_MODEL, EMPTY_TOOL_HOST,
  type AgentRunEnv, type ObjectSlot, type OrchestratorDeps, type WakeResult, type AlarmResult,
} from './orchestrator';
import type { EngineDeps } from './engine';

export interface AgentRunObjectEnv extends AgentRunEnv {
  COLLAB_DB?: D1Database;
  AGENT_RUN?: DurableObjectNamespace<AgentRunObject>;
  /** Tests seulement : nom d'une autre base D1 du même Worker (préfixe COLLAB_DB obligatoire). */
  AGENT_RUN_DB_BINDING?: string;
}

type EngineFactory = (runId: string) => Omit<EngineDeps, 'workerId'>;

let engineFactory: EngineFactory = () => ({ model: SIMULATED_MODEL, tools: EMPTY_TOOL_HOST, now: () => Math.floor(Date.now() / 1000) });

/** Tests seulement : remplace le modèle et les outils de l'orchestrateur. */
export function setAgentRunEngineForTests(factory: EngineFactory | null): void {
  engineFactory = factory ?? (() => ({ model: SIMULATED_MODEL, tools: EMPTY_TOOL_HOST, now: () => Math.floor(Date.now() / 1000) }));
}

export function agentRunDb(env: AgentRunObjectEnv): D1Database | undefined {
  const name = env.AGENT_RUN_DB_BINDING;
  if (name && /^COLLAB_DB[A-Z0-9_]*$/.test(name)) return (env as unknown as Record<string, D1Database | undefined>)[name];
  return env.COLLAB_DB;
}

export class AgentRunObject extends DurableObject<AgentRunObjectEnv> {
  private deps(): OrchestratorDeps {
    const storage = this.ctx.storage;
    const slot: ObjectSlot = {
      get: ((key: string) => storage.get(key)) as ObjectSlot['get'],
      put: ((key: string, value: unknown) => storage.put(key, value)) as ObjectSlot['put'],
      delete: key => storage.delete(key),
      getAlarm: () => storage.getAlarm(),
      setAlarm: at => storage.setAlarm(at),
      deleteAlarm: () => storage.deleteAlarm(),
    };
    const db = agentRunDb(this.env);
    if (!db) throw new Error('agent_run_db_missing');
    return {
      db, env: this.env, slot,
      ownsLease: leaseKey => !!this.env.AGENT_RUN && this.env.AGENT_RUN.idFromName(leaseKey).equals(this.ctx.id),
      nowMs: () => Date.now(),
      engine: runId => engineFactory(runId),
      workerId: () => 'do:' + crypto.randomUUID(),
    };
  }

  async wake(runId: string, leaseKey: string): Promise<WakeResult> {
    return objectWake(this.deps(), runId, leaseKey);
  }

  async alarm(): Promise<void> {
    await this.runAlarm();
  }

  /** Même chose que alarm(), avec le résultat (tests et diagnostic). */
  async runAlarm(): Promise<AlarmResult> {
    return objectAlarm(this.deps());
  }
}

/** Réveil depuis le Worker : l'objet de la clé de bail, par RPC. */
export function wakeViaNamespace(namespace: DurableObjectNamespace<AgentRunObject>) {
  return (leaseKey: string, runId: string): Promise<WakeResult> =>
    namespace.get(namespace.idFromName(leaseKey)).wake(runId, leaseKey) as Promise<WakeResult>;
}

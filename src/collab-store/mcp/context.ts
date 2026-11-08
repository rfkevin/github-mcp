1: /**
2:  * CC-3 C2 — contexte d'outil du store collab. Fail-closed : sans binding
3:  * COLLAB_DB, aucune instance n'est créée.
4:  */
5: import { CollabStore, CollabStoreError, type StoreOptions } from '../store/collab-store';
6: import { collabDailyWriteLimit, type CollabStoreEnv } from '../store/config';
7: import { resolveTokenParticipant, type ParticipantIdentity } from '../identity';
8: import { parseFallbackState, storeFallback, type StoreFallback } from '../export/fallback';
9: import {
10:   parseDailyCap, parseNeuronBudget, providerAdapterFactory,
11:   type AdapterFactory, type ProviderAdapterEnv,
12: } from '../executors/run';
13: import type { PolicyEnv } from '../agentrun/model-policy';
import type { AgentRunObjectEnv } from '../agentrun/object';
14: 
15: export interface CollabExecutionEnv extends CollabStoreEnv, ProviderAdapterEnv {
16:   EXECUTOR_DAILY_CAP?: string;
17:   WORKERS_AI_DAILY_NEURONS?: string;
18:   /** CC-7 L4 : porte du salon d'équipe (« true » exact seulement). */
19:   SALON_ENABLED?: string;
20:   /** CC-7 L9a : porte des exécutions API (catalogue des modèles et choix de modèle). */
21:   AGENT_RUNS_ENABLED?: string;
22:   /** CC-7 L11 : porte des chercheurs en tournante (collab_research_assign). */
23:   AGENT_RUN_RESEARCH?: string;
24: }
25: 
26: /**
27:  * CC-7 L9a : vue du Worker utile au catalogue des modèles — variables AGENT_RUN_*, attestations
28:  * gratuites, origine ; chaque secret LLM_KEY_* réduit à un marqueur de présence (jamais sa valeur),
29:  * le binding AI à un booléen.
30:  */
31: export function modelEnvOf(env: object): PolicyEnv {
32:   const out: Record<string, unknown> = {};
33:   for (const [key, value] of Object.entries(env)) {
34:     if (/^(AGENT_RUN_|GEMINI_FREE_PROJECT_ATTESTED$|GROQ_FREE_PROJECT_ATTESTED$|PUBLIC_ORIGIN$)/.test(key) && typeof value === 'string') out[key] = value;
35:     else if (/^LLM_KEY_[A-Z]+$/.test(key) && typeof value === 'string' && value.trim()) out[key] = 'present';
36:     else if (key === 'AI' && value) out[key] = true;
37:   }
38:   return out as PolicyEnv;
39: }
40: 
41: export interface CollabToolContext {
42:   actor: string;
43:   store: CollabStore;
44:   scopes: readonly string[];
45:   /** CC-3 C5 : identité dérivée du client OAuth du jeton (I8), résolue une fois par requête. */
46:   identity: () => Promise<ParticipantIdentity>;
47:   /** CC-3 C6 : repli explicite en lecture seule renvoyé avec STORE_UNAVAILABLE (R4). */
48:   fallback: StoreFallback;
49:   db: D1Database;
50:   executor: { factory: AdapterFactory; dailyCap: number; neuronBudget: number; now: () => Date };
51:   /** CC-7 L4 : variables de porte lues à la construction (salon) ; CC-7 L9a : exécutions API. */
52:   flags: { salonEnabled: boolean; agentRunsEnabled: boolean; researchEnabled: boolean };
53:   /** CC-7 L9a : vue réduite du Worker pour le catalogue des modèles (aucune valeur de secret). */
54:   models: PolicyEnv;
  agentRunEnv: AgentRunObjectEnv;
55:   /** CC-8 S8a : hook de réveil événementiel du store (optionnel, jamais bloquant). */
56:   onApplied?: (event: { type: string; payload_json: string }) => void;
57: }
58: 
59: export function createCollabToolContext(
60:   env: CollabExecutionEnv,
61:   actor: string,
62:   scopes: readonly string[],
63:   options: StoreOptions = {},
64:   clientId = '',
65: ): CollabToolContext {
66:   if (!env.COLLAB_DB) {
67:     throw new CollabStoreError('STORE_NOT_CONFIGURED', 'COLLAB_DB non lié : store collab désactivé (fail-closed).');
68:   }
69:   const now = options.now ?? (() => new Date());
70:   const store = new CollabStore(env.COLLAB_DB, {
71:     dailyWriteLimit: options.dailyWriteLimit ?? collabDailyWriteLimit(env.COLLAB_DAILY_WRITE_LIMIT),
72:     now,
73:     // CC-8 S8a : réveil événementiel — propagé au store (hook applied) et au contexte (actes hors appendEvent).
74:     ...(options.onApplied ? { onApplied: options.onApplied } : {}),
75:   });
76:   const db = env.COLLAB_DB;
77:   let resolved: Promise<ParticipantIdentity> | undefined;
78:   return { actor, store, scopes, db, fallback: storeFallback(parseFallbackState(env.COLLAB_FALLBACK_STATE)),
79:     executor: {
80:       factory: providerAdapterFactory(env),
81:       dailyCap: parseDailyCap(env.EXECUTOR_DAILY_CAP),
82:       neuronBudget: parseNeuronBudget(env.WORKERS_AI_DAILY_NEURONS),
83:       now,
84:     },
85:     flags: { salonEnabled: env.SALON_ENABLED === 'true', agentRunsEnabled: env.AGENT_RUNS_ENABLED === 'true',
86:       researchEnabled: env.AGENT_RUN_RESEARCH === 'true' },
87:     models: modelEnvOf(env),
    agentRunEnv: env as unknown as AgentRunObjectEnv,
88:     ...(options.onApplied ? { onApplied: options.onApplied } : {}),
89:     // clientId vient du jeton validé (handler.ts) : seul chemin qui enregistre un client observé.
90:     identity: () => (resolved ??= resolveTokenParticipant(db, clientId)) };
91: }
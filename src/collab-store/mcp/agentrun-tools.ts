1: /**
2:  * CC-5 l7e — outils MCP de continuité chat pour les exécutions API du participant.
3:  * Identité uniquement depuis le jeton serveur ; jamais d'accès aux runs d'autrui.
4:  */
5: import type { McpServer } from '@modelcontextprotocol/server';
6: import { z } from 'zod';
7: import type { CollabToolContext } from './context';
8: import { collabFailure } from './result';
9: import { CollabStoreError } from '../store/collab-store';
10: import {
11:   listRunsForParticipant,
12:   runSummaryForParticipant,
13:   redactedRunSummaryFor,
14:   preemptOwnRun,
15:   releaseOwnRun,
16:   CHAT_HOLD_SECONDS_DEFAULT,
17: } from '../agentrun/chat-continuity';
18: import { coordinatorRunOverview } from '../agentrun/capacity';
import { launchCoordinatorImplement } from '../agentrun/coordinator-launch';
import { wakeViaNamespace } from '../agentrun/object';
19: import { previewNextActions } from '../controller/next-actions';
20: import { isCoordinator } from '../owner/coordinators';
21: 
22: const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
23: const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
24: 
25: async function registered(context: CollabToolContext, tool: string): Promise<string> {
26:   const identity = await context.identity();
27:   if (identity.status !== 'registered') {
28:     throw new CollabStoreError('UNREGISTERED_CLIENT', tool + ' : client non associé à un participant enregistré.');
29:   }
30:   return identity.participant_id;
31: }
32: 
33: export function registerAgentRunTools(server: McpServer, context: CollabToolContext): void {
34:   server.registerTool('collab_agent_runs_overview', {
35:     title: 'Vue du coordinateur sur les exécutions API (CC-8 S1a)',
36:     description: 'Lecture seule, coordinateur seulement (mandat du cycle ou coordinateur owner-approved, sinon COORDINATOR_REQUIRED) : '
37:       + 'pour un cycle, état des exécutions API de TOUS les agents (statut, code d’arrêt, étapes, jetons, coût), comptes par agent, '
38:       + 'dernier verdict de capacité du planificateur par agent et type (refus typé ou modèle retenu) et maillons en pause coupe-circuit. '
39:       + 'Métadonnées seulement : ni consigne, ni résumé, ni sortie de modèle.',
40:     inputSchema: {
41:       cycle_id: z.string().min(1).max(64),
42:       limit: z.number().int().min(1).max(100).optional(),
43:     },
44:     annotations: READ_ONLY,
45:   }, async (input) => {
46:     try {
47:       const participantId = await registered(context, 'collab_agent_runs_overview');
48:       const view = await previewNextActions(context.db, input.cycle_id, participantId);
49:       if (!view.coordinator && !await isCoordinator(context.db, participantId)) {
50:         throw new CollabStoreError('COORDINATOR_REQUIRED', 'collab_agent_runs_overview : réservé au coordinateur du cycle ' + input.cycle_id + '.');
51:       }
52:       const overview = await coordinatorRunOverview(context.db, input.cycle_id, { now: Math.floor(Date.now() / 1000), limit: input.limit });
53:       return { content: [{ type: 'text' as const, text: JSON.stringify(overview) }] };
54:     } catch (error) {
55:       return collabFailure(error, 'Vue des exécutions impossible.', {}, context.fallback);
56:     }
57:   });
58: 
59:   server.registerTool('collab_launch_implement', {
    title: 'Lancer un run GitHub S7 sur le moteur API existant (coordinateur)',
    description: 'Coordinateur owner-approved uniquement. Sous grant GitHub owner exact et budget payant 0, attribue si besoin une tache au modele API (claim coordinateur puis handoff D12), cree un run implement idempotent et programme immediatement le Durable Object. takeover_chat libere explicitement le bail de chat, jamais automatiquement. Retourne le run_id ; ne patiente pas pour CI/PR.',
    inputSchema: {
      cycle: z.string().min(1).max(64),
      task: z.string().min(1).max(64),
      participant: z.string().min(1).max(128),
      reviewer: z.string().min(1).max(128).optional(),
      tester: z.string().min(1).max(128).optional(),
      takeover_chat: z.boolean().default(false),
      op_id: z.string().min(1).max(253),
    },
    outputSchema: outputSchemas.collab_launch_implement,
    annotations: WRITE,
  }, async (input) => {
    try {
      const identity = await context.identity();
      const namespace = context.agentRunEnv.AGENT_RUN;
      if (identity.status !== 'registered' || !namespace) {
        throw new CollabStoreError('AGENT_RUN_UNAVAILABLE', 'Identite et binding Durable Object requis.');
      }
      const result = await launchCoordinatorImplement({
        db: context.db, store: context.store, env: context.agentRunEnv,
        coordinator: identity.participant_id,
        cycle: input.cycle, task: input.task, participant: input.participant,
        reviewer: input.reviewer, tester: input.tester, takeoverChat: input.takeover_chat,
        opId: input.op_id, now: Math.floor(Date.now() / 1000),
        wake: wakeViaNamespace(namespace),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return collabFailure(error, 'Lancement API S7 refuse.', {}, context.fallback);
    }
  });

  server.registerTool('collab_list_agent_runs', {
60:     title: 'Lister mes exécutions API (CC-5 l7e)',
61:     description: 'Lecture seule : exécutions agent API de VOTRE participant serveur uniquement (masquage CR-C). Option cycle_id pour filtrer. Aucune écriture.',
62:     inputSchema: {
63:       cycle_id: z.string().min(1).max(64).optional(),
64:       limit: z.number().int().min(1).max(40).optional(),
65:     },
66:     annotations: READ_ONLY,
67:   }, async (input) => {
68:     try {
69:       const participantId = await registered(context, 'collab_list_agent_runs');
70:       const runs = await listRunsForParticipant(context.db, participantId, {
71:         cycleId: input.cycle_id,
72:         limit: input.limit,
73:       });
74:       return { content: [{ type: 'text' as const, text: JSON.stringify({ runs }) }] };
75:     } catch (error) {
76:       return collabFailure(error, 'Liste des exécutions impossible.', {}, context.fallback);
77:     }
78:   });
79: 
80:   server.registerTool('collab_agent_run_summary', {
81:     title: 'Résumé d’une exécution API (CC-5 l7e)',
82:     description: 'Lecture seule : résumé d’une exécution. Propriétaire du run : résumé complet (summary) et résumé expurgé (redacted). Coordinateur au mandat actif du cycle du run (CC8 lot B #282) : résumé expurgé seulement — statut, stop_reason masqué, étapes serveur/modèle, jetons, coût, reçus d’effets (SHA, PR, CI), relevés CI, appels modèle (maillon choisi, servi, repli), preuve serveur run.proof ; jamais de prompt, sortie modèle, argument ni contenu. Toute autre identité ou run inconnu → null.',
83:     inputSchema: {
84:       run_id: z.string().min(1).max(128),
85:     },
86:     annotations: READ_ONLY,
87:   }, async (input) => {
88:     try {
89:       const participantId = await registered(context, 'collab_agent_run_summary');
90:       const summary = await runSummaryForParticipant(context.db, participantId, input.run_id);
91:       const redacted = await redactedRunSummaryFor(context.db, participantId, input.run_id);
92:       return { content: [{ type: 'text' as const, text: JSON.stringify({ summary, redacted }) }] };
93:     } catch (error) {
94:       return collabFailure(error, 'Résumé d’exécution impossible.', {}, context.fallback);
95:     }
96:   });
97: 
98:   server.registerTool('collab_preempt_agent_run', {
99:     title: 'Préempter le bail API (chat prioritaire, CC-5 l7e / CC-7 L1)',
100:     description: 'Le chat prend le bail (fencing 7a) pour VOTRE identité serveur (cycle/task). CC-7 L1 : aucune exécution préalable requise — ouverture de session chat. hold_seconds défaut 900. Une étape API en vol perd ses écritures LIVE. CC-7 L15 : collab_append_event prend déjà ce bail automatiquement (1 h, renouvelée) à chaque écriture sur une tâche ; cet outil sert à le prendre plus longtemps (jusqu’à 24 h) avant un long travail sans écriture.',
101:     inputSchema: {
102:       cycle_id: z.string().min(1).max(64),
103:       task_id: z.string().max(64).optional(),
104:       hold_seconds: z.number().int().min(0).max(86_400).optional(),
105:     },
106:     annotations: WRITE,
107:   }, async (input) => {
108:     try {
109:       const participantId = await registered(context, 'collab_preempt_agent_run');
110:       const now = Math.floor(Date.now() / 1000);
111:       const result = await preemptOwnRun(context.db, {
112:         participantId,
113:         cycleId: input.cycle_id,
114:         taskId: input.task_id ?? '',
115:         now,
116:         holdSeconds: input.hold_seconds ?? CHAT_HOLD_SECONDS_DEFAULT,
117:       });
118:       if (!result.ok) {
119:         throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Identité ou cycle invalide pour la préemption.');
120:       }
121:       return { content: [{ type: 'text' as const, text: JSON.stringify({ preempted: true, generation: result.generation }) }] };
122:     } catch (error) {
123:       return collabFailure(error, 'Préemption impossible.', {}, context.fallback);
124:     }
125:   });
126: 
127:   server.registerTool('collab_release_agent_run', {
128:     title: 'Rendre la main à l’API (CC-5 l7e / CC-7 L1)',
129:     description: 'Libère le bail chat pour VOTRE identité (holder none). CC-7 L1 : aucune exécution préalable requise.',
130:     inputSchema: {
131:       cycle_id: z.string().min(1).max(64),
132:       task_id: z.string().max(64).optional(),
133:     },
134:     annotations: WRITE,
135:   }, async (input) => {
136:     try {
137:       const participantId = await registered(context, 'collab_release_agent_run');
138:       const now = Math.floor(Date.now() / 1000);
139:       const result = await releaseOwnRun(context.db, {
140:         participantId,
141:         cycleId: input.cycle_id,
142:         taskId: input.task_id ?? '',
143:         now,
144:       });
145:       if (!result.ok) {
146:         throw new CollabStoreError('AGENT_RUN_NOT_OWNED', 'Identité ou cycle invalide pour le relâchement.');
147:       }
148:       return { content: [{ type: 'text' as const, text: JSON.stringify({ released: true }) }] };
149:     } catch (error) {
150:       return collabFailure(error, 'Relâchement impossible.', {}, context.fallback);
151:     }
152:   });
153: }
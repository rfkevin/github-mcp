1: /**
2:  * CC-3 C2/F5 — schémas de sortie (RAW SHAPES : registerTool attend un ZodRawShape,
3:  * pas un z.object complet).
4:  */
5: import { z } from 'zod';
6: 
7: /**
8:  * Événement public du journal (STORED_EVENT_COLUMNS côté store). Publié strict
9:  * (additionalProperties: false) : toute sortie passe par toEventOutput().
10:  */
11: export const storedEvent = {
12:   seq: z.number(),
13:   cycle_id: z.string(),
14:   at: z.number(),
15:   type: z.string(),
16:   participant_id: z.string(),
17:   session_id: z.string(),
18:   role: z.string(),
19:   payload_json: z.string(),
20:   expected_rev: z.number(),
21:   idempotency_key: z.string(),
22:   evidence_ref: z.string(),
23: };
24: 
25: const contextTask = {
26:   task_id: z.string(),
27:   owner_pid: z.string(),
28:   reviewer_pid: z.string(),
29:   tester_pid: z.string(),
30:   status: z.string(),
31:   owned_paths: z.string(),
32:   next_action: z.string(),
33:   revision: z.number(),
34: };
35: 
36: const packetMemory = {
37:   id: z.string(),
38:   version: z.number(),
39:   scope: z.string(),
40:   kind: z.string(),
41:   text: z.string(),
42:   confidence: z.string(),
43: };
44: 
45: const capabilitySet = {
46:   tools: z.array(z.string()).optional(),
47:   repositories: z.array(z.string()).optional(),
48:   branch_paths: z.array(z.string()).optional(),
49:   network_providers: z.array(z.string()).optional(),
50:   token_ceiling: z.number().optional(),
51:   cost_ceiling: z.number().optional(),
52: };
53: 
54: export const outputSchemas = {
  collab_launch_implement: {
    status: z.enum(['started', 'existing', 'wake_pending']),
    run_id: z.string(), cycle: z.string(), task: z.string(), participant: z.string(),
    wake_accepted: z.boolean(), cost_cents: z.literal(0), detail: z.string(),
  },
55:   collab_dispatch_task: {
56:     status: z.enum(['succeeded', 'attempt_failed', 'busy', 'terminal', 'replayed']),
57:     invocation_id: z.string(),
58:     state: z.string(),
59:     replayed: z.boolean(),
60:     output: z.string().optional(),
61:     error: z.string().optional(),
62:     usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), operations: z.number() }),
63:     provenance: z.array(z.string()),
64:     latency_ms: z.number(),
65:   },
66:   collab_list_executors: {
67:     executors: z.array(z.object({
68:       endpoint_id: z.string(), principal_id: z.string(), provider: z.string(), model: z.string(), status: z.string(),
69:       capability_set: z.object(capabilitySet), token_ceiling: z.number().nullable(),
70:       quota: z.object({
71:         calls_limit: z.number(), calls_used: z.number(), calls_remaining: z.number(),
72:         neurons_limit: z.number().nullable(), neurons_used: z.number().nullable(), neurons_remaining: z.number().nullable(),
73:       }),
74:       performance_7d: z.object({
75:         invocations: z.number(), succeeded: z.number(), failed: z.number(), success_rate: z.number(),
76:         failures_by_code: z.array(z.object({ code: z.string(), count: z.number() })),
77:         latency_avg_ms: z.number(), latency_p95_ms: z.number(),
78:       }),
79:       owner_notes: z.object({ strengths: z.string(), weaknesses: z.string() }),
80:     })),
81:   },
82:   collab_get_context: {
83:     cycle_id: z.string(),
84:     phase: z.string(),
85:     status: z.string(),
86:     revision: z.number(),
87:     tasks: z.array(z.object(contextTask)),
88:     participant_id: z.string().nullable().optional(),
89:     caller: z.object({ participant_id: z.string(), status: z.enum(['registered', 'unregistered']) }).optional(),
90:     resolved: z.object({
91:       cycle_id: z.string(),
92:       task: z.object({
93:         ...contextTask,
94:         cycle_id: z.string().optional(),
95:         target_ref: z.string().optional(),
96:         participation: z.string().optional(),
97:       }).nullable(),
98:     }).optional(),
99:     packet: z.object({
100:       header: z.object({
101:         cycle_id: z.string(),
102:         phase: z.string(),
103:         revision: z.number(),
104:         status: z.string(),
105:         participant_id: z.string(),
106:         last_seen_seq: z.number(),
107:       }),
108:       role_card: z.object({ role: z.string(), duty: z.string() }).nullable(),
109:       memory: z.array(z.object(packetMemory)),
110:       open_questions: z.array(z.string()),
111:       refs: z.object({ items: z.array(z.string()), complete: z.literal(false) }),
112:       excluded_memory_ids: z.array(z.string()),
113:       budget: z.object({ max_tokens: z.number(), estimated_tokens: z.number() }),
114:     }).optional(),
115:     // CC-7 L3 : continuité chat/API du participant (lecture seule, bornée).
116:     since_last_visit: z.object({
117:       last_visit_seq: z.number(),
118:       last_visit_at: z.number(),
119:       api_runs: z.array(z.object({
120:         run_id: z.string(), task_kind: z.string(), status: z.string(), stop_reason: z.string(),
121:         created_at: z.number(), updated_at: z.number(), summary: z.string(),
122:       })),
123:       handovers: z.array(z.object({
124:         seq: z.number(), at: z.number(), channel: z.enum(['api', 'chat']), done: z.string(), todo: z.string(), learned: z.string(),
125:       })),
126:       truncated: z.object({ api_runs: z.boolean(), handovers: z.boolean() }),
127:     }).optional(),
128:     // CC-7 L12 : travail en cours du même agent (chat ou API), lecture seule et bornée.
129:     active_work: z.object({
130:       last_chat_write: z.object({ seq: z.number(), at: z.number(), type: z.string(), session_id: z.string(), task: z.string().nullable() }).nullable(),
131:       open_api_runs: z.array(z.object({ run_id: z.string(), task_id: z.string(), task_kind: z.string(), status: z.string(), updated_at: z.number() })),
132:       last_checkpoints: z.array(z.object({ task: z.string().nullable(), seq: z.number(), at: z.number(), channel: z.enum(['api', 'chat']), summary: z.string() })),
133:       truncated: z.object({ open_api_runs: z.boolean(), last_checkpoints: z.boolean() }),
134:     }).optional(),
135:     delta: z.object({
136:       events: z.array(z.object(storedEvent)),
137:       hasMore: z.boolean(),
138:     }).optional(),
139:   },
140:   collab_phase_advance: {
141:     status: z.enum(['applied', 'duplicate']),
142:     revision: z.number(),
143:     event_seq: z.number(),
144:   },
145:   collab_get_delta: {
146:     cycle_id: z.string(),
147:     events: z.array(z.object(storedEvent)),
148:     hasMore: z.boolean(),
149:   },
150:   collab_append_event: {
151:     status: z.enum(['applied', 'duplicate']),
152:     revision: z.number().optional(),
153:     event: z.object(storedEvent).optional(),
154:     // CR-B (CR-02) : effet memory_entries d'un événement memory.* applied.
155:     memory: z.object({ id: z.string(), version: z.number(), status: z.string() }).optional(),
156:     // CC-7 L12 : autre session nommée du même agent sur la même tâche (< 30 min) — avertissement, rien de bloqué.
157:     concurrent_session: z.object({ other_session_id: z.string(), seq: z.number(), at: z.number(), task: z.string() }).optional(),
158:     // CC-7 L15 : bail du chat pris (held, jusqu'à held_until) ou rendu (released) par cette écriture sur une tâche.
159:     chat_lease: z.object({ task: z.string(), action: z.enum(['held', 'released']), held_until: z.number().optional() }).optional(),
160:   },
161:   // CC-3 C6 : instantané pour une PR GitHub (lecture seule).
162:   collab_export: {
163:     cycle_id: z.string(),
164:     format: z.enum(['cc-state-1', 'memory-md']),
165:     content: z.string(),
166:     content_sha256: z.string(),
167:     state: z.object({
168:       revision: z.number(),
169:       base_revision: z.number(),
170:       changed: z.boolean(),
171:       changes: z.object({ phase: z.boolean(), tasks: z.array(z.string()), owner_decisions: z.number(), evidence: z.number() }),
172:       imported: z.object({
173:         event_seq: z.number(),
174:         state_revision: z.number(),
175:         content_sha256: z.string(),
176:         target: z.object({ repository: z.string(), path: z.string(), ref: z.string() }).nullable(),
177:       }),
178:       store_revision: z.number(),
179:       last_seq: z.number(),
180:       snapshot_seq: z.number(),
181:     }).optional(),
182:     memory: z.object({ entries: z.number(), scopes: z.array(z.string()) }).optional(),
183:     publish: z.string(),
184:   },
185:   // CC-7 M1b : inventaire mémoire ré-exécutable (lecture seule, correctif revue GPT-6).
186:   collab_memory_inventory: {
187:     viewer: z.object({ participant_id: z.string(), status: z.enum(['registered', 'unregistered']) }),
188:     entries: z.array(z.object({
189:       id: z.string(), version: z.number(), scope: z.string(), kind: z.string(),
190:       status: z.string(), confidence: z.string(), token_cost: z.number(),
191:       author_pid: z.string(), reviewer_pid: z.string(),
192:       supersedes: z.string().nullable(), expires_rev: z.number().nullable(),
193:     })),
194:     has_more: z.boolean(),
195:     next_cursor: z.string().optional(),
196:     scopes: z.array(z.object({
197:       scope: z.string(), family: z.string(), budget: z.number(), tokens_active: z.number(),
198:       counts: z.object({ candidate: z.number(), active: z.number(), superseded: z.number(), retired: z.number() }),
199:       baseline: z.number(), occurrences: z.number(), paused: z.boolean(),
200:       pauses: z.array(z.object({
201:         occurrence: z.number(), reason: z.string(), request_id: z.string(),
202:         opened_seq: z.number(), opened_at: z.number(),
203:         decision: z.string().nullable(), decided_at: z.number().nullable(), open: z.boolean(),
204:         corrective_events: z.array(z.object({
205:           seq: z.number(), at: z.number(), type: z.string(), cycle_id: z.string(), id: z.string(),
206:         })),
207:         corrective_truncated: z.boolean(),
208:       })),
209:     })),
210:     scopes_truncated: z.boolean(),
211:   },
212:   // CC-7 M1b : simulation pure des seuils de pause (aucune lecture du store).
213:   collab_memory_growth_simulate: {
214:     rule: z.object({
215:       growth_alarm_percent: z.number(),
216:       pause_condition: z.string(),
217:       resume: z.string(),
218:     }),
219:     growth: z.array(z.object({ k: z.number(), pauses: z.array(z.number()) })),
220:     budget: z.object({
221:       tokens_used: z.number(), avg_cost: z.number(), budget: z.number(),
222:       accepted: z.number(), refused: z.number(), tokens_after: z.number(),
223:     }).optional(),
224:   },
225: };
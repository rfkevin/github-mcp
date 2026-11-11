# CC8 U2b — first causal fixes (post PR #311)

**Baseline** integration 218c5821: `answer` API runs have `taskId:''`. Their prompt did not receive the shared C4/role packet. `buildRolePacket` without a task can fail `AMBIGUOUS_TASK` if one participant has multiple assignments; selecting a random task would leak role/task memory. `clarify.answer` was not in `DURABLE_WAKE_EVENT_TYPES`, so an applied answer had no immediate S8 event pass.

**Change A** `AGENT_RUN_CONTINUITY=true` enriches `answer` prompts with a bounded (6 KB) cycle-only server packet: task=null and role_card=null, own/common/eligible role/project memories via the established C4 visibility functions, X13-filtered questions, own checkpoint history. Source material remains untrusted. Without opt-in the previous prompt stays unchanged. No GitHub grant or task identity is inferred.

**Change B** a structurally valid `clarify.answer` (positive integer ask_seq) enters the existing event wake outbox in the **same** D1 CAS batch as the applied event. Duplicate/stale attempts cannot enqueue. HALT, lease, quotas and model rights remain unchanged. The event causes a planner pass, **not** a direct model run.

**Not yet solved**: a WorkSession parked in `waiting_for_reply` and resumed after that answer within the same run. That requires state-machine changes under D1 fencing and no retry of uncertain effects. Validate separately, then real Gemini implementation/review/continuation E2E with Grok's S9 harness; CI green alone is not parity proof.

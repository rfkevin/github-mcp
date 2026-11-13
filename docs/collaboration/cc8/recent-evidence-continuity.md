# CC8 — recent evidence and publication continuity

At 5fcf998, compaction retained only the latest full model/tool turn even for a short conversation. Earlier source pages, memory contents and the assistant's analysis disappeared after one further step. Receipts were retained, but they are not the underlying evidence. This can encourage repeated preparation after provider fallback; the live runs do not prove it is the sole cause.

The existing provider history builder now keeps a recent suffix of complete turns within 48,000 UTF-8 bytes of serialized history. It always keeps the latest whole turn, including all call/result pairs, even when that turn exceeds the target. This is a context-view target, not a run token, step or time limit. D1 history, authorization and completion checks are unchanged. Older turns still use the existing metadata checkpoint and verified milestones; pagination scalar cursors are retained there. No raw content is added to coordinator telemetry.

ANSWER calls receive a final reminder with the exact question number parsed from the original server prompt, only if store_answer is exposed. The model remains responsible for publishing through that existing tool. Text alone is not a completed mission; no answer or verdict is synthesized automatically.

Tests cover multi-page evidence across Gemini/OpenAI-compatible conversions, UTF-8 budgeting, complete pairs, oversized latest turn, steering chronology, D1 history retention across kinds and the reminder on every model call. Old compaction tests use histories large enough to genuinely exceed the view budget.

Limits: older evidence can still be condensed, model behavior and actual provider context capacities remain separate concerns, and the change does not prove successful live publication. Repeat Vibe/Gemini only after CI, independent review and deployment. No provider chain, cost policy, production deployment or automatic merge changes.

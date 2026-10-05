# CC-2 L4 — publication receipts and reconciliation

L4 adds recovery evidence around already-authorized writes. It does not create a new authority model, does not change the frozen L1 contracts, and does not infer owner transitions or merge permission.

## Durable evidence

`src/collab/receipts.ts` derives a deterministic payload fingerprint, an operation id, and a portable receipt marker. A receipt records the frozen `PublicationReceipt` fields plus target scope, payload fingerprint and per-step outcomes. The marker can be persisted inside an authorized discussion artifact; commit-based flows can carry the operation id in their existing commit trace and use the resulting immutable SHA as the receipt ref.

`src/collab/reconcile.ts` compares operation id + payload fingerprint against readback evidence. Missing evidence is deliberately **not** proof that a write did not happen, so recovery never marks an uncertain write safe to replay automatically. Duplicate claims for the same operation are conflicts.

`src/collab/publication.ts` supplies the generic publication lifecycle: prepare pending evidence, execute one step, read back when available, and return `effective` only after matching evidence. A lost/failed readback or uncertain mutation returns `unknown` + `reconcileRequired=true`.

## Required scenarios

- publish → receipt → readback: marker and fingerprint can be confirmed without a second write;
- apply an already-decided file change → actual head/receipt: the existing write coordinator remains the mutation authority; its immutable commit SHA is the publication ref and must be read back by the adapter using it;
- interrupted multi-step flow: completed steps stay recorded and later steps must not be replayed blindly;
- uncertain write result: enumerate/read back first, match operation id + fingerprint, and escalate conflicts rather than duplicate the mutation.

## G3 decision: keep composed primitives for now

The L0 baseline measured one clear model↔MCP-call saving for batching two independent reads (2 calls → 1) and declared one removed model↔MCP call as the minimum meaningful signal. For the proposed `exchange` write façade, however, L0 did **not** measure a real façade run: GitHub API request counts, latency and envelope size remained unknown, while publication/readback already works through existing write + read primitives. A façade would therefore add a second write surface before a paired implementation measurement proves a net win beyond the theoretical round-trip reduction.

Decision for this lot: **do not register `github_collab_exchange` yet**. Keep the recovery modules reusable by existing writers and let a later paired trial implement/register the façade only if it demonstrates the promised call reduction without extra GitHub traffic, larger payloads, correctness loss or duplicated authorization logic. This is a measured deferral, not a permanent rejection.

No new Cloudflare binding or storage service is introduced. Current Workers platform limits therefore do not create a new persistence dependency for this lot.

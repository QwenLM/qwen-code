# Final Tool Response Budget

## Problem

Tool output is currently shortened at several independent layers. Shell output is shortened near 30K characters and marked as truncated, generic tool output is shortened near 2K characters, and a Core scheduler batch can offload output when the aggregate exceeds the configured batch budget. These layers do not share structured state.

The scheduler treats an existing truncation marker as proof that no more work is needed. Consequently, several individually shortened Shell results can still exceed the aggregate budget. Headless mode makes the gap larger because it creates one scheduler per tool call and concatenates their responses outside those schedulers. Interactive mode similarly appends duplicate and synthetic responses after scheduler finalization. ACP, agent, and speculative execution have their own aggregation boundaries.

The model request, resumable transcript, and tool-result recording must contain the same bounded response. Rich user-facing tool display is intentionally out of scope and can continue to use the existing result display.

## Invariants

1. Every tool-response batch is finalized at the last aggregation boundary before it is sent to the model.
2. The serialized tool-output text in that batch does not exceed the configured aggregate character budget when the budget is finite and positive. The `enter_plan_mode` lifecycle reminder is policy input, not tool output, and remains inline outside this budget.
3. If a producer has already persisted output artifacts, later layers reuse those paths instead of writing the same producer output again.
4. Aggregate finalization uses structured internal metadata to decide whether persisted artifacts can be reused; it never infers that decision from human-readable text. Producer-local sentinel handling remains a compatibility detail of the existing truncators.
5. Finalization preserves response order and non-text parts. It may shorten only `functionResponse.response.output`, `functionResponse.response.error`, and top-level text parts that belong to the tool-response batch.
6. The finalized parts are also the parts recorded for replay and resume.
7. Tool display remains independent from the model response.

## Design

### Persistence metadata

`ToolResult` and `ToolCallResponseInfo` carry an internal optional `persistedOutputFiles` field.

- `undefined`: no persistence decision was made by the producer.
- `[]`: a decision was made and there is no reusable file.
- a non-empty array: producer-persisted output artifacts are available at those paths.

The field is not included in hook serialization, ACP payloads, JSON output, telemetry attributes, or persisted UI metadata. A response reconstructed by a hook does not inherit metadata unless it is explicitly copied by the runtime.

### Producer-level preview

Producer truncation controls the normal model preview and persists complete output once.

- Shell keeps the current 30K trigger but returns an approximately 4K head-and-tail preview so exit information remains visible.
- MCP keeps its current large-output trigger, retains the full transformed result for user-facing display, and uses an approximately 2K model preview.
- Generic persistence returns the actual written path for both the primary and fallback writer.

These previews are not aggregate enforcement. An already shortened response can be shortened again by finalization.

### Shared finalizer

One shared finalizer accepts responses in original order plus the configured aggregate budget. It measures all bounded text fields, then reduces text until the aggregate fits. Existing persisted paths are reused. A response without a reusable path is persisted at most once before a path reference replaces or accompanies its shortened preview.

Reduction is deterministic. A max-min water-fill allocation shares the budget across model-facing text fields while allowing small fields to keep their complete content. Reduced fields retain a small head-and-tail preview and list the available persisted artifact paths when the allocation permits. Unicode surrogate pairs are never split. The final hard-cap pass shortens text without I/O so persistence failure cannot violate the request-size invariant.

The finalizer recomputes `contentLength` from the returned parts. Infinite or disabled budgets are a no-op.

`enter_plan_mode` is the sole semantic exception. Its successful function-response output installs the active planning policy, so truncating it would change execution rules rather than shorten diagnostic output. The finalizer and last-chance send guard identify that output by tool name and exclude it from allocation; failure text and all ordinary output in the same batch remain bounded.

### Runtime boundaries

- Core scheduler finalizes before `PostToolBatch` hooks to bound hook input and again after the hook to bound hook output.
- Interactive mode merges executable, duplicate, and synthetic responses in original ordinal order, then performs the outer finalization before recording and submission.
- Headless mode collects the whole turn, including duplicate, skipped, cancelled, and executed calls, then finalizes once before recording and submission.
- ACP collects the complete tool-call turn, finalizes it before transcript recording, and returns the same parts for the next message. Immediate ACP display events remain unchanged.
- Agent runtime and speculative follow-up finalize their aggregate before emitting model-facing results or appending history.
- The chat send boundary applies a no-I/O safety cap to tool-response fields only. It should normally be a no-op and protects future callers that miss an outer aggregation boundary.

## Failure handling

Persistence failure is reported through existing logging and never prevents final truncation. The returned model response still fits the budget, but may omit a file reference if no complete output was successfully persisted. Media parts remain untouched and are not counted in this character budget.

Cancellation and hook-stop responses are finalized exactly like successful and failed tool responses. Empty output and error fields remain valid. A single response larger than the whole batch budget is reduced on its own; multiple large responses share the remaining preview capacity deterministically.

## Compatibility and non-goals

The public model-facing function response schema does not change. Existing truncation text remains readable, but aggregate finalization no longer depends on it. Existing sessions can still be replayed; only newly recorded tool results gain the stricter invariant.

This change does not add wire-byte hashes, exact token accounting, media budgeting, storage lifecycle changes, transcript migration, or a new temporary-file layout. Those are independent follow-ups.

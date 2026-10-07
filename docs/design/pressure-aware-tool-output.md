# Pressure-aware tool output and result-size accounting

[English](pressure-aware-tool-output.md) | [简体中文](pressure-aware-tool-output.zh-CN.md)

## Problem and current behavior

Issues #2566 and #11536 concern the same controllable context input. Producers, the persistence gate, per-tool/combined truncation, aggregate finalization and the send guard can each shorten a result. Execution telemetry only retains a late preview length. A 500k MCP ceiling is detached from the ordinary default, and web extraction has its own bounded input. Token counts are owned by a chat and provider route, so a shared Config getter cannot safely choose a dynamic budget.

## Changes

The ordinary default becomes 80,000 characters / 2,000 lines, as proposed in #2566. This increases early-session availability; it is a product default change, not a claim that the previous ceiling always failed. MCP uses both configured global limits instead of its independent 500k-character ceiling. Newline-heavy MCP results can reach the default 2,000-line cap before the character cap. Shell, grep, agent and self-managed paging retain their existing declared ceilings. The 200k aggregate cap remains independent.

At the serialized chat send boundary, only a fresh successful usage report for this chat, this exact route and the unchanged history prefix can anchor pressure budgeting. The available input headroom is the existing hard compaction ceiling minus the previous reported prompt/output, conservatively estimated new non-tool input and tool wrapper/media overhead. The existing new-content safety factor also scales this headroom before the character/line formulas; the budget therefore becomes useful before hard admission or compression takes over. The default character ceiling is min(80k, four times positive remaining tokens); the default line ceiling is max(500, floor(2000 times min(1, remaining tokens / 20000))). Absolute headroom avoids penalizing a large window just because its usage percentage is high. Explicit character and line settings override their corresponding defaults independently, including disabled values. An unknown window/count, restored/estimated count, changed history, foreign route, failed or abandoned response uses static budgets. Pressure adaptation complements compaction; it neither guarantees exact token admission nor changes compaction ownership.

Internal provenance is attached to top-level response Parts with an enumerable Symbol. It survives live shallow-copy/finalizer/media paths and never enters JSON, hook responses or model payloads. It carries numeric raw size, call correlation and budget source, without content, arguments, paths or hashes. Producers that shorten output report its size before shortening; ordinary producers are measured immediately after execution. Deep-cloned/restored results cannot regain a raw size from their preview and are explicitly unknown. PostToolBatch replacements inherit the original call provenance by the existing scheduler call identity.

Execution events expose raw and processed character/token estimates. A separate per-call injection event is emitted immediately before the actual content-generator invocation, from the final request after aggregate/send budgets and modality slimming. A per-chat WeakSet records each provenance once across retries and subsequent history replay. A call never submitted to the generator produces no injection event. Character counts measure textual result payloads; estimated tokens reuse compaction's Part estimator, including wrapper and media estimates. These are estimates of the submitted internal request, not provider tokenizer billing or a network-delivery acknowledgement.

Each shortening layer emits numeric input/output size, applied budget/source and its layer. Persistence additionally activates the existing persisted-result event through a logger that excludes the local output path. RUM mirrors size fields, and character/token histograms distinguish raw/injected phase with function name, tool type and truncation status. Call IDs remain log-only; histogram common session attributes continue to honor the existing opt-in cardinality control. Telemetry failure never fails a tool or model request.

## Recovery and producer policy

Full-output stubs keep existing sentinels and full-output SHA-256 labels so loop guards remain compatible. Both persistence writers include total characters/lines and an explicit read_file offset/limit hint. Valid bounded JSON receives a small shape/key/array-count/sample preview produced by JSON.parse; large or non-JSON text retains the existing directional preview. This is a recoverable sample, never a replacement for the full structured result or a schema inference engine. Parsing is bounded to avoid another large allocation for very large results.

MCP and shell spill before reducing model output. Generic and aggregate reducers persist only when no prior persistence decision exists, reuse available files, and retain the existing hard cap even when I/O fails. Web fetch's 100k extraction ceiling applies before its summarization side query, rather than being a result budget; web search has section-aware citation preservation. These semantic producer reductions remain authoritative and are documented rather than replaced by a universal string slice. Their pre-reduction size is carried separately where measurable; raw means semantic producer output before result-budget reduction, not network bytes or an entire side-query transcript.

## Affected boundaries and compatibility

Config defaults/explicitness; core scheduler conversion and post-execution/post-hook completion; shared truncation/finalization; shell/MCP/web producers; LlmChat request/usage ownership; telemetry types, OTLP/RUM loggers and histogram definitions. Interactive, headless, ACP, agents and speculation converge on the shared converter/finalizer and chat send boundary. Code-mode nested calls retain execution measurements but do not claim independent model injection when only their parent's output is submitted.

No new public setting, persisted transcript format, telemetry content collection, transport schema, storage lifecycle, exact tokenizer, or dependency is added. Existing explicit thresholds remain authoritative. Newly recorded results may be larger early in a session and smaller near context exhaustion.

## Acceptance

Focused checks cover default/explicit/disabled settings, absolute headroom, independent chats/routes, stale/estimated/restored usage fallback, string and Part[] sizes, producer pre-truncation capture, hooks, parallel finalization, structured previews, spill failure, retries and cancellation. Fresh affected-package builds/typechecks plus a controlled anonymous-provider native CLI run capture the next request and local telemetry, with actual tmux captures. Public reports state the tested source, synthetic provider boundary and unverified production telemetry backend. Issues stay open until their PR merges; no release claim is implied.

## Decisions and limitations

The larger default follows the user's authorized enhancement scope despite prior bot triage preferring to preserve 25k without a failing transcript. Reviewers can assess that change explicitly. Raw size is unknown when a producer supplies only a pre-bounded preview with no original-size metadata, including restored results; it is never silently inferred. Web extraction semantics and legitimate literal result content remain intact. Provider dispatch accounting happens once at the generator boundary; failed network delivery remains distinct from a successful provider response.

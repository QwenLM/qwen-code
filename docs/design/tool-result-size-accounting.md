# Tool result size accounting and consistent oversized-result handling

[English](tool-result-size-accounting.md) | [简体中文](tool-result-size-accounting.zh-CN.md)

## Problem and current behavior

Issue #11536: producers, the persistence gate, per-tool/combined truncation, aggregate finalization and the send guard can each shorten a result, but execution telemetry only retains a late preview length. Web extraction also has its own bounded input.

Pressure-aware budgets (#2566) are a separate change and are not part of this design. The ordinary defaults stay at 25,000 characters / 1,000 lines.

## Changes

MCP keeps its separate 500k-character ceiling (20x the global default); moving MCP onto the global limits is a product decision left out of this change. Shell, grep, agent and self-managed paging keep their declared ceilings. The 200k aggregate cap stays independent. Every producer, including MCP, now reports its pre-reduction size.

Internal provenance is attached to top-level response Parts with an enumerable Symbol. It survives live shallow-copy/finalizer/media paths and never enters JSON, hook responses or model payloads. It carries numeric raw size, call correlation, budget source and truncation status. Telemetry never emits those paths, result content, arguments or hashes. Producers that shorten output report its size before shortening; ordinary producers are measured immediately after execution. Deep-cloned/restored results cannot regain a raw size from their preview and are explicitly unknown.

Execution events expose raw and processed character/token estimates. A separate per-call injection event is emitted immediately before the actual content-generator invocation, from the final request after aggregate/send budgets and modality slimming. A per-chat WeakSet records each provenance once across retries and subsequent history replay. Constructor/setHistory/addHistory seed inherited provenance as already reported; newly executed fork results still emit their own injection events. A call never submitted to the generator produces no injection event. Character counts measure textual result payloads; estimated tokens reuse compaction's Part estimator, including wrapper and configured media estimates. Persistence measures the complete returned body, including preserved media. These are estimates of the submitted internal request, not provider tokenizer billing or a network-delivery acknowledgement.

Each shortening layer emits numeric input/output size, applied budget/source and its layer. Persistence additionally activates the existing persisted-result event through a logger that excludes the local output path. RUM mirrors size fields, and character/token histograms distinguish raw/injected phase with function name, tool type and truncation status. Call IDs remain log-only; histogram common session attributes continue to honor the existing opt-in cardinality control. Telemetry failure never fails a tool or model request.

## Recovery and producer policy

Full-output stubs keep existing sentinels and full-output SHA-256 labels so loop guards remain compatible. Both persistence writers include total characters/lines and an explicit read_file offset/limit hint. When the requested preview fits within the 2k sample budget, valid bounded JSON receives a small shape/key/array-count/sample preview produced by JSON.parse; large or non-JSON text retains the existing directional preview. This is a recoverable sample, never a replacement for the full structured result or a schema inference engine. Parsing is bounded to avoid another large allocation for very large results. Object sample metadata is outside the payload namespace, and selected keys are preserved verbatim; a sample that exceeds the preview budget falls back to the directional preview. Single-line payloads explicitly require byte-range reading or a file query to recover omitted middle values.

MCP and shell spill before reducing model output. Generic and aggregate reducers persist only when no prior persistence decision exists, reuse available files, and retain the existing hard cap even when I/O fails. Text spills use the existing per-file and session disk limits, reserve UTF-8 bytes before async writes, and roll back failed writes. Batch attribution changes only provenances whose own parts were shortened. Web fetch's 100k extraction ceiling applies before its summarization side query, rather than being a result budget; its outward oversized envelope still passes through the existing global persistence gate even when the internal page preview was already reduced. This can save an outer envelope referring to the original page file, without raising the default result budget; web search has section-aware citation preservation. These semantic producer reductions remain authoritative and are documented rather than replaced by a universal string slice. Their pre-reduction size is carried separately where measurable; raw means semantic producer output before result-budget reduction, not network bytes or an entire side-query transcript.

## Affected boundaries and compatibility

Core scheduler conversion and post-execution/post-hook completion; shared truncation/finalization; shell/MCP/web producers; the LlmChat dispatch boundary; telemetry types, OTLP/RUM loggers and histogram definitions. Interactive, headless, ACP, agents and speculation converge on the shared converter/finalizer and chat send boundary. Code-mode nested calls retain execution measurements but do not claim independent model injection when only their parent's output is submitted.

No new public setting, persisted transcript format, telemetry content collection, transport schema, storage lifecycle, exact tokenizer, or dependency is added. Existing explicit thresholds remain authoritative.

## Decisions and limitations

Raw size is unknown when a producer supplies only a pre-bounded preview with no original-size metadata, including restored results; it is never silently inferred. Web extraction semantics and legitimate literal result content remain intact. Provider dispatch accounting happens once at the generator boundary; failed network delivery remains distinct from a successful provider response.

## Correctness closeout

Inherited provenance is seeded at constructor/setHistory/addHistory, so fork and speculation-accept replays do not double-count parent calls; newly executed fork results remain observable. Batch stamps only shortened parts. Media is included in the actual returned-body measurement using the configured estimate. Text spills reserve UTF-8 bytes under existing disk limits and roll back on failure. The unused provenance file-path field is removed; response/entry artifact paths remain the recovery authority.

Web fetch retains its internal extraction/side-query input and uses global persistence for its outward oversized envelope. No 102k result override remains. A failed large-page processing fallback may preserve an outer envelope and a separate original-page pointer; it does not promise a single spill. Bounded JSON samples use external count metadata and full selected keys, falling back when too large. Single-line recovery requires a byte-range read or file query for omitted middle values.

Replacement outcomes (cancellation or hook stop) discard the replaced producer raw/budget attribution. Unknown raw size leaves truncation status unknown until an actual reducer stamps it. A persistence event requires a saved file; skip/failure is not reported as a successful spill. The fully labeled and escaped sample must fit the requested preview budget.

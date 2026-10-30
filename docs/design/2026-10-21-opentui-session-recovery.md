# OpenTUI checkpoint capture and complete restore

[简体中文](./2026-10-21-opentui-session-recovery.zh-CN.md)

## Status and dependency

This B source proposal depends on the complete replay/recovery batch [#15384](https://github.com/QwenLM/qwen-code/pull/15384) and A's complete shared restore repair. C is committed; B now integrates A's committed 83213983 source from [#15386](https://github.com/QwenLM/qwen-code/pull/15386). Clean B 6b92fc5c passed the named local session and hot/cold checkpoint suites. Its compact-summary correction and final runtime/installed/platform union still require their own verification. Exact source bindings belong in the candidate manifest and verification report. B adds the complete OpenTUI producer and consumer chain. No validated combined artifact is implied. Historical aggregate results remain in the preserved investigation and do not validate this extraction.

## Problem and delivery boundary

An edit awaiting approval must create a complete checkpoint. Restoring it must roll back the real files and UI/API history, request a legitimate fresh Read under the current owner, execute only the selected tool once, publish its actual new response under the original logical call, and preserve that branch across cold resume. Deliver creation, native capture, writer, local scheduling and hot/cold acceptance together; an unused snapshot port or writer-only change is incomplete.

This batch preserves D cancellation, prepared Retry, shell ownership and quit contracts, C replay and ordinary model-tool recording, and the current upstream native validator and CI budgets. It changes no dependency, runtime pin, default renderer or journal schema.

## Canonical capture

Keep each original replay source across fanout. For new native rows, retain canonical user, assistant, thought, image, tool, info/error/warning, compression, goal, advisor, arena, stop-hook, recap and shell fields at their event source. Do not reconstruct metadata from formatted strings. Preserve raw tool requests and final scheduler displays through the existing tool-group mapper, including mention results.

Canonical numeric IDs are distinct from host IDs. Seed allocation from restored sources so a first mapped goal/blocked event cannot overwrite restored negative identity. A repeated wire call ID in a later batch receives a distinct group/render identity. Response-end markers reset first-assistant and inline-image limits at actual response boundaries. Settle native thought duration and scheduler-rejection terminal statuses without overwriting already finalized replay metadata.

The real live-turn snapshot port excludes only transient retry/task, pending groups and incomplete native rows, then requires complete canonical sources. Zero-render replay sources remain in the snapshot. Missing canonical metadata fails capture rather than publishing a partial checkpoint. Existing viewport/fence layout is preserved; exact viewport chunk segmentation is not redesigned here.

## Compact tool-summary presentation

A successful read must retain Ink's compact `Read` summary after hot and cold restore. Reuse the existing pure summary builder and category classifier in both renderers; do not rename canonical `ReadFile` tool metadata, requests, results or journal records. Move the existing helper bodies without changing their translation, sanitization or description-count rules, and retain the existing Ink exports.

For complete contiguous canonical tool groups, derive presentation rows before viewport slicing. A group identity and its ordered calls must agree before replacing successful read/search/list rows with one summary. Preserve the original live rows and canonical source objects for snapshots, checkpoint capture and persistence. Give compact and individual presentation different measured-height identities so changing the actual detail setting cannot reuse stale geometry.

Keep individual approval, error, cancellation and image presentation. Full detail, nonempty requested arguments, user-initiated batches, pending owners, memory badges and interactive subagent/PTY groups retain their existing individual path. Reuse the actual subagent classifier; a successful parent scheduling call can still contain a nested confirmation. Native transcript presentation currently has no Ink shell-focus ports, so it must not infer focus from an unrelated field. This repair does not close active/memory/subagent layout parity elsewhere in the migration inventory.

Require tests-first single-read and same-group multi-read failures; after the fix, require one exact shared summary, negative state controls, empty versus nonempty arguments, distinct source groups reusing a call ID, immutable source snapshots, and measured frame/scroll/detail transitions. Repeat the real checkpoint test on all three renderer/runtime legs and require the same successful Read label before and after cold resume, preserving every existing approval, payload, backup and active-ancestry assertion. Global Ink baseline and exact candidate evidence remain distinct; previous 6b92 product passes do not verify the corrected source.

## Approval and writer authority

Create checkpoints only for model-origin edit requests entering real approval with checkpointing enabled. Queue the scheduler's raw tool-group source before confirmation; resume the writer after the consumer has folded those events. This avoids reading an undrained transcript. A genuinely new approval entrance replaces the capture owner; approving the existing entrance while its already captured write finishes does not invalidate that restore point.

Capture UI history, API history, prompt identities, the original logical call ID and authorized execution arguments before filesystem awaits. Preserve original model arguments in API history independently of hook or approval rewrites. Use an owned temporary file and a UUID-suffixed final name in the existing checkpoint directory. Recheck turn, session, abort and entrance ownership before publication. The short rename is synchronous so no cancellation runs between the last check and publishing a complete file. Remove unpublished temporary files. Disabled, client-origin and old callers without a snapshot port must not read checkpoint storage or write files.

## Local restore and shared authority

The real command dispatcher forwards A's restore binding and invocation identity to the shell, startup entry and live-turn scheduler. A local tool gets a fresh physical request ID, client execution origin and existing scheduler permissions/hooks. Bind that execution ID before scheduling so authorized parameter rewrites can complete against the captured original logical identity. It does not emit a new model user prompt or automatically request model HTTP. Preserve terminal UI and dual-output events, cancellation, successors and queued input.

Only a current captured binding may complete. Reuse A's legitimate scheduler Read and read-generation fences, actual chat replacement revision, session/turn/abort and recorder identity checks, one-completion admission, original logical call matching and durable branch publication. Preserve the fresh physical ID for UI/telemetry. Ordinary model/native results continue their C recording path once; local restore results use A's strict durable binding before adding actual response parts to API history.

Keep whole assistant messages and sibling calls. Replaying A must not copy discarded old success for sibling B or fabricate B execution. Cold UI uses truthful missing-result Error and explicit cancellation Canceled; the existing wire repair may report the missing sibling. New checkpoints retain the original call ID and support multiple pending calls. Legacy checkpoints without an ID require a unique same-name pending call; argument equality cannot disambiguate authorized rewrites.

## Tests and acceptance

Retain all unique D/C/A regressions, the original image/typed-file helpers and strict media oracles. Run complete affected package files for dispatcher, event adapter, model, native output/session, live-turn, shell/host, checkpoint writer and tool-history. Include real checkpoint publication, disabled/client/no-port controls, same-call approval re-entry, approval-during-write, abort/session/turn invalidation, duplicate call IDs, response boundaries, thought settlement, canceled groups and the real snapshot getter. Re-run A's shared restore, history revision, recorder/fence and Read generation consumers where the integrated interfaces change.

Normal build, full typecheck including integration, lint, formatting and a fresh whole split-dist inventory must precede product acceptance. Execute the permanent complete checkpoint test on Node+Ink, Bun+Ink and strict OpenTUI against that exact artifact. Require real HTTP/PTY, original logical and new physical IDs, OLD1 versus actual NEW2 payload, file rollback, hot snapshot immutability, cold active ancestry and backup bytes, no old-answer replay and two natural exits. Run the same-assistant double-edit control on Ink and strict: select A by actual arguments, approve A, restore both files, replay only A and inspect cold A success/B truthful Error. Cold startup clears temporary checkpoint JSON; validate surviving backups and active branch rather than requiring old temporary JSON to survive.

Preserve original failures, finite timeouts and cleanup evidence. Static syntax/apply checks are not unit, product, installed or platform acceptance. No prior aggregate green substitutes for this new combined source. Two fresh clean reviews and current-head CI remain delivery gates; installed runtime and supported-platform evidence retain their separate source scopes.

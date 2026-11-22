# OpenTUI dual-output delivery

[English](2026-10-21-opentui-dual-output.md) | [简体中文](2026-10-21-opentui-dual-output.zh-CN.md)

## Status and dependencies

**STACKED DRAFT / CURRENT VALIDATION CHECKPOINT.** This is the output half of Draft #15067 with [Vim/history](2026-10-21-opentui-vim-history.md), based on unified UI `c1f802b0c1d237d9641b8217bdc97e8d37049f51`. The reviewed source is `7a1ab30f616c5f688224b1dac1fcf0fc76e26966`; its only change from built `194bfffcdd45e19f007aa28ceeb8dfea8402f84f` is four visible-mode fixture waits with unchanged literals/12 s limits. Production and dependency inputs match; runtime tests retain the actual 194b stamp and guarded artifact, not a new 7a1 build. Recorded local validation is complete for this checkpoint: mapped source/native gates, the fresh 194b build/type/bundle, and all eight 7a1 continuation stages. The three full legs have 108 passing test rows: 106 functional passes and two retained Ink deny gaps; the overlapping strict four-case gate is separate. Prepare and the actual npm tar six-entry executable-mode check passed; neither establishes installed R3+B or audio capture acceptance. The accepted installation is reused under dependency/tool/runtime guards. Original A/v6, ba04/f93, d677, aab54, b4 and 194b failures remain immutable evidence. R3 signal changes are not copied; unified installed-artifact verification remains open and the unmerged UI dependency keeps this PR Draft. Reset still finalizes accepted output before invalidation and publishes discard only to release the composer latch, without popping queues or restoring old drafts.

The accepted A bundle (`8473becd7f80960bc28d9fbb7b0690332609bc28c94f894bb1afaab017bfaf46`) was tested using Node 24.19.0 and Bun 1.3.14. Node/Ink has five passing cases and one characterized permission gap; strict OpenTUI's first text/thought case rendered the answer but wrote only session_start/session_end. A later, separately guarded Bun/Ink reference confirms the same Esc all-denied gap (request 1 / response 0, original test FAIL retained) and active-exit 0 with a measured 302.45 ms double-CtrlC interval. Both Ink runtimes therefore have the exact deny characterization; strict OpenTUI still requires one denied response. All original failures and frozen fixture revisions are retained under the R3 investigation's U4 baseline records.

## Problem and evidence

The original OpenTUI baseline created and shut down DualOutputBridge without feeding it from the real prompt/model/tool loop. The accepted R3 npm artifact performed one model request and rendered the complete response, while `--json-file` contained only `session_start`. The same artifact under Node/Ink produced real user/assistant/stream records. The original Ink whole-case failure was a separate incorrect shared exit-code assertion (actual 0 versus expected 130); both original failures remain preserved.

This omission predates R3: its live loop, runtime and bridge match the R1 base. A constructor or a writable output file does not establish event delivery. R3's JSON-file readiness gate remains open until the complete implementation is integrated and verified in a new real artifact.

## Goal and boundary

Connect all existing output families for OpenTUI's admitted live prompt paths: prepared user content, raw assistant stream and completion, logical tool results, permission requests/decisions, cancellation, and orderly writer close. Reuse the existing bridge, adapters, permission helper, scheduler, and cleanup owner.

Do not create a new event bus, schema, configuration setting, core API, or file writer. Do not reconstruct protocol records from ANSI or transcript projections. Do not exclude `jsonFile` or silently fall back to Ink to avoid the failure. Remote `--input-file` ingestion, Goal orchestration, multiple interaction owners and duplicate-provider scheduling are separate existing live-parity gaps; output wiring does not implement those producers.

## Existing contract, including its limits

Ink emits the initial user record after prompt preparation, except for ToolResult/Goal continuations. Each actual model stream starts the assistant adapter, passes raw core events, and finalizes in `finally`. The shared adapter may create several messages as content block types change; a model hop is not necessarily one assistant message. A zero-event stream must not fabricate assistant/message_stop/result.

Normal tool completions emit genuine `tool_result` blocks using request/response IDs and the shared bounded-content/artifact projection. MOD native retries are not logical completions and must not each produce a result. Ink's secondary-owner and duplicate-provider branches have their own producers, which are not presently implemented by OpenTUI's live loop.

Logical completion and JSON content projection are distinct. Finalized MOD response parts feed model continuation, recording and the bridge once. For an ordinary successful result, the shared JSON adapter prefers a nonempty display string; an empty display falls back to finalized response parts. Error, vision and MCP display precedence remains unchanged. Finalized model parts therefore need not equal JSON display text.

Ink's main continuation-cancelled and all-tools-cancelled branches return before its ordinary `emitToolResult` call. Preserve and measure that baseline; do not add OpenTUI-only cancelled results under a parity claim. Likewise, the handshake advertises top-level `result`, but the interactive bridge has no `emitResult` producer. Track these shared advertised/actual gaps separately. The genuine `tool_result` content block remains in this delivery's required scope.

## Proposed wiring

Pass the already-created bridge from the entry to `useOpenTuiLiveTurn` and the current `livePromptEvents` invocation. Prefer a narrow type over introducing another context or writer. Every added optional field must have both a real caller and a real consumer in the same change.

Emit one initial user record from final prepared parts after @/vision acceptance, before UserQuery send. Process every raw stream event before neutral UI mapping. Finalize the owning assistant stream in `finally`, including throw and same-generation abort. Use the existing adapter rather than duplicating event transformations or usage accounting.

At logical completed-tool boundaries, emit request/response data once along the actual Ink branch policy. Reuse `buildPermissionSuggestions` and a local callId/requestId association at real scheduler transitions. Read the synchronous scheduler updates and completed calls, not React-rendered pending lists. Only a real call that leaves awaiting approval determines allowed/denied; a cleared array or vanished card must not become approval. A MOD logical scheduled placeholder has no invocation and supplies no permission decision, including ordinary denial without abort. Real native scheduled calls retain their invocation and can acknowledge approval before a hook re-ask. After abort, nonterminal updates are ignored until a real terminal call supplies the decision. Repeated asks receive distinct request/response pairs. The accepted Node/Ink and Bun/Ink Esc/all-denied references lose their response (request 1 / response 0); this batch intentionally corrects that mirror omission through the existing API and requires OpenTUI request 1 / response 1 with allowed=false. It does not alter Ink or invent a protocol.

## Input, cancellation and output ownership

Preserve U2A's structured attachments, typed @ expansion, generated input, defer policy and boolean admission. SteerInput accept/restore means core-history acceptance, not HTTP acceptance or first output. It remains responsible for queue restoration and recording. UI user echoes or restored drafts must not manufacture JSON user records. Ink currently omits the admitted steer from JSON because its continuation is ToolResult; U4 deliberately fills this omission with exactly one prepared user record in the existing carrier accept callback. Queued, restored or stale inputs emit none. This and the paired deny response are explicit improvements relative to the current Ink mirror, not claims of byte-identical output.

Preserve U2B-A's active turn identity and cancellation-settled ownership. Same-generation abort may need to finalize an already-emitted partial; a stale generation must not write to or finalize a successor's adapter state. Use the existing generation/turn ownership, without adding a generic parallel stream registry. Explicit @/vision declines retain their current consume-and-notice policy.

## Shutdown and file safety

The existing bridge closes in this order: final accepted records, session_end, deactivate writer, stream.end, close. The current OpenTUI entry unmounts before bridge shutdown, while unmount invalidates and aborts the turn. Once connected, simply gating `finally` on generation could drop the partial tail. Finalize the current adapter synchronously before reset/unmount invalidates its generation. The entry cleanup also finalizes before calling the native React root unmount, because that concurrent reconciler must not be assumed to have flushed passive effects before writer shutdown. The generator finalizes in finally only while it still owns the current generation. The shared adapter makes repeated finalization idempotent, and runtime shutdown then drains its existing writer. Late events cannot finalize a successor. No extra promise drain is needed.

Keep the existing 2-second per-cleanup and 5-second total bounds. No new unbounded drain or signal supervisor. Record timeout/cleanup failures rather than converting emergency kills into success. Do not copy R3 signal handling into this UI-based batch; verify terminal restoration after distribution integration.

Writer path/fd/FIFO, trust, permissions and failure behavior stay unchanged. JSON files use current mode/umask; no claim of universal 0600 or new path sandbox. Existing-file truncation behavior is a separate shared issue. Tests use owned 0700 roots, isolated HOME/config/cache/runtime, and never user shell rc files.

## Files and delivery size

| Area                                   | Estimated changed lines | Reason                                                    |
| -------------------------------------- | ----------------------: | --------------------------------------------------------- |
| entry                                  |                   20–45 | Existing bridge injection and cleanup connection          |
| live-turn                              |                  70–120 | Dependency forwarding, generation and current-turn settle |
| live-session                           |                 150–240 | User/raw stream/finally/tools/permissions                 |
| runtime                                |                    0–30 | Only if a small existing-owner teardown seam is necessary |
| Core, scheduler, bridge, adapters      |                       0 | Reuse unchanged behavior                                  |
| Focused and real PTY tests             |               1200–1680 | Output assertions, cancellation/ownership and lifecycle   |
| Bilingual design, matrix and discovery |                 180–270 | Complete matched requirements and evidence                |

The original output-only estimate was **1.6–2.4k changed lines**; v6 froze 1869. The combined interaction/output manifest reports the actual net size, including the retained Vim/history tests and documentation. This is one successor review batch, not two small PRs. No size target permits dropping required assertions. Any new core/scheduler dependency requires the coordinator to reconsider scope before implementation.

## Validation and acceptance

The E2E plan and formal interactive test define six PTY scenarios on Node/Ink, Bun/Ink and strict OpenTUI: text/thought, tool continuation, permission allow, all-deny, partial cancellation followed by a new prompt, and active-stream exit. Use the same actual artifact and exact binaries, with real model HTTP, JSONL, terminal output, exit and captured-process cleanup. The model server is synthetic; the CLI, tool implementation, filesystem and runtime are real. Historical global CLI checks are separate evidence and do not establish this output contract. The exact accepted A baseline is the authoritative reference; a further global dry-run is optional and must resolve the actual installed launcher/runtime before use.

Focused tests use a real bridge/adapter and owned JSONL; only the core/scheduler timing is controlled. Cover image/@ preparation and the existing adapter projection (nontext parts become JSON text), explicit declines, zero-event and core-limit events, errors, mixed tool outcomes, finalized MOD logical results, repeated asks, cleared calls, SteerInput accepted/restored, late generation and shutdown ordering. Full middleware retry execution and independent process cleanup remain separate dynamic evidence. Do not infer these paths from the six PTY cases.

The MOD projection cases check finalized parts at the actual bridge, model continuation and recording consumers before checking JSON. Both nonempty-display and empty-display variants require one logical result in order between tool use and the next assistant; neither variant changes the shared serialization contract. Preserve the original incorrect JSON-only assertion failure as test-oracle evidence, not a production fix.

Acceptance requires matching actual Ink event families/order/IDs for supported paths, no duplicates from queue/replay/retry, no stale output into a successor, one session_start/session_end on orderly termination, and no captured live product after orderly exit. Read complete flushed lines and reject malformed JSON/ANSI. The ordinary `/quit` cases and confirmed active raw-CtrlC keyboard exits must use exit 0 after the shared cleanup drain across all three profiles. Preserve the historical Ink 0/OpenTUI 130 baseline as the mismatch being corrected; actual OS-signal termination keeps its signal code. No arbitrary nonzero exit or harness cleanup qualifies as graceful exit.

The preparation fixtures are independently versioned and hash-pinned. Original R3 v2 results and manifests remain immutable. Baseline collection, implementation verification and independent review are separate evidence stages. No future commit may claim the old R3 tarball contains changed source.

## Validation checkpoint and remaining gates

1. Mapped source/native gates and the fresh 194b build/type/bundle passed. At source 7a1, strict four-case, changed-file lint/format, full Node/Ink, Bun/Ink and strict OpenTUI legs, prepare and the six-entry npm tar mode check passed (108 full-leg rows: 106 functional passes plus two Ink deny gaps). Preserve each stage's source/artifact identity; mapped earlier gates are not new 7a1 executions.
2. Keep both Ink deny cases as characterized gaps, separate from the strict paired denied response; exit 130 and cleanup HUP are not graceful exit 0.
3. Real middleware retry and accepted/restored/stale steering through actual installed keypress/HTTP/JSON remain NOT_RUN; focused carrier tests do not close those gates.
4. Integrate with R3 before closing installed JSON-file acceptance. Other platforms, runtime modes, IPC and resource gates remain separately scheduled.

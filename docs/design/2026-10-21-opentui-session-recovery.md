# OpenTUI session recovery, retry, and records

[English](2026-10-21-opentui-session-recovery.md) | [中文](2026-10-21-opentui-session-recovery.zh-CN.md)

## Status and source boundary

**Phase 5: implementation in progress; current C build, typecheck, unit/native/product validation: NOT_RUN.** The isolated `feat/opentui-session-recovery` worktree was fast-forwarded from the original `23f1cd5` planning base to `d677b8df38eb4c3fd955618d14e720ac70efa783` (tree `3c229e79e17734677323bb2ed3032e7b1fd62225`). This is the development base, not an accepted-parent claim: B's combining-character native failure remains open and must be integrated and verified before readiness. No core API, dependency, recording schema, or second history owner is introduced.

Phase 4's fixed historical reference (`~/.local/bin/qwen` 0.22.0, its private Node 22.23.2) passed H01a, H01b, and H09a once: 7 real PTYs, 7 model requests, and 7 `/quit` exits of 0. This reference is not the operator's current default global command and does not validate current C or Ink. The original failures and blocked versions remain in the ignored evidence. The canonical summary is `.qwen/investigations/session-recovery-global-outer-v6/historical-baseline-summary.json`.

Normal dependency setup on d677 passed with pinned Node 24.19/pnpm 11.24 and the shared store; it installed Husky but ran no build or tests. Its receipt is `.qwen/investigations/c-d677-setup-v1/20261021T143821Z-7fc8df-install/independent-receipt.json`. Concurrent source edits were explicitly outside that installation guard.

The source comparison is against Ink/main `a0e414945502b1d08ec969d7d3f59d6a1e96bdd7`. A read-only investigation checked 42 files against the exact source commit; 15 of 16 compared shared files match main byte for byte. The remaining AppContainer difference is the parent batch's Vim submit buffer clearing. This is source evidence, not a new runtime result. The parent interaction/output batch still has its own validation blocker; readiness must inherit its accepted successor and rebind the baseline before claiming integration.

This plan carries forward the earlier session/record/recovery/transcript proposal and all H01–H14 groups. Earlier results—including the Markdown underscore discrepancy and the same-session reset repair—remain historical evidence. They are not acceptance of this new tree. The ignored records are `.qwen/investigations/session-record-recovery-transcript-20261021/` and `.qwen/investigations/session-recovery-scope-b23f1-main-a0-v1/` in the original investigation checkout. The new executable-baseline specification is `.qwen/e2e-tests/2026-10-21-opentui-session-recovery.md` in this worktree.

## Problem and complete delivery boundary

OpenTUI already loads sessions, owns a structured composer queue, runs model/tool turns, and writes dual output. The remaining session operations do not consistently share the same prompt identity, input provenance, visible history, core history, and project input log. A user can therefore see a restored conversation while history qualification, retry, or a subsequent rewind still uses an incomplete projection.

One complete delivery will connect input recording and recall, resume/branch projection, cancellation recovery, failed-attempt retry and retry-delay skipping, real rewind, checkpoint `/restore`, and deleted-session log purging. It also retains the existing Markdown and long-transcript acceptance scope. These actions share the same session and turn owners; splitting them into one PR per key or dialog would leave partial transactions between releases.

The planned range is approximately **3,000–4,550 changed lines**, including production, focused tests, and both design languages. This is an estimate, not a quota. The narrower transaction work alone is smaller; it must not be reported as completion while `/restore`, Markdown, or long-transcript groups remain omitted. If a verified Markdown defect needs a library or renderer redesign, retain its failing evidence and bring that dependency back for a scope decision.

### Included

- One input-log write at the appropriate ordinary, slash, or shell processing point; correct recall ordering across restart and deletion.
- Prompt identity and display/source metadata through current turns, replay, branch, restore, and rewind.
- Safe no-output cancellation rollback and recovery without consuming a successor draft or stale session.
- Ctrl+Y retry-delay skipping and explicit retry of the actual failed payload through existing core behavior.
- Real selector and operation wiring for conversation/file rewind and checkpoint tool replay.
- The H13 Markdown corpus and H14 long-transcript/picker/window regression scope.

### Excluded

No new runtime, package, renderer, recording format, core API, daemon route, generic session controller, or parallel queue is planned. Node/Bun support and OpenTUI `0.5.10` remain unchanged. Existing native undo, parser ownership, permission decisions, and dual-output protocol remain intact. Background Goal/teammate retry protocols that are not current OpenTUI producers are not newly implemented here. Voice remains a follow-on consumer of the same draft/session ownership, not a microphone or ASR implementation in this batch.

## Existing owners and concrete gaps

All paths below are under `packages/cli/src/ui/` unless stated otherwise. These are the original planning-base source observations. The Phase 5 connections below are unvalidated WIP; historical calibration does not close these obligations.

| Area                | Existing producer and consumer                                                                                                                                                                                        | Smallest required connection                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft/source        | `opentui/input-submission.ts`, composer, `live-turn.ts`, and `live-session.ts` already carry model/display/submitted text, human/unknown flags, paste mappings, images, and restored drafts.                          | Preserve these fields through recovery and retry; do not invent an `InputSource` protocol or infer human input from expanded model content.                         |
| Input log           | `hooks/use-llm-stream.ts` logs before Ink slash/shell processing. OpenTUI creates `useLogger` in `start-opentui-ui.tsx`, but has no `logMessage` producer.                                                            | Pass the existing logger to the real processing owner; distinguish ordinary, command, shell, queue admission, and Retry.                                            |
| Delete              | `dialogs-misc.tsx` uses `useDeleteCommand` without its existing optional logger. The shared hook already purges successful session IDs.                                                                               | Pass the real logger through the mounted dialog; preserve partial failure, active-session refusal, and existing persistence rollback.                               |
| Resume/branch       | `session-switch.ts` already loads recovery state, swaps core, rebuilds turn boundaries, initializes, commits UI, and rolls back failures. Startup replay also exists.                                                 | Reuse that transaction; fix the replay projection rather than writing another session loader.                                                                       |
| Replay identity     | `transcript-adapter.ts` loses user prompt IDs and model-turn qualification; shared `utils/resumeHistoryUtils.ts` already projects those fields and attachments.                                                       | Reuse canonical classification/projection and retain metadata in existing neutral events. Unused `resumeUserPrompts*` helpers do not establish production coverage. |
| Slash qualification | `commands-dispatch.ts` later marks a host invocation `sentToModel`, but `opentui-host.ts` updates do not update the live row initially projected as false.                                                            | Update the same identified row and reuse its prompt ID for the generated submission. Recall eligibility remains different from model-turn/rewind eligibility.       |
| Cancel/retry        | The composer already restores structured input and protects pending successors; live-turn has a tool-start guard but lacks the full Ink no-output rollback. RetryInfo stores `skipDelay` without a keyboard consumer. | Extend the existing turn owner with only the ownership and failed-attempt facts required by the operations below.                                                   |
| Rewind              | `opentui-dialog-mount.tsx` still mounts a placeholder; the existing full selector in `session-rewind.tsx` has no production caller.                                                                                   | Mount it and reuse canonical identity mapping, file rewind, core truncation, and recording branch operations.                                                       |
| Checkpoint restore  | Shared `commands/restoreCommand.ts` restores files/history and returns a tool replay. OpenTUI host history replacement does not replace live rows, and its shell does not execute the returned `schedule_tool`.       | Connect the existing history replacement and scheduler continuation exactly once; keep this distinct from rewind.                                                   |

## Shared state and operation contracts

### Prompt identity and input provenance

Keep using `OpenTuiInputSubmission`, `OpenTuiRestoredDraft`, and their existing fields. `text`/model parts, `displayText`, `submittedPrompt`, `humanInput`, `hasUnknownInput`, paste expansions, and image ownership are different facts. Current-session cancellation preserves their structured values. Imported history and rewind drafts stay unknown where the source is unknown; expanded `@` content, system reminders, and placeholder text are not evidence of human input.

Every visible user row that represents a model turn must retain its prompt identity and qualification. Repeated equal text is not an identity key. UI-only slash invocations may belong in input recall while remaining ineligible for rewind. Current-session model-sent slash invocations retain the raw invocation for recall and the same identified turn for generated model content. Canonical shared mapping must handle compression and legacy/missing IDs; do not substitute a positional scan or text matching.

The current core slash-record writer does not populate a prompt ID on the invocation record. Reading such a field when present is compatibility support, not a completed writer contract. Cold replay of a model-sent slash can contain both its invocation and a later generated user record; H01/H02 must characterize the real current Ink journal and rewind qualification before this is considered closed. This batch does not add a core recording field or infer identity from equal text.

Preserve the parent's stable user-message projection: assistant/info deltas must not reset Ctrl+R selection when the actual user sequence is unchanged. Real user, `recallText`, `sentToModel`, or ordering changes must still invalidate that projection.

### Recording, recall, and deletion

Use the existing project logger, not a second log. Define a single write owner for each path before implementation:

| Path                                          | Planned log behavior                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ordinary prompt that starts processing        | Write display/original submitted text once at the corresponding Ink processing point.                                         |
| Handled slash or shell input                  | Write the raw input once; do not also write its generated model expansion.                                                    |
| Queued input                                  | Admission alone does not write; processing later uses its actual owner once.                                                  |
| Rejected admission, restored draft, or render | Do not write.                                                                                                                 |
| Explicit Retry or retry-delay skip            | Do not duplicate the input-log entry. JSON attempt events have a separate contract below.                                     |
| Accepted steering                             | Write accepted input once at the existing core acceptance boundary; never duplicate its JSON event or conversation recording. |

The exact slash/shell failure timing is a baseline item, not permission to drop rejected command input silently. Keep newest-first deduplication followed by chronological presentation, including promotion when a previous prompt is submitted again. Capture the logger/session associated with the operation; an old completion cannot remove a new session's latest log entry.

Accepted-steering input logging deliberately fills an Ink omission: the inspected Ink acceptance callback records the conversation but does not write the project input log. C writes only after acceptance, once per accepted entry, and invalidates the earlier prompt’s input-log rollback eligibility. Rejected, restored, and cancelled queue entries do not write. The existing accepted-user JSON and journal producers remain unchanged; this is an explicit parity exception, not a claim of identical Ink behavior.

Deletion uses the existing batch hook and logger purge. Only successfully deleted inactive session IDs are removed. Active-session refusal, mixed success, cache invalidation, restart persistence, and a failed logger write remain observable; no unconditional success or extra global subscription is introduced.

### Cancellation and reset

Follow the real Ink no-output contract: rollback is eligible only for the user row actually owned by the current attempt, with no meaningful output, no started tool, no queued/successor conflict, and the corresponding empty-draft condition. Use a synchronous meaningful-content observation, not a later React render. Text/image output is meaningful; pure thought is synthetic in the current Ink cancellation logic and must be calibrated separately.

Canonical command results retain the shared Ink synthetic classification when projected into plain info rows. Meaningful results such as `/status` carry `historyIsSynthetic: false` through live, replay, and rewind-message folding, including events without a history ID. Ordinary info keeps its existing unannotated shape and synthetic fallback. This metadata is derived from the original history item, never its text or ID, and is not a configurable option or JSON output protocol change. Cancellation preserves a meaningful result with or without a logger; ordinary synthetic notices can still roll back. The disk-log eligibility flag remains independent.

An eligible rollback removes that exact visible row, uses the existing core orphan-user cleanup, and removes the matching input-log record. Otherwise preserve completed content and recover input through the existing structured composer settlement. Retain the parent's generation guards, same-ID `kind: 'reset'` behavior, pending-image ownership, accepted steering, and successor restoration. Reset clears obsolete claims; it must not pop or restore the queue as if it were cancellation. Old `finally` callbacks cannot clear or finalize the next turn.

There are four different records: visible transcript, in-memory core history, project input log, and persistent conversation journal. The current Ink cancellation chain does not call `rewindRecording`. This plan therefore does not promise that no-output cancellation physically erases journal records. Cold-resume behavior must be characterized; a shared Ink gap requires an explicit decision, not an OpenTUI-only journal deletion. Dual-output JSON remains append-only and is not retroactively erased.

### Retry and delay skipping

Ctrl+Y first consumes a current retry-delay callback once. It neither aborts the request nor creates a new submission or user event. Reset/cancel invalidates the callback. Busy submission, pending permission, no failed attempt, and repeated key presses retain explicit outcomes rather than reaching a default retry path.

For a terminal failure, keep the prepared payload actually sent by that model/tool-result hop and its prompt ID, then use existing `SendMessageType.Retry`. Do not rerun slash expansion, read `@` files again, reconvert images, repeat accepted steering, or treat Retry as Enter/`UserQuery`. Reuse core orphan handling, file-read invalidation, turn budgets, and tool-call/result pairing. Capture the final payload after any accepted steering merge; unaccepted queued entries remain recoverable.

Follow the current model-selection behavior: an inline override is cleared back to the session model with the corresponding notice; a skill override is retained. Explicit Retry emits the existing JSON user event once per attempt, while a delay skip emits none. Keep permission and accepted-steering output at their actual decision/acceptance points; do not revert the parent's intentional deny-response and accepted-steering improvements to reproduce an Ink mirror gap.

### Resume, branch, and checkpoint restore

Resume/branch keep the current core-before-UI transaction and failure rollback. Reuse shared resumed-history projection so visible rows, attachments, prompt IDs, model-turn qualification, title/usage, and the next request refer to the same selected session. Branch creates a distinct session and leaves the original unchanged. Startup `--resume`/`--continue` and interactive resume remain separate acceptance paths. Startup converts the canonical history once, including the existing collapse policy, and shares those exact source IDs between the command host and live projection before warnings. Fresh sessions start empty; legacy records retain shared missing-ID/model-qualification fallbacks. Conversion failure follows startup's existing teardown/fallback path. New host rows must not collide with restored IDs.

Every projected host row carries its existing `historyId`; rewind truncates the source host prefix as well as the live prefix, so later `/history expand-now` cannot revive removed command output. This is source linkage, not a new history store. The inspected base has no registered `/chat save` writer, so this change does not invent one.

Collapsed restored rows retain their existing display metadata in the same live array. Only the transcript renderer filters suppressed rows; selectors and rewind boundaries retain them. Rewind and `/history expand-now` remove suppression and the summary row while preserving rich row content. Only the expand command passes the explicit `expand` mode to the existing history-load seam: OpenTUI folds a display-only event into its current live array, preserving later turns, row IDs, stream state, and queued submissions. Ordinary restore keeps replacement/reset semantics; Ink's existing full-history loader remains compatible. The existing context-files announcement latch is reconciled from startup/restored/retained rows, so restoring an announcement does not duplicate it and rewinding it away permits the next announcement. Compression retains its complete kind/status data, and boundary IDs remain indices in the original full snapshot.

Checkpoint `/restore` remains a distinct operation. When a checkpoint carries `promptId` and history, preserve the shared order: restore owned files, reject partial restoration, replace pending/history state, restore API prompt IDs, then execute the returned tool replay and continuation exactly once. Wire host history replacement to the live view without causing a second reset on resume/branch paths that already reset explicitly. Missing checkpoint files, invalid `toolCall`, and the legacy `commitHash && !promptId` format follow the existing rejection semantics. A valid toolCall-only checkpoint remains supported: it schedules the tool once without file rewind or UI/core history replacement. Do not turn absent optional history or `promptId` into a new blanket refusal.

Checkpoint late-result guards compare the existing session, idle state, cancellation signal, and source-history snapshot. Ink publishes `loadHistory` through React, whereas OpenTUI's context copies the host array; therefore the guard accepts the explicitly requested canonical row references as well as the unchanged pre-publication snapshot and this operation's own notice. A different same-session history or new turn cannot replay the old tool. Deferred real-history tests cover both publication timing and successor rejection.

### Conversation and file rewind

Connect `/rewind`, `/rollback`, and the existing empty-input double-Esc route to the real selector with their idle/dialog/IDE gates. The live transcript—not command-only host history—supplies identified current turns. Use `computeApiTruncationIndex` and `isIdentifiedRetainedTurn` before mutation; reject ambiguous or compressed identities according to the shared helpers.

Reuse the current Ink operation order when a model client is present: validate the conversation boundary, rewind files where requested, and only then truncate the permitted core/UI state and move the recording branch using `rewindRecording`. Preserve the explicit no-client split: conversation-only fails, whereas combined rewind still attempts files, keeps conversation/snapshot history, and reports that conversation rewind was skipped. Code-only rewind keeps conversation and snapshot history. Partial file failure in a combined operation prevents conversation truncation. Recording rewind re-roots existing journal ancestry; it does not delete an arbitrary suffix of JSONL. A small extraction of the existing CLI operation for both UIs is preferable to copying its validation and failure order, but no core API or broad hook refactor is planned.

The shared CLI transaction has two real consumers. Deferred file work is guarded with the existing session and current-history identity; OpenTUI reads its live refs synchronously, including before a React commit. Rewind returns the actual retained live snapshot, and each own notice returns the next real snapshot for the delayed draft-injection guard. A same-ID reset or new turn invalidates both without restoring an old draft or writing notices into the successor. Files already restored before invalidation remain an observed side effect; stale does not mean they were rolled back. UI truncation precedes conversation-recording rewind, and recording counts come from the real retained live prefix.

### Markdown and long transcripts

Keep H13 and H14. The earlier real PTY comparison lost underscores in `HELD_HEAD_1HELD_TAIL_1` under OpenTUI; that is a visible-rendering observation, not evidence that HTTP or cancellation lost bytes. Capture streaming and settled source/output stages on the new artifact before selecting a narrow fix. Include valid emphasis, code, paths, CJK, links, and tables so preserving literal underscores does not break actual Markdown.

Reuse the already merged transcript windowing and picker implementation for long resume, head/tail navigation, scrolling, resize, expanded code, and render failures. Do not copy the old original-checkout dirty patch or replace the virtualized view. If the observed renderer defect cannot be addressed without changing the locked library or architecture, keep the failed group explicit and request a scope decision.

## Implementation sequence and dependencies

1. Freeze the accepted parent successor, shared-source references, fixture data, and branch manifest. Run the global baseline first and then the current local Ink calibrations; preserve genuine failures and intentional differences.
2. Connect logger and canonical replay/host projection identity. Reuse existing mounted services and ensure every new callback/field has a real producer and reader.
3. Extend the current attempt owner for no-output rollback, prepared-payload Retry, and delay consumption. Preserve composer/native undo, queue, reset, and dual-output ownership.
4. Wire the real rewind selector and existing operations, checkpoint history replacement/tool replay, and delete purge. Add narrow shared CLI extraction only if needed to avoid duplicating the existing transaction.
5. Complete the retained Markdown/long-transcript scope based on observed failures, then run the full acceptance matrix and two clean full-diff reviews.

Likely production touch points are the existing entry/shell/composer, live-turn/live-session, event/item/replay projection, host, dialog mount/delete, and rewind wiring. Core Logger, SessionService, FileHistoryService, client history, and recording methods are consumers to reuse, not planned edits. Any need for a new core contract, recording schema, daemon route, or wholesale `useLlmStream` migration stops that expansion for maintainer review.

## Acceptance matrix

The ignored Phase 3 plan expands these stable groups into named branches. All groups are **NOT_RUN** on this tree. Baseline exceptions are reported separately from candidate passes; a skipped branch does not close its group.

| Group                              | Required behavior and counterexamples                                                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01 — Record and recall            | Ordinary/repeated input, local slash, model-sent slash, shell, restart ordering, raw text, and distinct rewind qualification.                                                                  |
| H02 — Source replay                | Images, typed `@`, accepted/restored steering, duplicate text, prompt IDs, display/model separation, and known/unknown provenance after resume.                                                |
| H03 — No-output cancel             | Actual request cancellation; exact owned row/core/log rollback; structured resubmission; pure thought/info and cold-journal characterization.                                                  |
| H04 — Content cancel and successor | Text/image/tool content retained; queued/accepted/restored inputs, pending paste/image, late callback, same-ID reset, and new-session successor isolation.                                     |
| H05 — Retry delay                  | Real RetryInfo countdown, Ctrl+Y once, reset/cancel invalidation, no extra request/user event, and busy/permission gates.                                                                      |
| H06 — Terminal retry               | Same prepared parts/prompt ID; ordinary, image/`@`, tool-result, steering, model override; repeated-key/no-failure controls.                                                                   |
| H07 — Resume                       | Interactive and startup resume/continue; visible/core context, title/usage, malformed/missing data, late callbacks, and failure rollback.                                                      |
| H08 — Branch                       | Distinct session/ancestry/title; original unchanged; failed fork cleanup and precommit rollback.                                                                                               |
| H09 — Conversation rewind          | Real command/alias/double-Esc entry; collapsed hidden turns and repeated-text identity; unknown draft; synchronous stale/new-turn/notice guards; cancel/busy/IDE/compression/ambiguity guards. |
| H10 — File rewind                  | Real tool-edited files; code-only versus combined behavior; snapshots, exact file bytes/modes, partial failure, no-client files-only behavior, and no unintended conversation truncation.      |
| H11 — Checkpoint restore           | Real checkpoint, exact history replacement and API IDs, one tool replay/continuation, valid toolCall-only support and precise missing/legacy/partial-failure rejection.                        |
| H12 — Delete                       | Inactive success and restart purge; active refusal; partial batch and persistence-failure controls.                                                                                            |
| H13 — Markdown                     | Literal underscore regression, real emphasis/code/path/CJK/link/table controls, streaming and settled frames, source bytes and render-error attribution.                                       |
| H14 — Long transcript              | Long resume and picker preview; head/tail/window/scroll/resize/expanded code; stable selection and bounded rendering.                                                                          |

The reference matrix is global `qwen` after actual launcher/runtime discovery, then the same local artifact under Node 24.19 + Ink, Bun 1.3.14 + Ink, and Bun 1.3.14 + strict OpenTUI. The historical reference version was discovered by actual execution; current C/current Ink validation has not run. Strict readiness must prove the selected renderer; absence of fallback alone is not proof of all operation contracts.

Use owned configuration/workspaces, real PTY input and model HTTP, actual logs/journal/file evidence, exact request counts and values, and fresh PID/start identities. Ordinary completion uses `/quit` and exact exit 0; raw Ctrl+C and active cancellation have separately calibrated contracts. Wait for actual protocol/exit events with bounded deadlines, not fixed sleeps or an already visible prompt. Tests run serially under the shared heavy lease with retry 0, one worker, fatal unhandled errors, first-failure preservation, and cleanup evidence.

## Risks, exceptions, and readiness

- The current parent source is a dependency, not a completed acceptance claim. Rebind after any accepted parent repair before implementation or new artifact validation.
- Ink's known deny JSON mirror gap and the parent's accepted-steering event improvement remain explicit intentional differences. Do not invent a new protocol or weaken these existing fixes for literal parity.
- No-output cancellation journal replay, retry-to-rewind identity, pure-thought timing, and command failure logging need exact current Ink calibration. This design does not declare a newly proven Ink bug.
- Linux, Windows, sandbox filesystem behavior, real microphone/permissions/audio devices, WebSocket ASR, and released-version upgrade are NOT_RUN. A macOS owned fixture or component test does not cover them.
- H13/H14 stay visible even if a renderer dependency delays delivery. No new library/version/default change is preapproved.

Ready requires the accepted parent, complete synchronized designs, global/current Ink baselines, meaningful reproduction of changed paths, normal full build/typecheck, focused owner/projection/native tests, all applicable H01–H14 branches on the three local legs, explicit disposition of exceptions, source/artifact/runtime provenance and cleanup, and two consecutive clean full-diff/consumer reviews. The implementation and final PR remain one coherent session transaction delivery. The historical dry-run and setup receipts satisfy only their named prerequisites; current C dynamic gates remain open.

### Quit presentation before teardown

The shared quit/exit result supplies the user row, duration and IDs. The OpenTUI entry projects those exact messages with a snapshot of current session statistics into the existing transcript view, replacing the ordinary application and composer. This temporary display does not append to host history, the logger, recordings, JSON output or model input. The first quit request owns one exit transition; the committed display receives the same 100 ms drain opportunity as Ink before the existing exit lifecycle runs. Unmount cancels that timer. An empty settings-restart result exits immediately without inventing a summary. Existing Ctrl+C/Ctrl+D interrupt exits and render-error exits keep their codes and cleanup paths.

Acceptance requires the actual installed strict renderer to show the goodbye title and interaction/wall-time statistics before leaving the alternate screen, then naturally exit 0 after exactly one model request. The post-exit resume echo is separate evidence. Entry tests cover supplied duration, composer replacement, recording/prompt-count resume-hint controls, repeated requests, empty restart and timer cleanup. On the previous c395 source plus candidate patch 622bcbc8d769170a9505f0441165d3315db878881ac9bc0ebd33939cfa2ecd3a, four whole-file source tests passed all 217 cases, and the original stock-status cancellation probe passed its one selected case with 66 exact cases not selected. These results cover that older source combination only. The current main/B5f916 integration has not run build, typecheck, native tests or the real installed PTY regression; all remain NOT_RUN. The original failures and their later source-level fixes remain recorded.

### Structured compression markers during replay

Canonical replay retains each compression marker as one existing compaction row with its complete token counts, estimation flags, status, kind, canonical history ID and restore display policy. Collapsed markers remain hidden but available to rewind; expanded markers use the existing compression renderer. Fast markers remain distinguishable from summarizing compression so the shared rewind mapper can exclude fast compression as an API truncation boundary. Live command info projection and the provider's contextual auto-compression notice are unchanged; replay resets the transcript rather than appending another copy. The original collapsed fast/summarize regression assertions remain unchanged. The previous c395 plus patch 622bcbc8 source-level 217-case result includes the original fast/summarize assertions and the added exact-event/identity regression. It is not a PASS for the current main/B integration. New integrated build/typecheck, native rendering and installed PTY acceptance remain NOT_RUN; both original four-file failures remain preserved.

### Bare quit and durable recall

Only exact bare quit tokens recognized by the existing normalizer bypass dispatcher USER logging, so a cold Logger recalls the latest real prompt after restart. Argument-bearing quit/exit commands, spaced slash input and unrelated help/clear/reset/new commands keep exact trimmed recall and the original post-await session guard. This is separate from transcript slash-recording exclusions. The original 1a2a all-eight-alias failure and ordinary/help positive control remain preserved; on source 1a2a703cfba99d8bfaf54ee1acf0a7e0b543411c plus patch 1272d01a2b986080d603d46b018b3884560a3c6fd40caaffac3dd51beb9a138d, the unchanged diagnostic passed both cases (90 exact cases not selected), and the two whole dispatcher/gateway files passed all 126 cases, including the 15 new filesystem regressions. Build, typecheck, native and installed PTY acceptance have not passed for this candidate; integration with R3 requires fresh source/artifact binding. The older 217-case evidence retains its previous c395/patch622b scope.

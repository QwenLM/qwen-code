# Background notification execution in Web Shell

[English](background-notification-turns.md) | [简体中文](background-notification-turns.zh-CN.md)

## Problem

Background results enter a Session queue, but their automatic execution never enters the bridge prompt lifecycle. Notifications can inherit a previous RPC prompt ID before its terminal event, later output loses its outer prompt ID, and live-state reports idle during real work. User steering can therefore be promoted into an interrupting prompt. The current user-input and stop paths also discard queued results.

## Behavior

A background subagent retains its originating execution ID and tool call ID. Its result for the currently executing turn is consumed at a safe model boundary from the same notification queue; it cannot subsequently launch a duplicate automatic turn. Results from earlier turns wait while another execution is active. Completion is visible independently from result consumption. When idle, each result starts a separate automatic execution using the shared session history.

Sending user input during an automatic execution uses the existing mid-turn queue. Input arriving at completion is consumed before the final boundary or promoted through the existing user-prompt path. Explicit stop cancels the current execution and suspends notification draining until a new user prompt; it retains pending results.

## Implementation

| Layer              | Changes                                                                                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core task registry | Capture originating prompt context at task registration and include it in terminal callback metadata.                                                                                                                                                                                   |
| ACP Session        | Consume same-execution results at safe boundaries; preserve queue ownership; retain results on cancellation; emit lifecycle identity on every automatic update; use acknowledged start admission to order the previous RPC terminal before automatic output.                            |
| ACP bridge         | Track an optional background execution descriptor (turnId, taskId, toolUseId, sourceTurnId, label, startedAt). Handle start admission/end notifications, correlate output/permissions, settle leftover mid-turn input, and include activity in snapshots and relevant operation guards. |
| SDK                | Carry background execution metadata in live/load snapshots and lifecycle events, including replay.                                                                                                                                                                                      |
| Web Shell          | Reuse existing task reconciliation and mid-turn input; append a lightweight result marker at its chronological position with source and existing task-panel links; retain the latest main-agent reply when folded, and show running state through silent tool gaps and refresh.         |

The Session owns notification consumption; the bridge owns transport execution visibility. Start admission is acknowledged only after preceding prompt terminal publication, without waiting for a queued successor prompt (which could deadlock with child history serialization). A stopped or superseded start cannot resurrect activity. End events clear only their matching execution ID. Existing Goal semantics remain compatible.

## Files and scope

Production changes are expected in core background task metadata, ACP Session and its emitters/recording, bridge client/types/runtime, SDK daemon types/normalization, and Web Shell session state/message adapters/list rendering. Tests stay collocated. No new dependencies, generalized scheduler, or new public daemon routes are planned. Existing vendor extension methods may gain a background source.

## Verification

Focused tests cover start/terminal ordering, stale end events, same-turn result consumption, no duplicate automatic execution, foreign-turn queueing, steering at tool and final boundaries, stop retention, live/load equality, permission ownership, and replay grouping. A deterministic local mock model/daemon scenario validates the actual transport and browser projection without model variability. Baseline uses global qwen, verification uses the local bundle. Build, typecheck, focused tests, full-diff self-audit, and independent review are required.

## Decisions

User messages and model execution IDs are distinct: mid-turn guidance is a real user message in the current execution. Background task activity is distinct from parent model execution; queued or still-running tasks do not alone set hasActivePrompt. Shell, monitor, and workflow notifications share the automatic lifecycle; same-execution injection is limited to subagents with origin metadata. Missing legacy origin metadata falls back to queued automatic delivery, not guessed same-turn injection. Reliable bridge restart recovery of a surviving child must use the existing load/runtime snapshot path; never infer running state solely from historical start rows.

## Conversation presentation

Automatic execution IDs remain transport lifecycle identifiers, not additional user turns. Each background result has one lightweight marker with Source and Details actions. Source locates the originating tool; Details opens the existing right-side task view. Raw subagent output stays in that view. Duplicate completion/consumption notices are suppressed, and the originating tool reflects completion while awaiting processing.

Within each user turn, folding retains the last complete main-agent reply, including replies produced during automatic execution. Earlier main replies, thoughts, and tools collapse into the existing process section. Result markers remain visible in chronological order and do not create turn navigation entries or separate turn statistics. A subsequent user message still starts a new visible turn. Missing background metadata preserves legacy rendering.

## Background task activity

Live-state also carries `hasRunningBackgroundTasks`, independently of `hasActivePrompt` and `backgroundTurn`. At least one running background task makes the field true; no tasks still executing makes it false (paused tasks do not execute; starting/pausing workflows still count). An idle parent with running children remains available for user input while the sidebar displays background activity. Missing fields from legacy daemons remain compatible. This state must come from live task ownership, not historical transcript inference.

The sidebar retains its prompt spinner at highest priority. When the parent is idle but hasRunningBackgroundTasks is true, the leading status slot shows an amber pulsing dot and a background-task tooltip; false or absent clears the marker. Hovering the background dot keeps action buttons hidden; hovering elsewhere retains the existing actions.

Live-state requests retain their local monotonic start time through the catalog and provider. Background start/end events and load snapshots record the same local clock. A response requested before the latest background observation cannot replace its state or invoke idle settlement; a later idle response still settles a background execution whose terminal event was lost, even if no active poll was observed. These timestamps stay in Web Shell and require no daemon protocol change.

## Recovery after notification transport failures

The existing active-work heartbeat repeats the last finished background execution ID. The bridge settles only a matching execution, so a lost end notification recovers without user input and stale reports cannot stop a newer execution. A successful subsequent RPC also proves that its preceding automatic execution drained; dispatch alone does not.

Admission failures retain the result and retry at 1, 2, and 4 seconds, then visibly ask for user input rather than spin indefinitely. Retries reuse the execution ID and start admission is idempotent. Explicit stop cancels retry timers; a new user prompt re-arms retained results.

SDK start markers normalize as status, not assistant text. Malformed background descriptors are ignored on load and live-state. Folding treats background markers as execution boundaries so tool-only or cancelled continuations cannot hide a previously complete main-agent reply.

## Attribution and interleaved results

Explicit background provenance wins during RPC handoff. Untagged permissions, text, mode, terminal-sequence and artifact events from an active user RPC retain that RPC's identity and originator even when an old background descriptor awaits reconciliation. Status markers split transcript text blocks, so later text cannot move ahead of the marker. SDK replay derives a missing prompt ID from validated background provenance.

A background marker captures its task result when the execution is first observed. Later output from that execution must not consume or relabel a newer completion with the same task ID. Explicit consumption notifications can still acknowledge the newer result. Regression coverage includes cancelled admission waits, foreign background admission, and task-list detail recovery when complete transcript history lacks the originating tool.

Review fixes preserve all main-answer segments separated only by passive task-completion markers when folding. Tool work and automatic-execution markers remain answer boundaries. A pending prompt cancelled before execution does not release the stop-induced notification pause. Mid-turn drains carry the actual consuming RPC/background execution ID; the bridge validates it before removing queued input and preserves it across attachment I/O. Legacy drains without the field retain their fallback. A stale background descriptor cannot discard a newer local prompt terminal, including a terminal received before HTTP acceptance; the old background terminal cannot settle that unbound local prompt.

Same-turn consumption includes any pending queue-overflow summary before the retained results, records it, and preserves the combined input on cancellation. A display failure does not discard the model input. Web Shell only deduplicates notifications with a task ID, so independent queue-loss diagnostics remain visible. Background admission checks the worktree-reset barrier before and after waiting for the preceding terminal; a surviving old session cannot start automatic work after ownership transfer.

During an RPC/background handoff, cancellation and the shared steering queue belong to the active RPC. A background-only execution can still drain steering and claim Todo Stop Guard continuation under its admitted ID. Non-daemon ACP hosts report unsupported admission methods with JSON-RPC method-not-found, preserving the existing legacy fallback. Background status prose is excluded from answer collectors; automatic terminal events do not finish another consumer's main prompt. Web Shell buffers early terminals until prompt acceptance identifies their owner, and ignores stale terminals only for execution settlement, retaining their transcript errors.

When a same-session load snapshot clears a background execution, Web Shell retains its finished ID so replayed start events cannot revive it.

# Speculation tool step — keep its own (PR 6b decision)

[English](2026-11-15-speculation-tool-step.md) | [简体中文](2026-11-15-speculation-tool-step.zh-CN.md)

- **Status**: decision recorded for #17045 block "Speculation PR 6b": speculation keeps its own tool step and its own speculative loop; only its model round runs on the shared loop (PR 6a, #17029). No code change and no setting in this slice.
- **Date**: 2026-11-15. Line citations verified on `main` `5f5035772b54`.
- **Source of the behavior**: `packages/core/src/followup/speculation.ts` (847 lines).
- **Related**: [Unified agent loop](2026-10-23-unified-agent-loop.md) (#15327); [Event-bus agent loop](2026-11-11-event-bus-agent-loop.md); tracking issue #17045; the Hosted Harness evaluation ([2026-11-14](2026-11-14-hosted-harness-loop-evaluation.md)) is the analogous "keep its own" decision for the Hosted tool step.

## The question

#17045 asks speculation's PR 6b to put "the tool step and the run on the shared loop, or a recorded decision to keep its own". PR 6a (#17029) already moved speculation's model round onto `runModelRound`. This decision covers the tool step and the surrounding speculative loop.

## What the code actually requires (verified)

Speculation runs ahead of the user in the background with read-only tools and copy-on-write overlay writes, and its tool step is built around that:

1. **Direct execution, bypassing the scheduler.** Each call is run through `tool.build(args)` and `invocation.execute(signal)` directly (`speculation.ts:456-517`), not through `CoreToolScheduler`. Permission-deferred calls bail to the normal flow instead (`:410-414`).
2. **Overlay writes, not the real filesystem.** A `redirect` gate rewrites path arguments into the overlay (`rewritePathArgs`, `:446-454`); the overlay is copied to the real filesystem only on accept, and discarded on reject.
3. **A boundary gate that bails mid-batch.** `evaluateToolCall` returns `boundary` / `redirect` / proceed; a boundary (or a failed rewrite, or a guard denial) stops the speculative run at that call and hands back to the normal loop (`:433-454`, `:497-509`). The hand-back is a **partial batch**: the already-executed responses are kept and the unexecuted calls are stripped, keeping the first N `functionCall` parts by order to match the responses (`:609-657`).
4. **No committed recording.** Speculation finalizes responses (`finalizeToolResponses`, `:605`) but never records them as committed tool calls; its results are speculative and must not enter the committed tool-call history.
5. **Sequential with early bail.** Calls are processed one at a time and the run stops at the first boundary.

### What the shared batch interface already allows

The execution and recording mechanics above are **not** structural blockers of the shared interface, and neither are partial results. `runToolBatch` takes a caller-provided `executor` (`agent-loop.ts:476`), so a speculative executor could run calls directly and sequentially; `client` is optional (`:467`) and the recording call is `client?.recordCompletedToolCall(...)` (`:671`), so omitting it skips that channel; and `deferRecording` (`:488`) returns each result's recording as a callback instead of invoking it (`:755-759`), so a surface records only what it sends. Three further seams bear on the boundary/partial-batch behavior (this list is not exhaustive): `keepCancelledResults` (`:483`) finishes and returns a cancelled batch's results for a surface that keeps them; `ToolBatchResult.responses` (`:498`) returns the parts by call "for a surface that drops some calls' results", which a live surface already uses to send only a subset (`use-llm-stream.ts:6707-6711`); and the per-call launch gate `host.beforeToolLaunch` (`:221`, wired at `:630`) refuses a call in request order and leaves it unexecuted. Direct execution, sequential execution, avoiding committed recording, partial results and per-call refusal are all expressible through this interface; they do not, by themselves, justify keeping a separate tool step.

## Decision

**Keep speculation's own tool step and speculative loop — because the adapter that composes the shared seams into speculation's hand-back is not worthwhile for a background optimization, not because the shared interface cannot express the mechanics.** The seams above express direct, sequential, unrecorded execution and partial results. The mechanical difference is in the default output: the batch answers every executable call it did not run with a `skipped` response in `parts` (`agent-loop.ts:687`), whereas speculation's hand-back strips the unexecuted `functionCall` parts out of the model message itself (`speculation.ts:609-657`). A surface reconciles this by building its next round from `responses` rather than `parts` — `use-llm-stream.ts:6707-6711` already drops a subset that way — so the strip is a composition the surface writes, not a capability the batch lacks. On top of that composition speculation still needs its overlay accept/reject (the overlay is copied to the real filesystem or discarded as a whole) and its surrounding speculative loop. Composing and maintaining that speculative adapter against a working, tested tool step is the cost this decision declines for a background optimization. This is the same shape as the Hosted Harness decision: the model round is shared, the specialized tool step stays.

The model round stays on the shared loop as PR 6a landed it (`runSpeculationModelRound`, gated by `isUnifiedAgentLoopEnabled('speculation')`); the tool gate, direct execution, overlay writes and boundary handling are unchanged.

**End-state note.** Keeping speculation's own loop and finalizer permanently means the parent design's end-state targets of 1 agent loop implementation and 1 `finalizeToolResponses` caller are not literally reachable: speculation's call (`speculation.ts:605`) remains alongside the shared batch's (`agent-loop.ts:709`). Those two targets count the shared implementation plus the copies the keep-its-own decisions retain, as the End state table in [unified agent loop](2026-10-23-unified-agent-loop.md) now notes; #17045 reconciles the exact numbers.

**Numbering note.** The tracker #17045's "PR 6b" is this tool-step decision. It supersedes the older [unified agent loop](2026-10-23-unified-agent-loop.md) migration table's "6b" numbering, which named speculation's default-on and removal step; that table now links this decision and keeps default-on/removal as a separate entry. The table's "6c" is this doc's own label for those default-on/removal steps; in #17045 they are the unnumbered "On by default" and "Legacy path removed" checkboxes after 6a/6b, so "6c" has no separate tracker entry. The tracker's "Kernel on by default, if PR 6b put its run on `runAgentLoop`" box is moot under this decision (speculation keeps its own run, so the kernel never runs its rounds); that box, and the 11-18 dated row "PR 6b merged, with speculation's integration scenario" — which this record's unit-parity gate decision replaces — are owed a Plan-changes reconciliation in #17045. Default-on and legacy removal remain gated steps of #17045, not part of this decision.

## Integration gate decision

No integration test runs speculation today. **Recorded decision: speculation's unit parity suite is its gate.** The suite already compares the shared round off and on (`speculation.test.ts`, "speculation model round on the shared agent loop" and "speculation shared-round event semantics"), including a branch marker pinning that the shared round runs only with the setting on. A deterministic end-to-end speculative round is not a practical integration gate: speculation is a background, timing-dependent optimization whose accept/boundary outcome depends on user input arriving mid-run. The unit parity suite, not an integration scenario, gates the shared-round migration. The off/on comparison covers the shared model round; the boundary hand-back is speculation's own unchanged tool step, exercised by the boundary tests on the raw-chunk arm. The composition of the shared round's parts with that boundary strip is not yet covered on the shared arm — a coverage item to close before the 6c default flip, not a gap this decision introduces.

This gates the shared-round migration (PR 6a), not PR 6c's default flip. The parent design's integration entry ("that run is added when its default flip is prepared") and its default-change criterion that the scheduled job running the surface's integration suite with the setting on has passed on main for two weeks ([unified agent loop](2026-10-23-unified-agent-loop.md)), and #17045's 14-consecutive-night rule, still stand for 6c. Since a deterministic end-to-end speculative round is impractical for the timing reasons above, the 6c author must reconcile that requirement: name a nightly integration signal that satisfies it, or record through #17045's Plan changes that the unit parity suite suffices for the default flip too. This record leaves that question to 6c rather than preempting it.

## Scope

- In: this decision record (tool step keeps its own; unit parity suite is the gate).
- Out: any code change; speculation's default flip and legacy removal remain the gated steps of #17045.

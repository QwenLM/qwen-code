# Speculation tool step — keep its own (PR 6b decision)

[English](2026-11-15-speculation-tool-step.md) | [简体中文](2026-11-15-speculation-tool-step.zh-CN.md)

- **Status**: decision recorded for #17045 block "Speculation PR 6b": speculation keeps its own tool step and its own speculative loop; only its model round runs on the shared loop (PR 6a, #17029). No code change and no setting in this slice.
- **Date**: 2026-11-15. Line citations verified on `main` `5f5035772b54`.
- **Source of the behavior**: `packages/core/src/followup/speculation.ts` (848 lines).
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

The execution and recording mechanics above are **not** structural blockers of the shared interface. `runToolBatch` takes a caller-provided `executor` (`agent-loop.ts:476`), so a speculative executor could run calls directly and sequentially; `client` is optional (`:467`) and the recording call is `client?.recordCompletedToolCall(...)` (`:671`), so omitting it skips that channel; and `deferRecording` (`:488`) returns each result's recording as a callback instead of invoking it (`:755-759`), so a surface records only what it sends. Direct execution, sequential execution and avoiding committed recording are all expressible through this interface; they do not, by themselves, justify keeping a separate tool step.

## Decision

**Keep speculation's own tool step and speculative loop — because of the boundary/partial-batch and overlay accept/reject semantics, not the execution or recording mechanics.** The mismatch is that speculation stops at the first boundary mid-batch and hands back a partial batch (executed responses kept, unexecuted calls stripped), with overlay writes that are accepted or discarded as a whole. The shared batch settles a whole batch and has no bail-at-a-boundary / partial-hand-back contract; expressing speculation's mid-batch bail and accept/reject on top of it would need a speculative adapter whose cost is not worthwhile for a background optimization. This is the same shape as the Hosted Harness decision: the model round is shared, the specialized tool step stays.

The model round stays on the shared loop as PR 6a landed it (`runSpeculationModelRound`, gated by `isUnifiedAgentLoopEnabled('speculation')`); the tool gate, direct execution, overlay writes and boundary handling are unchanged.

**Numbering note.** The tracker #17045's "PR 6b" is this tool-step decision. It supersedes the older [unified agent loop](2026-10-23-unified-agent-loop.md) migration table's "6b" numbering, which named speculation's default-on and removal step; that table now links this decision and keeps default-on/removal as a separate entry. Default-on and legacy removal remain gated steps of #17045, not part of this decision.

## Integration gate decision

No integration test runs speculation today. **Recorded decision: speculation's unit parity suite is its gate.** The suite already compares the shared round off and on (`speculation.test.ts`, "speculation model round on the shared agent loop" and "speculation shared-round event semantics"), including a branch marker pinning that the shared round runs only with the setting on. A deterministic end-to-end speculative round is not a practical integration gate: speculation is a background, timing-dependent optimization whose accept/boundary outcome depends on user input arriving mid-run. The unit parity suite, not an integration scenario, gates the shared-round migration.

## Scope

- In: this decision record (tool step keeps its own; unit parity suite is the gate).
- Out: any code change; speculation's default flip and legacy removal remain the gated steps of #17045.

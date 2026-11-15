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

1. **Direct execution, bypassing the scheduler.** Each call is run through `tool.build(args)` and `invocation.execute(signal)` directly (`speculation.ts:456-517`), not through `CoreToolScheduler`. The point is to run read-only work ahead without the scheduler's approval/scheduling path; permission-deferred calls bail to the normal flow instead (`:410-414`).
2. **Overlay writes, not the real filesystem.** A `redirect` gate rewrites path arguments into the overlay (`rewritePathArgs`, `:446-454`); the overlay is copied to the real filesystem only on accept. The shared batch executes against the real filesystem.
3. **A boundary gate that bails.** `evaluateToolCall` returns `boundary` / `redirect` / proceed; a boundary (or a failed rewrite, or a guard denial) stops the speculative run and hands back to the normal loop (`:433-454`, `:497-509`). The shared batch has no bail-to-normal-flow concept.
4. **No committed recording.** Speculation finalizes responses (`finalizeToolResponses`, `:605`) but never calls `recordCompletedToolCall`; its results are speculative and must not enter the committed tool-call history. The shared `runToolBatch` records each executed call (`agent-loop.ts:671`).
5. **Sequential with early bail, not a parallel batch.** Calls are processed one at a time and the run stops at the first boundary; the shared batch schedules concurrency-safe calls in parallel and settles the whole batch.

## Decision

**Keep speculation's own tool step and speculative loop.** The shared `runToolBatch` cannot express direct execution, overlay writes, the boundary bail, or the absence of committed recording without either polluting `packages/core` with speculation-specific behavior or weakening the speculative model. This is the same shape as the Hosted Harness decision: the model round is shared, the specialized tool step stays.

The model round stays on the shared loop as PR 6a landed it (`runSpeculationModelRound`, gated by `isUnifiedAgentLoopEnabled('speculation')`); the tool gate, direct execution, overlay writes and boundary handling are unchanged.

## Integration gate decision

No integration test runs speculation today. **Recorded decision: speculation's unit parity suite is its gate.** The suite already compares the shared round off and on (`speculation.test.ts`, "speculation model round on the shared agent loop" and "speculation shared-round event semantics"), including a branch marker pinning that the shared round runs only with the setting on. A deterministic end-to-end speculative round is not a practical integration gate: speculation is a background, timing-dependent optimization whose accept/boundary outcome depends on user input arriving mid-run. The unit parity suite, not an integration scenario, gates the shared-round migration.

## Scope

- In: this decision record (tool step keeps its own; unit parity suite is the gate).
- Out: any code change; speculation's default flip and legacy removal remain the gated steps of #17045.

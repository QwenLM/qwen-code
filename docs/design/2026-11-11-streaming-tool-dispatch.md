# Streaming tool dispatch — evaluation and design

[English](2026-11-11-streaming-tool-dispatch.md) | [简体中文](2026-11-11-streaming-tool-dispatch.zh-CN.md)

- **Status**: evaluation complete; recommendation below. This is the third slice of the [event-bus agent loop](2026-11-11-event-bus-agent-loop.md) port (PR 1 #16935 merged, PR 2 #16938 merged). It is the "evaluate and decide" slice that design named; it records the parity differences and the implementation design, and makes the call on whether/when to implement.
- **Date**: 2026-11-11. Line citations verified on `feat/event-bus-handlers` (PR 2 #16938, atop `origin/main` `1fe1f197781c`).
- **Source of the behavior**: `v1.0.0-preview` `587e3429cabf`, `event-bus/llm/inference-round.ts`, `event-bus/tool-handler.ts`, `tool-executor/`.

## The behavior difference

Main runs a model round to completion, collects its tool calls, then runs them as one batch (`runAgentLoop` → `runModelRound` → `runToolBatch`). Preview dispatches each `tool_use` block to the tool executor **while the model stream is still running** (`inference-round.ts` publishes `llm.tool_use` per block; `tool-handler.ts` executes on that event and settles on `llm.settled`). The win is latency: a tool starts before the model finishes emitting the rest of its response.

## What the code actually requires (verified)

Streaming dispatch is not "schedule earlier". Three facts from the current tree shape the work:

1. **The executor interfaces differ in shape.** Main's `AgentLoopToolExecutor.run(requests, signal, hooks)` (`core/agent-loop.ts:163`) is batch-shaped: `createSchedulerExecutor` (`:623`) builds one `CoreToolScheduler` and calls `schedule(requests, …)` with the whole batch, resolving on `onAllToolCallsComplete`. Preview's `ToolExecutor` is streaming-shaped: `execute(block)` per call, `waitForExecutions(batch)`, `stopExecution(batch)`. A streaming path needs a new executor adapter, not a flag on the existing one.

2. **`CoreToolScheduler` can be scheduled incrementally, but its completion signal is idle-based.** `schedule` (`coreToolScheduler.ts:3090`) queues a request when the scheduler is running and drains the queue when idle. So calls can be fed in one at a time. But `onAllToolCallsComplete` fires whenever the scheduler goes idle with everything settled — which happens between streamed calls. A streaming executor must therefore track dispatched-vs-settled call ids itself and only resolve a round once the round has settled **and** every dispatched call is terminal; it cannot rely on `onAllToolCallsComplete` alone.

3. **`runToolBatch` is more than execution.** It does duplicate/replay suppression, surface selection, the launch hook, ordered results, `finalizeToolResponses`, and recording with Goal provenance (`core/agent-loop.ts:361`). A streaming path must reproduce all of this incrementally — preview does it in a separate streaming tool-executor and `completeToolExecutions`, not by calling the batch function. Reusing `runToolBatch` as-is is incompatible with mid-stream dispatch.

## Parity differences a streaming path introduces

| Concern                          | Batch (today)                                                                                                                                                           | Streaming                                                                                                                       | Consequence                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approval timing                  | the whole batch is approved before any call launches                                                                                                                    | each call is approved as it arrives mid-stream                                                                                  | a denial lands earlier and affects later streamed calls differently; surfaces that approve per batch must adapt                                                                |
| Retry / fallback                 | `Retry`/`ModelFallback` discards collected calls **before** any execution                                                                                               | calls dispatched before the retry have already run                                                                              | executed tools cannot be un-run; preview keeps them (`dispatchedToolUseBlocks`), main's discard contract no longer holds                                                       |
| Output interleaving              | model stream finishes, then tool output                                                                                                                                 | tool output interleaves with the remaining model stream                                                                         | UI ordering changes; the equivalence harness's ordered callback log would differ by design                                                                                     |
| Duplicate / replay               | batch-level dedup before scheduling                                                                                                                                     | per-call dedup as dispatched                                                                                                    | the dedup window shrinks; replay bookkeeping must move to dispatch time                                                                                                        |
| Plan-mode sibling skip           | the whole batch is checked: every sibling of an `enter_plan_mode` call (including earlier ones) is skipped                                                              | a later entry may arrive after an earlier call already ran, which cannot be undone                                              | per-dispatch enforcement cannot preserve the contract; needs conservative buffering or an explicit relaxation                                                                  |
| Structured-output selection      | headless `selectCalls` reads the whole batch: when a `structured_output` call is present, only those calls run and every other call (including earlier ones) is skipped | a later `structured_output` may arrive after an earlier call already ran, which cannot be undone                                | same shape as plan-mode: per-dispatch cannot preserve it; needs conservative buffering or an explicit relaxation                                                               |
| Batch-level hook / output budget | `PostToolBatch` fires once per batch with that batch's completed calls                                                                                                  | per-dispatch would fire it per call (`[A]`, `[B]` instead of `[A, B]`), changing count-sensitive hook output and stop decisions | defer the batch-level hook/budget/recording to round settlement and apply it to the round's completed calls as one batch, or list split-batch as an additional semantic change |

These are not bugs to fix; they are the semantics of streaming. The retry row is the load-bearing one: it changes a correctness contract (discard-on-retry) that main's surfaces and tests rely on.

## Implementation design (when implemented)

- A `StreamingToolExecutor` adapter wrapping one `CoreToolScheduler` per round: `dispatch(call)` schedules incrementally and records the call id; `onToolCallsUpdate` is progress only. `settle()` resolves only when every dispatched call has passed the **final completion** stage (`onAllToolCallsComplete`-equivalent: resource release, `PostToolBatch` hook, output budget and recording), not merely when its status is terminal. `cancel()` aborts the round signal and stops queued calls.
- It reproduces `runToolBatch`'s dedup/selection/launch-hook/finalize/record incrementally (the preview `completeToolExecutions` equivalent), and the batch-level `PostToolBatch` hook, output budget and recording are applied **once at settle to the round's completed calls as one batch** (not per dispatch), so batch-scoped hook semantics are preserved and results and recording match the batch path for the non-retry case **excluding plan-mode and structured_output batches**.
- `runModelRound` gains an additive optional `onToolCall` callback (existing callers unaffected); the Llm handler publishes `llm.tool_call` per collected call when streaming is on; the Tool handler dispatches on `llm.tool_call` and settles on `llm.settled`. **Conversation cannot stay unchanged**: it must track dispatched calls and wait for their final settlement instead of finishing on `model.stop` or on an empty call list — otherwise a retry that clears the collected calls would finish the loop while dispatched tools are still running and their results would be lost. It also owns how the streaming path handles the original `tool.request`.
- A `streamingToolDispatch` option, effective only with `useEventBus`, default off. The four currently-unemitted bus events (`llm.tool_call`, `tool.cancel`, `loop.output`, `loop.cancelled`) gain their emission points here.
- Retry-after-dispatch follows preview: dispatched calls keep their results; the discard-on-retry contract is explicitly relaxed for the streaming path and documented per surface.

## Recommendation (the call)

**Do not implement streaming dispatch in this slice. Land this evaluation, and implement streaming as a separate opt-in experimental slice after the unified-loop surfaces converge.** Reasoning, grounded in the code above:

- The architecture port (PR 1 + PR 2) delivers the event-bus loop and stands on its own; streaming is an optional latency optimization, not a prerequisite.
- Streaming changes a correctness contract (discard-on-retry) and approval timing. Landing it now — while only headless and part of ACP are on the shared loop and the equivalence harness covers only those — would lock in semantics before the parity harness covers the surfaces that actually depend on the batch contract (Ink, OpenTUI, AgentCore, Hosted).
- The executor adapter plus the incremental re-implementation of `runToolBatch`'s finalize/dedup/record is a substantial, correctness-sensitive change; it deserves its own slice with the full parity harness, not a prototype bundled into the architecture port.

When implemented, it ships behind `streamingToolDispatch` (default off), with the retry-after-dispatch relaxation documented and an equivalence test that asserts result parity for the non-retry case **excluding plan-mode and structured_output batches** (whose batch-wide selection boundaries conservative buffering must preserve), and explicitly pins the changed retry/approval semantics, the batch-scoped `PostToolBatch` hook/budget scope (applied once at settle to the round's completed calls), and the dispatched→retry→no-new-calls and terminal-with-running-tools settlement paths.

## Decision points (for the maintainer enabling it later)

1. Accept the retry-after-dispatch relaxation (executed tools survive a retry) for the streaming path?
2. Accept per-call mid-stream approval timing, and adapt the surfaces that approve per batch?
3. Confirm the latency win justifies the added executor complexity once the parity harness covers all surfaces?

## Scope

- In: this evaluation, the parity-difference record, the implementation design, the recommendation.
- Out (deferred to the implementation slice): the `StreamingToolExecutor`, the `onToolCall` emission, the `streamingToolDispatch` flag, and the streaming equivalence tests.

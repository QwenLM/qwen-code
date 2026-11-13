# Streaming tool dispatch — evaluation and design

[English](2026-11-11-streaming-tool-dispatch.md) | [简体中文](2026-11-11-streaming-tool-dispatch.zh-CN.md)

- **Status**: decided 2026-11-13: not implemented in #17045; the implementation moves to its follow-up issue with the design below. This is the third slice of the [event-bus agent loop](2026-11-11-event-bus-agent-loop.md) port (PR 1 #16935 merged, PR 2 #16938 merged). It records the parity differences, the decisions and the design for the follow-up, and keeps the recommendation of 2026-11-11 to defer.
- **Date**: 2026-11-11, decisions 2026-11-13. Line citations verified on `main` `0207b03518`.
- **Source of the behavior**: `v1.0.0-preview` `587e3429cabf`, `event-bus/llm/inference-round.ts`, `event-bus/tool-handler.ts`, `tool-executor/`.

## The behavior difference

Main runs a model round to completion, collects its tool calls, then runs them as one batch (`runAgentLoop` → `runModelRound` → `runToolBatch`). Preview dispatches each `tool_use` block to the tool executor **while the model stream is still running** (`inference-round.ts` publishes `llm.tool_use` per block; `tool-handler.ts` executes on that event and settles on `llm.settled`). The win is latency: a tool starts before the model finishes emitting the rest of its response.

## What the code actually requires (verified)

Streaming dispatch is not "schedule earlier". Three facts from the current tree shape the work:

1. **The executor interfaces differ in shape.** Main's `AgentLoopToolExecutor.run(requests, signal, hooks)` (`core/agent-loop.ts:241`) is batch-shaped: `createSchedulerExecutor` (`:798`) builds one `CoreToolScheduler` and calls `schedule(requests, …)` with the whole batch, resolving on `onAllToolCallsComplete`. Preview's `ToolExecutor` is streaming-shaped: `execute(block)` per call, `waitForExecutions(batch)`, `stopExecution(batch)`. A streaming path needs a new executor adapter, not a flag on the existing one.

2. **`CoreToolScheduler` can be scheduled incrementally, but its completion signal is idle-based.** `schedule` (`coreToolScheduler.ts:3094`) queues a request when the scheduler is running and drains the queue when idle. So calls can be fed in one at a time. But `onAllToolCallsComplete` fires whenever the scheduler goes idle with everything settled — which happens between streamed calls. A streaming executor must therefore track dispatched-vs-settled call ids itself and only resolve a round once the round has settled **and** every dispatched call is terminal; it cannot rely on `onAllToolCallsComplete` alone.

3. **`runToolBatch` is more than execution.** It does duplicate/replay suppression, surface selection, the launch hook, ordered results, `finalizeToolResponses`, and recording with Goal provenance (`core/agent-loop.ts:503`). A streaming path must reproduce all of this incrementally — preview does it in a separate streaming tool-executor and `completeToolExecutions`, not by calling the batch function. Reusing `runToolBatch` as-is is incompatible with mid-stream dispatch.

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

These are not bugs to fix; they are the semantics of streaming. The retry row is the load-bearing one: it changes a correctness contract (discard-on-retry) that main's surfaces and tests rely on. The design below, kept for the follow-up issue, avoids each row for the calls it would start early.

## Decisions (2026-11-13)

On 2026-11-13 #17045 took streaming dispatch on as block S, narrowed to read-only calls that need no approval. Checked against main, that narrowed form saves almost no time, so it is not implemented in #17045. The implementation moves to the follow-up issue with the design below. Three findings decided it:

- **Calls reach the loop late on the main provider path.** The chat-completions protocol has no event that ends one tool call: calls arrive as deltas keyed by `index`, and only the response's `finish_reason` reliably ends them. Main's converter therefore emits a response's tool calls when `finish_reason` arrives (`openaiContentGenerator/converter.ts:2058`). Taking the next `index` as the end of the previous call is not safe, because the parser also handles providers that interleave or reuse indexes. 1.0 does the same: its chat-completions factory closes tool blocks only at `finish_reason`, so 1.0 dispatches nothing early on this path either. The Qwen and Bailian presets and the parity suites' fake server use it. The Messages and Responses protocols end each call with its own event (`content_block_stop`, `response.output_item.done`), and that is where 1.0's early dispatch comes from; its Qoder provider uses Responses. Main's Anthropic, Responses API and Gemini generators also emit each call as it completes, but even there only the calls before a response's last one can start early.
- **The calls that may run early are the fast ones.** Read and search tools and read-only shell commands mostly finish well within a second. The slow tools, such as agents, fetches that ask, and commands that write, are excluded.
- **A dropped early run is not invisible.** A read records the file in the file-read cache, which a later edit's check for a prior read consults, and every run is written to the tool-call log.

The evaluation's three decision points, as the follow-up takes them:

1. **Retry.** The discard contract stays. Main retries inside the chat layer: an abandoned attempt's calls never reach history, and the retried attempt emits its calls again, so a result kept from the abandoned attempt has no call to pair with. On `Retry` or `ModelFallback` a call that started early is cancelled if it is still running and its result is dropped, as the batch path drops the abandoned attempt's calls today.
2. **Approval.** No approval is asked during the stream. Only a call that needs none starts early; every other call waits for the batch after the response, as today.
3. **Latency against complexity.** Not justified for the narrowed form on main today. It is worth revisiting for a provider path that ends each call during the stream, or for calls that need approval or write.

## Design (for the follow-up)

**Which calls start early.** The leading calls of a response, in stream order, up to the first call that is not eligible. No later call of the round starts early, because the batch would run it after a call that may write. A call is eligible when:

- it reads only: a read, search or fetch tool, or a shell command the scheduler's read-only check accepts; agents are excluded even though the scheduler runs them in parallel;
- the tool's default permission and the permission rules allow it without asking; this check calls no model;
- no hook on tool events (PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest) and no Mod tool check is registered, since these can ask, deny or replace a call's input and are visible when they fire;
- it is not a replay or a repeated id.

**The batch takes the results.** Early calls run through the surface's executor as they arrive. At the round's end the batch runs as today: duplicates, `selectCalls`, `beforeToolLaunch` per call in order, results and recording. When the batch would launch a call that started early, it takes that call's result, waiting for it if it is still running, and runs only the calls that did not start early. When the batch would not launch it (a sibling of `enter_plan_mode`, a call that `structured_output` displaces, a launch the host refuses, the `--max-tool-calls` budget), the early result is dropped and the call is handled as today. A dropped run costs its time and leaves the effects noted above. Results reach `onToolResult` after the round ends, in the batch's order, so host callbacks are the same with the setting off and on. A call's live output is not forwarded while it runs early; it arrives with the result.

**Events.** With the setting on, the Llm handler publishes `llm.tool_call` for each call as the stream delivers it, and the Tool handler starts the eligible ones. `tool.request` still carries the round's calls at its end and runs the batch. `tool.cancel` is published when an attempt is abandoned (`Retry`, `ModelFallback`) or the request fails while calls that started early are running, and the Tool handler cancels them.

**Settlement and cancellation.** Each attempt's early calls run under a signal derived from the run's tool signal, so a retry cancels only that attempt's calls and an abort cancels them all. A run does not finish while an early call is still running: when the round ends without a batch that takes the call (no calls left after a retry, a failed request, a stop), the call is cancelled and the run waits for it, as it waits for a batch tool today. After an abort, the 10 s cap on a cancelled run (block K, #17145) bounds that wait.

**Surfaces.** Headless and AgentCore pass their executor when they call `runAgentLoop`, so their rounds could dispatch during the stream. The Ink TUI and OpenTUI hand their scheduler over only in `onRoundEnd`, and ACP runs its round and batch separately; they would first need to hand the executor over when the round starts.

**Setting.** `experimental.streamingToolDispatch`, default off, read only on the kernel (`experimental.eventBusAgentLoop`). Tests compare it off and on and pin the eligible prefix, a retry while an early call runs, a call the batch does not launch, and an abort while an early call runs.

## Recommendation of 2026-11-11

The decisions of 2026-11-13 keep this call: **do not implement streaming dispatch in this slice. Land this evaluation, and implement streaming as a separate opt-in experimental slice after the unified-loop surfaces converge.** Reasoning, grounded in the code above:

- The architecture port (PR 1 + PR 2) delivers the event-bus loop and stands on its own; streaming is an optional latency optimization, not a prerequisite.
- Streaming changes a correctness contract (discard-on-retry) and approval timing. Landing it now — while only headless and part of ACP are on the shared loop and the equivalence harness covers only those — would lock in semantics before the parity harness covers the surfaces that actually depend on the batch contract (Ink, OpenTUI, AgentCore, Hosted).
- The executor adapter plus the incremental re-implementation of `runToolBatch`'s finalize/dedup/record is a substantial, correctness-sensitive change; it deserves its own slice with the full parity harness, not a prototype bundled into the architecture port.

The design above keeps both contracts, retry still discards and approval still happens per batch, and has the batch take the early results instead of re-implementing `runToolBatch` incrementally.

## Scope

- In: this evaluation, the parity-difference record, the decisions and the design for the follow-up.
- Out (the follow-up issue): the implementation, the setting and its tests.

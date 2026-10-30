# Unified agent loop

[English](2026-10-23-unified-agent-loop.md) | [简体中文](2026-10-23-unified-agent-loop.zh-CN.md)

- **Status**: accepted in #15343. PR 1 (headless) merged in #15369. PR 2a (the model round of ACP prompt turns) is in review in #15509.
- **Date**: 2026-10-23, against upstream `779a4d5d0d`.
- **Related**:
  - tracking issue #15327;
  - the earlier proposal #8775, which starts with AgentCore and headless; this design extends its goal to all seven loops, and its AgentCore step is PR 5;
  - defects found while comparing the loops: #15324, #15325, #15326;
  - [loop protection setting](2026-10-21-loop-protection-setting.md).

## Problem

The agent loop is the cycle that sends a prompt, streams the reply, runs the requested tools, sends their results back, and repeats until the model stops calling tools. Qwen Code has seven implementations of it, one or more per surface.

`LlmClient.sendMessageStream` runs one model request plus the continuations it owns: the Stop hook, steering at a model boundary and the next-speaker check. It never runs tools. Every surface therefore writes its own "run the tools, send the results, repeat" part, and three of them skip `LlmClient` altogether.

The copies have drifted apart. #15324, #15325 and #15326 are behavior bugs found only by comparing them, and #14114, #12209, #12020, #8542, #13851 and #12113 come from the same split. Every new loop-level behavior has to be wired into each copy. For example, the loop-protection reminders had to be injected separately in `client.ts`, `agent-core.ts` and `Session.ts`, and Mod tool checks reach only three of the seven loops.

## Current behavior

### Layers

| Layer       | File                                 | Owns                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LlmChat`   | `packages/core/src/core/llm-chat.ts` | provider request, retries, model fallback, max-tokens escalation and output recovery, auto-compaction, history                                                                                                                              |
| `Turn`      | `packages/core/src/core/turn.ts`     | turns one model call's raw chunks into typed events (`Content`, `Thought`, `ToolCallRequest`, `Retry`, `ModelFallback`, `Finished`…); marks a call's arguments as truncated (`wasOutputTruncated`) or incomplete (`hadIncompleteArguments`) |
| `LlmClient` | `packages/core/src/core/client.ts`   | one interaction step: UserPromptSubmit, Goal admission, reminders, IDE context, loop detection, the session turn cap, then the Stop hook, steering and next-speaker continuations                                                           |
| surface     | below                                | everything after the model stops with tool calls                                                                                                                                                                                            |

### Loops

| Surface                                                              | Loop                                                                                                                   | Model call                                   | Tool execution                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Ink TUI                                                              | `packages/cli/src/ui/hooks/use-llm-stream.ts`                                                                          | `LlmClient`                                  | `InteractiveModToolScheduler` over `CoreToolScheduler`; the completion callback calls `submitQuery(ToolResult)` |
| OpenTUI                                                              | `packages/cli/src/ui/opentui/live-session.ts`                                                                          | `LlmClient`                                  | a new `InteractiveModToolScheduler` per batch                                                                   |
| Headless `-p`, stream-json SDK transport                             | `packages/cli/src/nonInteractiveCli.ts`, with a second copy in the drain turn (`:2888-3066`)                           | `LlmClient`                                  | `executeToolCall` per call, with its own partitioning, in-flight cap and ordered finalize                       |
| ACP: Zed, VS Code companion, `qwen serve` / Web Shell, channels      | `packages/cli/src/acp-integration/session/Session.ts`, four loop bodies (main, Stop continuation, cron, notifications) | `LlmChat` directly                           | its own executor, `runToolCalls` / `runTool`                                                                    |
| Hosted Harness                                                       | `packages/cli/src/serve/hosted-harness-model.ts:828-1143`                                                              | `LlmClient`, but fires 13 hook events itself | journaled sequential dispatch (`hosted-workspace-tool-turn.ts`)                                                 |
| Subagents, background and forked agents, workflows, in-process teams | `packages/core/src/agents/runtime/agent-core.ts`                                                                       | `LlmChat` directly, parsing chunks itself    | one `CoreToolScheduler` per round                                                                               |
| Speculation                                                          | `packages/core/src/followup/speculation.ts`                                                                            | `LlmChat` directly                           | runs tools directly, without the scheduler                                                                      |

Not loops, and out of this design: the forked-agent cache path (one request, no tools), the Omni fixed-policy orchestrator (no model call), and the ACP bridge, SDK and channel packages (transports).

### Where the copies differ

- **Session turn cap.**
  - `LlmClient` stops at `max > 0 && count > max` (`client.ts:4529-4531`).
  - Headless stops at `max >= 0 && count > max` (`nonInteractiveCli.ts:663`) with its own per-invocation counter.
  - The Hosted Harness stops at `max > 0 && round >= max` (`hosted-harness-model.ts:841`).
  - ACP has no cap.

  #15325 is the result: a stream-json message past the cap returns success with the previous answer.

- **Duplicate provider tool calls.** The suppression is assembled four times (`nonInteractiveCli.ts:1962`, `use-llm-stream.ts:3236`, `Session.ts:14096`, `agent-core.ts:2085`), and the key falls back three different ways.
- **Concurrency.**
  - The cap is implemented four times (`coreToolScheduler.ts:5486`, `nonInteractiveCli.ts:2264`, `Session.ts:14375` and `:17041`).
  - The scheduler runs every concurrency-safe call in parallel; ACP parallelizes only consecutive Agent calls.
- **Retry and fallback.** Ink and headless drop the tool calls collected before a `Retry` or `ModelFallback`; OpenTUI does not (#15326).
- **Partial edits.** The scheduler refuses an Edit call whose arguments were cut off or arrived incomplete; ACP's executor does not (#15324).
- **Recording.**
  - `finalizeToolResponses` is called separately in six loops, and once more inside the scheduler.
  - OpenTUI records native tool results only when a Mod was involved (#15326).
- **Hooks and Mods.**
  - ACP re-implements UserPromptSubmit, the Stop hook and MessageDisplay.
  - The Hosted Harness fires them itself and sends a Stop continuation as `ToolResult` where `LlmClient` sends `Hook`.
  - Mod tool checks reach Ink, OpenTUI and headless only.
- **Missing on ACP.** ACP has no next-speaker check, no session turn cap, no content loop heuristics and no late MCP/skill reminders (#14114).

## Goals and scope

Goals:

- One implementation of the loop in `packages/core`: model round, tool batch, continuation, and a typed outcome. Every surface uses it.
- An opt-in rollout behind one setting. With the setting off, every surface keeps its current loop unchanged.
- A surface moves only when a parity suite shows that its requests and output match its current loop, apart from listed differences.
- One place to attach loop-level behavior such as hooks, Mods, loop protection, recording and telemetry.

Out of scope for this round:

- session-level scheduling, i.e. when notifications, cron jobs, Goal turns and teammate messages start a loop — each surface keeps its own;
- the Hosted Harness, which is evaluated separately after the other surfaces;
- `LlmChat` and the provider layer;
- `CoreToolScheduler` internals beyond the hooks the loop needs;
- UI rendering and wire protocols;
- changing a surface's default before it meets the conditions in [Migration](#migration).

## Design

### Layering

```text
Surfaces: Ink · OpenTUI · headless/SDK · ACP · AgentCore · speculation
   │  input, event sink, scheduler wiring, mid-turn input, surface policies
   ▼
Shared agent loop (packages/core)
   model round : LlmClient.sendMessageStream for a main session;
                 Turn over the agent's own LlmChat for subagents and speculation
   tool batch  : duplicate handling → scheduling → ordered results
   continuation: finalizeToolResponses → recording → mid-turn input → ToolResult
   outcome     : a typed stop reason
   ▼
LlmClient → Turn → LlmChat (unchanged)
```

The loop is an async function. Every model event reaches the surface unchanged through a callback, so the existing surface adapters keep working, and tool results and live tool output reach it the same way. Decisions the surface owns are callbacks too. The loop returns a result whose stop reason the surface maps to its own outcome.

### Model round

1. The loop asks the surface for the round's send options. Examples: the send type, a model override, first-round fields such as `humanInput`, and Goal fields.
2. It calls the model round and forwards every event to the surface in order.
   - It collects `ToolCallRequest` events.
   - On `Retry` or `ModelFallback` it drops the calls collected so far and tells the surface, which resets its partial output.
3. The client's terminal events become stop reasons, so a surface can no longer drop them: `MaxSessionTurns`, `SessionTokenLimitExceeded`, `UserPromptSubmitBlocked`, `LoopDetected` and `Error`.
4. When the round ends with no tool calls, the loop stops with `completed`. The Stop hook, steering and next-speaker continuations have already run inside `LlmClient`.

The main-session round is `LlmClient.sendMessageStream`. AgentCore and speculation need a round over their own `LlmChat`. PR 5 adds that round on `Turn`, so chunk parsing exists only in `turn.ts`. The interface between the loop and its round appears in that PR, when it gets its second implementation.

### Tool batch

1. **Duplicates.** A call that repeats a call id is not run again. Provider replays get the duplicate response, and a repeated provider id stops the loop with `duplicate_provider_call`. This uses the existing helpers in `turn.ts` and `toolCallIdUtils.ts`.
2. **Selection.** The surface may restrict which calls run (headless structured output). Every call that does not run still gets a response.
3. **Scheduling.** The whole batch is scheduled on one scheduler.
   - The default is `CoreToolScheduler`. It already provides partitioning by concurrency safety, the in-flight cap, approvals, hooks, the partial-edit guard, Mod tool checks and runtime views. It also skips the sibling calls of a plan-mode entry; headless does that itself today only because it schedules one call at a time.
   - Tools run under the surface's tool signal, which may differ from the loop's own: headless adds a Goal turn's signal for tools only.
   - The surface supplies the scheduler options it owns today: the approval wiring, progress output and the full-turn model callback.
   - A surface whose Mods have tool hooks passes the Mod-aware scheduler it uses today, with the same `schedule` contract, so Mod behavior does not change: Ink and OpenTUI use `InteractiveModToolScheduler`, headless a per-call Mod runner.
4. **Launch hook.** One new `CoreToolScheduler` option, `beforeToolLaunch(call)`, runs serially in request order before each launch. In a concurrent batch it runs for every call that fits in flight before any of them starts, so a refusal takes effect before the other calls of that run begin, as in headless today. Returning `false` leaves the call unexecuted. Calls that an `exec` script makes are not asked; legacy headless does not count them either. The loop offers every call of the batch to the surface once, in request order; a call the scheduler settled without launching it (invalid arguments, a denial) is offered at its turn. Headless needs it for:
   - the exact `--max-tool-calls` count, which ticks before each launch and counts failed calls too;
   - "the first valid `structured_output` ends the session".
5. **Results at batch end.** Results reach the surface when the batch completes, in request order: replays first, then executed calls, skipped calls and repeated ids. Waiting for the batch lets the scheduler apply batch-level hook output and the batch output budget first, so the surface reports exactly what the model receives. Live tool output still streams as it happens.

### Continuation

1. All responses of the batch go through `finalizeToolResponses` once, and each result is recorded once. Recording carries the Goal provenance, and `recordCompletedToolCall` runs for each call.
2. The surface may add input taken at the tool boundary after the results:
   - headless merges teammate messages and sends the turn as `Teammate`;
   - later, Ink drains its message queue and ACP calls `craft/drainMidTurnQueue`.
3. A result with `terminateTurn` stops the loop with `tool_ended_turn`; the surface finishes its Goal turn.
4. Otherwise the loop sends the parts as the next round, typed `ToolResult`.

### Outcome

The result holds the stop reason, the number of rounds and the last `Turn`. The stop reasons are:

- `completed`;
- `next_round` — `maxRounds` was reached; the result carries the tool results to send;
- `cancelled` — the loop's own signal was aborted; a cancel that comes only from a signal the client merged in, such as a Goal turn's, ends the round as if the model made no calls, as headless does today;
- `loop_detected`;
- `duplicate_provider_call`;
- `tool_ended_turn`;
- `surface_ended` — a callback ended the loop, e.g. a structured-output success;
- `max_session_turns`;
- `session_token_limit`;
- `user_prompt_blocked`;
- `error`.

The surface maps the reason. Headless maps it to exit codes and results; ACP later to `stopReason`; AgentCore to `terminateMode`.

Headless runs its main loop with `maxRounds: 1`. Its preparation of each round (teammate messages, the turn cap, the send type) therefore stays where it is today, and the loop owns the round itself. A drain item runs all of its rounds in one call.

### Surface policies

Behavior that only some surfaces have is passed in as a policy instead of copying the loop. Examples:

- the `--max-tool-calls` ticker;
- structured output;
- model-override precedence;
- teammate merging;
- and later, the daemon tool-loop guards and the Todo stop guard.

A policy affects only the surface that passes it.

### Send options a host owns

Some surfaces did part of the interaction step themselves before they moved, and keep doing it on the shared path for a while. A send option then tells the client not to do that part, so it does not run twice. Each such option is a transition step, not a lasting API: it is listed here with the step that removes it or turns it into an input.

| Option                   | Why the host keeps the part                                                                                                                                                                                                                                                                                                          | Removed by                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolLoopGuardsByHost`   | ACP's tool step runs the daemon tool-loop guards: the per-turn tool-call cap, repeated calls, the exploration reminder and the repeated-tool-failure guard                                                                                                                                                                           | PR 2b for a fresh prompt's tool batches: the client's guards apply, and ACP keeps the ones only it has, its parameter-error, partial-edit and repeated-tool-failure stops, as its policy. A session with live tools and an Agent Host session keep ACP's tool step and this option until PR 2d |
| `interactionSpanByHost`  | ACP's span is parented to the daemon's trace                                                                                                                                                                                                                                                                                         | an input instead: the client joins the span the host started for the prompt; before the default changes for ACP                                                                                                                                                                                |
| `userTurnRecordedByHost` | ACP records the prompt as typed, with its display text, attachments, resource links and daemon prompt id, before slash commands run, and takes the turn's file-history snapshot before its first send, so a prompt cancelled before it is sent still has one; on a retry, a continue or a restore it has started the todo work chain | an input instead: the host passes that record and the client writes it; before the default changes for ACP                                                                                                                                                                                     |

`toolCallPreparations`, `memoryRecallQuery`, `stopPolicies` and `historyPromptId` are not in the table: the first asks for an extra event, the second gives recall the prompt's text, which the host expanded before the send, the third adds the host's reasons to continue at a stop point ([Stop-point continuations](#stop-point-continuations)), and the fourth gives a `Retry` the history identity of the attempt it replaces; none turns anything off. PR 2c-1 removed `stopHookRunByHost`, with which ACP fired the Stop hook in its own Stop loop.

A new option that turns off part of the client's work for one host needs a row here, and a surface's default does not change while it has an open row.

### Stop-point continuations

When a response ends without tool calls, `LlmClient` decides whether the turn continues: steering, the Stop hook and the next-speaker check. Ink, OpenTUI and headless rely on that chain as it is. Before PR 2c-1, ACP continued at the same point for more reasons, in a Stop loop of its own that also fired the Stop hook: the Todo Stop Guard, the background results of the current turn, and input that arrived mid-turn.

The stop point is one step of the loop: the Stop hook runs first, and checks that only some surfaces have run in order after it, only once it lets the response stop. Each can continue the turn with a message or let it end. Queued input and background task notifications are taken in after a tool batch; at a stop point they do not continue the turn, and the next turn picks them up. One owner then decides whether a turn continues, and a surface adds its own reasons without a second loop around the client.

So the client's chain takes ordered surface stop policies (`SendMessageOptions.stopPolicies`):

- once the Stop hook lets the response stop, or when none is configured, the chain asks each policy in order;
- a policy returns the request to continue with, and the chain sends it as it sends a Stop-hook continuation (`Hook`, under the turn's prompt id, with its own tool budget), or returns nothing and the next policy is asked;
- when the Stop hook's blocking cap ends the turn, the policies are told (`onStopHookCap`) and not asked.

ACP passes one policy, the Todo Stop Guard. The current turn's background results and input queued mid-turn are no longer continued at a stop point: ACP takes them at a tool boundary as before, and otherwise they start the next turn, a background-notification turn or the host's next prompt. The other surfaces pass no policy and do not change.

### The setting

`experimental.unifiedAgentLoop` is a boolean, `false` by default, and takes effect after a restart. `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP=1` overrides it, which lets CI and scripts run the suites with the shared loop. Both follow the pattern of `experimental.agentTeam` / `QWEN_CODE_ENABLE_AGENT_TEAM`.

`Config.isUnifiedAgentLoopEnabled()` exposes it. Each surface reads it at its loop's entry point:

```ts
if (config.isUnifiedAgentLoopEnabled()) {
  return runOnSharedLoop(...);
}
// current loop, unchanged
```

The current loop stays as the `else` branch and is not refactored while the setting exists. A surface that has not moved yet ignores the setting, and the setting's description names the surfaces it covers. ACP children started by `qwen serve` read the same settings, so the daemon and Web Shell follow the setting for the ACP turns that have moved. The Web Shell settings panel lists the setting from PR 2a on.

Once surfaces change their defaults one at a time, the setting has no schema default. `Config.isUnifiedAgentLoopEnabled(surface)` returns the setting when it is set, and otherwise the surface's own default. The environment variable still overrides both.

### Headless on the shared loop (PR 1)

| Headless today                                                                     | With the setting on                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `while (true)` round loop, plus a second copy in `drainBatch`                      | one loop call per interaction; each drain item is another call with its own send type                       |
| `limitedTurnCount` gate (exit 53)                                                  | unchanged; the client's `MaxSessionTurns` now ends the run the same way instead of a false success (#15325) |
| `discardAbandonedAttempt` on `Retry` / `ModelFallback`                             | the loop drops the calls; the surface restarts its attempt and writes the retry frame                       |
| `processToolCallBatch` duplicate and replay handling                               | the loop                                                                                                    |
| `structured_output` pre-scan and first-success end                                 | surface policy: call selection plus a result callback that ends the loop                                    |
| plan-mode-entry sibling skip                                                       | the scheduler, for the whole batch; the per-call Mod runner does it itself                                  |
| `executeToolCall` per call, `partitionHeadlessToolCalls`, the in-flight cap        | one scheduler per round, with the same partitioning and cap                                                 |
| tick before launch                                                                 | `beforeToolLaunch`                                                                                          |
| approvals: stream-json `can_use_tool`, one call at a time                          | the same callback, for the whole batch before it runs                                                       |
| Mods with tool hooks run serially                                                  | the per-call Mod runner as the batch scheduler                                                              |
| ordered finalize, `finalizeToolResponses`, `recordToolResult` with Goal provenance | the loop                                                                                                    |
| model-override precedence (inline `/model` > full-turn vision > `\0` sentinel)     | surface policy                                                                                              |
| teammate text merged into the tool-result turn                                     | input at the tool boundary, sent as `Teammate`                                                              |
| Goal `terminateTurn`                                                               | stop reason `tool_ended_turn`                                                                               |
| `LoopDetected` → exit 1; a repeated duplicate id → loop-detected result            | stop reasons `loop_detected`, `duplicate_provider_call`                                                     |
| abort → `routeAbort` (55 / 130)                                                    | stop reason `cancelled`; the surface still routes the abort                                                 |
| idle phase: next Goal, teammates, cron, background holdback, memory, final result  | unchanged, outside the loop                                                                                 |

### ACP prompt turns on the shared round (PR 2a)

PR 2 moves ACP in steps. PR 2a moves the model round of a fresh user prompt: one that is not a retry, a continue or a restore, and not a Goal, channel or goal-proposal approval turn (PR 2c-2 moves the last five). The round is the loop's own `runModelRound`: one `LlmClient.sendMessageStream` call whose events go to ACP and whose terminal events become stop reasons. ACP keeps its tool step (`runToolCalls`, the next message after tools, the daemon tool-loop guards) and everything around the turn. PR 2b moves the tool batch of these turns onto the scheduler, and PR 2c-1 their stop point onto the client's chain. PRs 2c-2 to 2c-4 then move the other turns, so each of ACP's loop bodies changes once.

| ACP today                                                                                         | With the setting on                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.sendMessageStream` behind `#sendMessageStreamWithAutoCompression`                           | `LlmClient.sendMessageStream` through `runModelRound`: the first round is `UserQuery`, a round after tools is `ToolResult`, and input taken while a response streamed is `Steer`                                      |
| raw chunks: text, thought, usage, function calls, tool-call preparations                          | the client's events: `Content`, `Thought` with its raw `text`, the usage on `Finished`, `ToolCallRequest` with the `functionCall` it came from, `ToolCallPreparation`                                                 |
| UserPromptSubmit through the message bus                                                          | `admitUserPrompt`, with the same input at the same point; the first round applies the verdict, and a blocked prompt is reported by that round without a request                                                       |
| the user message record, the todo work chain and the file-history snapshot                        | ACP's, as today; the first round says so with `userTurnRecordedByHost`                                                                                                                                                |
| memory recall, plan, arena and output-style reminders, workflow intent, MessageDisplay            | the client                                                                                                                                                                                                            |
| compaction before the send and its notice; the session token gate                                 | the client's compaction inside the send, with the same notice on `ChatCompressed`; the client's gate, reported as today (`max_tokens`)                                                                                |
| the external Stop hook, its cap and its continuation                                              | ACP's Stop loop, as today, which also runs the Todo Stop Guard and the current turn's background results; the round told the client with `stopHookRunByHost` until PR 2c-1 moved the stop point to the client's chain |
| the StopFailure hook and the 429 mapping when a request fails                                     | ACP, as today, also for a stream `Error` event, with the error the provider threw                                                                                                                                     |
| the managed memory tasks after the turn                                                           | ACP, when the turn ends as today, through the client's `runManagedAutoMemoryBackgroundTasks`; until PR 2c-1 the client skipped them under `stopHookRunByHost`, since ACP's Stop loop could still continue the turn    |
| the interaction span                                                                              | ACP's, as today; the round tells the client with `interactionSpanByHost`                                                                                                                                              |
| the daemon tool-loop guards: the per-turn tool-call cap, repeated calls, the exploration reminder | ACP's, as today; the round tells the client with `toolLoopGuardsByHost`, so the client checks no tool-call patterns and adds neither the exploration reminder nor the todo reminder ACP's message carries             |
| no content or thought loop heuristics, no session turn cap                                        | the client's content and thought heuristics when `model.skipLoopDetection` is false, whose `LoopDetected` rejects the prompt as a loop (`LOOP_DETECTED`); `MaxSessionTurns` ends it with `max_turn_requests`          |

The core changes of this step are additive and change nothing for a caller that does not use them:

- `Turn` gives `Thought` the chunk's raw `text` and `ToolCallRequest` the `functionCall` it was built from, and yields `ToolCallPreparation` for a call the model started streaming when the send asks for it with `toolCallPreparations`;
- `SendMessageOptions.userTurnRecordedByHost`, `stopHookRunByHost`, `interactionSpanByHost` and `toolLoopGuardsByHost`, and the loop detector's `toolCallPatterns` check option;
- `SendMessageOptions.memoryRecallQuery`, what a `UserQuery`'s memory recall searches for in place of the request;
- `getStructuredErrorCause` returns the error a `Turn` `Error` event was built from;
- `admitUserPrompt` takes the hook's `submitted_prompt` and a signal;
- `runModelRound` is exported.

### ACP tool batches on the shared batch (PR 2b)

PR 2b moves the tool batch of the turns PR 2a moved. The batch is the loop's own `runToolBatch` on one `CoreToolScheduler`: duplicates and replays, scheduling, results in request order, `finalizeToolResponses` and recording. ACP keeps the loop around it: the next request after tools, mid-turn input and background results, and, until PR 2c-1, the Stop loop.

ACP's part is a translation of the scheduler's state changes:

| ACP's executor today                                                                                                                                                                                            | With the setting on                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runToolCalls` / `runTool`: its own lookup, validation, the partial-edit guard, PreToolUse, PermissionRequest, the permission flow, AUTO mode, plan-mode shell rules, PostToolUse, image handling and telemetry | the scheduler's                                                                                                                                                                                     |
| only consecutive Agent calls run concurrently                                                                                                                                                                   | the scheduler's partitioning: every concurrency-safe call (Read, Search, Fetch, read-only shell, Agent) runs concurrently, under the same in-flight cap                                             |
| a permission request when a call reaches its turn                                                                                                                                                               | `session/request_permission` for each call the scheduler holds in `awaiting_approval`, through ACP's permission queue, before any call of the batch runs; the answer goes to the call's `onConfirm` |
| a declined or failed request stops the turn after the call; the batch's later calls are skipped                                                                                                                 | the same stop; the batch's other calls are cancelled before they run                                                                                                                                |
| `tool_call` start, lifecycle, shell heartbeat, subagent and result updates from inside `runTool`                                                                                                                | the same updates from the scheduler's callbacks: the start when a call launches, the result when it settles, an error update for a call refused before it ran                                       |
| the per-turn tool-call cap, repeated calls and the exploration reminder                                                                                                                                         | the client's, which no longer gets `toolLoopGuardsByHost`                                                                                                                                           |
| the parameter-error and partial-edit stops, counted per turn, and the repeated-tool-failure guard                                                                                                               | ACP's, from the batch's results                                                                                                                                                                     |
| Goal-approval ownership, the standalone worktree limits                                                                                                                                                         | ACP's, through the scheduler's `refuseToolCall`                                                                                                                                                     |
| the PermissionPrompt Notification hook's terminal sequence                                                                                                                                                      | the scheduler's hook; ACP forwards the sequence it reports                                                                                                                                          |
| a Managed session's batch close, the memory refresh after a memory write                                                                                                                                        | ACP's, after the batch                                                                                                                                                                              |

A session with live tools, which ACP trusts without the permission flow, and a read-only Agent Host session, which refuses approvals, keep ACP's executor and `toolLoopGuardsByHost` until PR 2d.

The core changes of this step are additive:

- `runToolBatch` is exported, with `keepCancelledResults`: a batch the loop's signal cancelled is still finished, recorded and returned, since ACP keeps a cancelled turn's results in history;
- `CoreToolScheduler` options `refuseToolCall`, the owner's own refusal of a call before it is built, and `onPermissionPromptTerminalSequence`.

### ACP's stop point on the client's chain (PR 2c-1)

PR 2c-1 moves the stop point of the turns PR 2a moved onto the client's chain. ACP keeps its Stop loop only for the turns that have not moved.

| ACP's Stop loop today                                                                                            | With the setting on                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP fires the Stop hook, with its cap and its continuation under a `_stop_hook_N` prompt id                      | the client's Stop hook and cap; the continuation is a `Hook` send under the turn's prompt id; ACP shows the hook's system message and, from the second block on, the Stop-hook loop update    |
| the Todo Stop Guard, merged into the hook's continuation when both apply                                         | a stop policy, asked once the Stop hook lets the response stop; it claims the continuation from the host, yields to a queued prompt, and stops after its attempts                             |
| the current turn's background results continue the prompt (`_background_result_N`)                               | not continued at the stop point; they start a background-notification turn                                                                                                                    |
| with the guard armed, input queued mid-turn is drained at the stop point and continues the prompt                | not drained at the stop point; the host sends it as its next prompt, and the guard yields to it                                                                                               |
| input that arrives while the Stop hook runs discards its decision                                                | the hook's decision stands                                                                                                                                                                    |
| after a guard continuation's tools, the next request needs another guard attempt, or the results are kept unsent | the tool results are sent back as after any batch, and the guard decides at the next stop point                                                                                               |
| each continuation streams through ACP's legacy send path and runs ACP's tool step                                | the client's round and the shared tool batch, as for the rest of the turn                                                                                                                     |
| ACP runs the managed memory tasks after its Stop loop                                                            | the client runs them when the turn's last response stops on its own; ACP runs them when the turn ends otherwise, such as at the Stop-hook cap, on a Steer round or a tool that ended the turn |

The client keeps a host's span, tool-guard and stop-policy options on a Stop-hook continuation, so it neither starts a span of its own nor turns its guards on for the continuation's tools. ACP resets its own tool-guard state for each Stop-hook or Todo Stop Guard continuation, including when Live tools retain ACP's tool executor. Tool-result requests within a continuation keep that budget.

Hook diagnostics do not reopen a finished response's interruption window. Each new model request starts a new final-answer capture; a diagnostic with no following request keeps the preceding answer.

The core change of this step adds `SendMessageOptions.stopPolicies` with the `StopPolicy` interface and removes `stopHookRunByHost`, which only ACP passed.

### ACP turns that re-enter a prompt, and channel and Goal-proposal turns (PR 2c-2)

PR 2c-2 puts five more kinds of ACP turn on the shared round, the shared tool batch and the client's stop point. Two are fresh prompts PR 2a left out: channel prompts and Goal-proposal approval turns. Three re-enter a turn the session already has: a retry, a continue of an interrupted turn and the restore of an unanswered `ask_user_question`. Goal turns, cron and background notifications move in PRs 2c-3 and 2c-4.

| Turn                           | With the setting on                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel prompt                 | a `UserQuery` like any fresh prompt, without the submitted prompt or workflow input, as today; its responses are not cut short by queued input, its tool results never end the turn, and its repeated-tool-failure guard stays off  |
| Goal-proposal approval         | a `UserQuery`; the session settles the proposal as today, and a Todo Stop Guard that gives way, or the Stop hook's cap, keeps the proposal from starting a Goal                                                                     |
| retry                          | ACP strips the failed attempt and puts it back if the retry never sends, as today; the first round is a `Retry` with `historyPromptId`, the attempt's identity, and UserPromptSubmit's verdict from `admitUserPrompt`               |
| continue                       | ACP strips the interrupted run, or closes the interrupted calls, as today; the first round is a `Retry` with `historyPromptId` and no UserPromptSubmit; a first request that never goes out puts the interrupted run back as it was |
| restore of `ask_user_question` | ACP asks the question again with its own tool step; the answer is the first round, a `Retry`; later batches run on the shared batch                                                                                                 |

A re-entered turn's first round is a `Retry`, not a `ToolResult`, even when it carries tool results: a `ToolResult` does not start the client's interaction, so the previous prompt's loop-detector counts would carry over and UserPromptSubmit would run on the results. Headless continues an interrupted turn with a `ToolResult` because each of its runs is a new process. A `Retry` gets no system reminders from the client, so ACP adds its plan, arena and output-style reminders to it as today, and the todo reminder ACP takes is the one the client would take.

The restored question keeps ACP's tool step: the shared batch records every result, and a question left unanswered on a timeout must stay unrecorded so a later load can ask it again.

The core changes of this step: `userTurnRecordedByHost` also covers a `Retry`, whose todo work chain the host started; `promptAdmission` is accepted on a `Retry`; and the new input `historyPromptId`, the history identity a `Retry`'s request carries, spent by its first request.

## Migration

| PR   | Content                                                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | this design                                                                                                                                         |
| 1    | the shared loop, `beforeToolLaunch`, the setting, headless (`-p` and stream-json), the parity suite                                                 |
| 1d   | headless: default on                                                                                                                                |
| 1r   | headless: remove its current loop                                                                                                                   |
| 2a   | ACP: the model round of a fresh user prompt moves to `LlmClient`; ACP's re-implementations stay out of the shared path, and ACP keeps its tool step |
| 2b   | ACP: the tool batch of those turns on the scheduler; the daemon tool-loop guards become the client's guards plus a surface policy                   |
| 2c-1 | ACP: the stop point of those turns on the client's chain, with the Todo Stop Guard as a stop policy; `stopHookRunByHost` is removed                 |
| 2c-2 | ACP: channel, Goal-proposal, retry, continue and restore turns                                                                                      |
| 2c-3 | ACP: Goal turns                                                                                                                                     |
| 2c-4 | ACP: cron and background-notification turns                                                                                                         |
| 2d   | ACP: default on, then remove its current loop                                                                                                       |
| 3    | Ink TUI                                                                                                                                             |
| 4    | OpenTUI                                                                                                                                             |
| 5    | AgentCore on a `Turn` round (subagents, background and forked agents, workflows)                                                                    |
| 6    | speculation                                                                                                                                         |
| —    | Hosted Harness: separate evaluation                                                                                                                 |

Each of PRs 3–6 is followed by its own default-on and removal steps.

A surface counts as moved when it passes its parity suite with the setting on and its known differences are listed. Each surface then changes its default on its own, without waiting for the others. Its default changes when:

- the setting has been available for that surface for at least one release;
- the scheduled job that runs the surface's integration suite with the setting on has passed on main for two weeks;
- the surface has no open row in [Send options a host owns](#send-options-a-host-owns);
- the release notes list its intended differences from [Compatibility](#compatibility).

Its current loop is removed one release after its default changed. Until then, setting `experimental.unifiedAgentLoop` to `false` brings the current loop back for that surface.

## Parity suite

`integration-tests/fake-openai-server.ts` already records every request body.

**How it runs.** The suite runs each scripted scenario on a surface twice, once with `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` unset and once with it set to `1`. It compares:

- the request sequence the model saw, normalized by removing timestamps, the date reminder, ids and durations;
- the surface's output: the stream-json frames for headless; for ACP the `session/update` notifications and each prompt's stop reason, without `available_commands_update`, which arrives on its own schedule.

A difference fails the scenario unless it is listed with a linked issue.

**First scenarios:**

- plain text;
- one tool;
- a parallel read-only batch;
- mixed safe and unsafe calls;
- a Code Mode `exec` script that calls a tool;
- approval allowed and denied (stream-json `can_use_tool`);
- cancel during a tool;
- a mid-stream retry and a model fallback;
- an output-truncated edit;
- loop detection;
- a blocking Stop hook;
- `--max-tool-calls` at the budget edge: a parallel batch, a sequential batch, a call rejected before it runs, and a batch that needs approval;
- `--max-session-turns` across two stream-json messages;
- structured output with a sibling call;
- a teammate message merged into a tool-result turn.

**ACP scenarios** (`integration-tests/cli/acp-agent-loop-parity.test.ts`):

- plain text, and streamed text with a thought;
- one tool, and two reads in one response, whose updates are compared per call because the reads run concurrently on the shared batch;
- an approved write between reads, and a denied write, in the default approval mode;
- reads past the per-turn tool-call cap, without the end of the response the client's cap stops;
- an edit cut off by the output limit;
- a stream that drops and is retried;
- two prompts in one session;
- a channel prompt that reads a file;
- a retry after a model error;
- a model error;
- a UserPromptSubmit hook that blocks;
- a Stop hook that blocks once, and one that blocks up to the cap;
- the Todo Stop Guard continuing past unfinished todos until its attempts are spent.

A continuation's request runs under a prompt id of its own on the current loop and under the turn's prompt id on the shared loop; the suite compares them as one.

The suite runs in the integration job. A scheduled job also runs the whole headless integration suite with the setting on.

## Compatibility

- With the setting off, no surface changes. The shared code that changes is additive: the scheduler's optional `beforeToolLaunch`, from PR 2a the `Turn` event fields and send options above, from PR 2b the exported `runToolBatch` and the scheduler's `refuseToolCall` and `onPermissionPromptTerminalSequence`, and from PR 2c-1 `stopPolicies`, which change nothing for a caller that does not use them.
- With the setting on, headless differs from today in these intended ways. Most follow from scheduling a batch as one unit, as the TUI already does:
  - a stream-json message past `--max-session-turns` ends the run at the session turn limit, as `-p` does (the error on stderr, exit code 53), instead of a success that repeats the previous answer (#15325);
  - a notification turn (cron, monitor and other queued items) counts each of its model rounds toward `--max-session-turns`, as the main turn does, instead of one turn for the whole item, so a run whose notification turns call tools can reach the limit sooner;
  - a batch's PreToolUse hooks and approvals (stream-json `can_use_tool`) run for all of its calls before any of them is launched, instead of one call at a time; under `--max-tool-calls`, a call past the budget can be approved and then stopped before it runs;
  - a PostToolBatch hook fires once per batch with all of its calls, and the batch output budget applies across the batch; today each call is its own batch;
  - telemetry follows the batch, as in the TUI: a plan-mode entry's siblings are logged as failed tool calls, also in the JSON `stats`, and a call stopped before its launch still has a tool span; with Mod tool hooks the calls are still scheduled one at a time, so neither applies;
  - the results of a batch with several sequential calls are printed when the batch completes, instead of after each call;
  - with PreToolUse or PermissionRequest hooks configured, a read-only shell call can run in parallel, judged by its input after the hooks ran, instead of always running alone;
  - when a skill earlier in the batch registers a PreToolUse hook, a later call of the batch is stopped and the model has to issue it again, instead of being checked by the new hook;
  - under `--json-schema`, a `structured_output` call that repeats a call id in the same response is answered as a duplicate instead of being run, so a valid second submission waits for the next round; a later round that resubmits it under the same call id with the same arguments is answered as a duplicate too, and a second such resubmission ends the run as a provider duplicate loop, instead of running it each time.

  The parity suite covers the common cases unchanged and asserts the #15325 stop and the approved call under `--max-tool-calls`. The headless unit tests run the notification-turn count and the resubmitted `structured_output` on both loops.

- With the setting on, an ACP prompt turn differs from today in these intended ways. Most follow from the client doing for ACP what it does for the other surfaces:
  - a prompt carries the client's date reminder when the date changed since the last one, and its system reminders are the client's, the advisor and paused-Goal reminders included; they come before ACP's one-shot notices instead of after them;
  - UserPromptSubmit also runs for the turn's tool-result requests, with their text (empty when the request carries only tool results), as on the other surfaces (#9511); cancelling the turn stops a hook still running there; a block there ends the turn with the block notice and closes the round's tool calls with a result saying the hook blocked it, keeping the input taken with the results in history;
  - the session token limit is checked before the client compacts the history instead of after;
  - the client's session turn cap applies to ACP prompts, and so do its content and thought loop heuristics when `model.skipLoopDetection` is false and the next-speaker check when it is enabled (#14114);
  - a tool-result request carries the recall and the queued loop reminder and runs the client's size-only microcompaction, the managed memory tasks are the client's, skill review included, and the prompt counts toward commit attribution;
  - every compaction shows the compaction notice, also one inside a send;
  - from PR 2b, a tool batch is scheduled as one unit, as in the TUI: its approvals are asked for before any of its calls runs, and its concurrency-safe calls run concurrently, so their updates interleave;
  - the client's per-turn tool-call cap stops the response as it streams, so that request ends interrupted and reports no usage; the call past the cap is still shown as skipped;
  - a cancelled call's result reads `[Operation Cancelled] Reason: …`, and the other calls of a batch whose approval was declined are cancelled instead of skipped with ACP's permission-cancel message;
  - ACP's parameter-error and partial-edit stops take effect after the batch, so its other calls still run; a repeated provider call id ends the turn without recording skipped results;
  - the todo and exploration reminders of a tool-result request are the client's, placed by the client after the input taken at the tool boundary;
  - a PostToolBatch hook fires once per batch, and the batch output budget applies across the batch;
  - a PostToolUse hook's artifacts arrive with the tool's result update instead of a separate `artifact-event` notification;
  - from PR 2c-1, the current turn's background results that arrive after its last response start a background-notification turn instead of continuing the prompt, and with the Todo Stop Guard armed, input queued mid-turn becomes the next prompt instead of continuing this one;
  - the Todo Stop Guard continues only once the Stop hook lets the response stop, in a request of its own instead of one merged with the hook's reason, and input that arrives while the Stop hook runs no longer discards its decision;
  - Stop-hook and Todo Stop Guard continuations run under the turn's prompt id, run UserPromptSubmit as the TUI's do, run the client's tool-call guards except in Live and Agent Host sessions, which keep ACP's, and send their tool results back as any batch does;
  - from PR 2c-2, a channel prompt and a Goal-proposal turn get what a fresh prompt gets on the shared path, the date and system reminders and the client's recall included;
  - a retry, a continue and a restore start the client's interaction: its loop detector, exploration budget and turn budget start over, and their first round does not count toward the session turn cap;
  - a continue whose first request never goes out puts the interrupted user run back as it was, instead of keeping it as one merged entry;

  The ACP parity suite covers the common cases unchanged and asserts the date reminder, UserPromptSubmit on tool results, cancelling while that hook runs, and that a batch's approvals come before its calls run.

- Later surfaces bring their own fixes: #15324 (ACP), #15326 (OpenTUI), #14114 and #12209 (ACP).

- No setting, protocol field or file format is removed.

## Risks

| Risk                                                                                                        | Mitigation                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Whole-batch scheduling changes headless frame order or the exact `--max-tool-calls` count                   | ordered result streaming; `beforeToolLaunch`; parity scenarios at the budget edge                                                                                                                |
| Moving ACP onto `LlmClient` adds behavior (caps, heuristics, reminders) and could run hooks twice           | ACP's own copies stay off the shared path; parity lists every added behavior; separate PR                                                                                                        |
| AgentCore's deferred approvals must restore four async-local frames                                         | move the existing contract tests with the code; a real deferred-approval run in the TUI agent view (PR 5)                                                                                        |
| Two implementations coexist while the setting exists, and new loop-level behavior has to be wired into both | each surface switches its default and drops its current loop as soon as it is ready, instead of after every surface has moved; the current loops are not refactored meanwhile; parity runs in CI |
| Large PRs touch core                                                                                        | each PR moves one surface; PR 1 is a feature PR behind an off-by-default setting                                                                                                                 |

## Acceptance criteria

Per surface PR:

- With the setting off, the existing unit and integration suites pass unchanged.
- With the setting on, the surface passes its parity scenarios; every difference is listed and linked.
- The surface's loop-specific tests also run with the setting on.

End state:

| Measure                                              | Today                                            | Target |
| ---------------------------------------------------- | ------------------------------------------------ | ------ |
| Agent loop implementations                           | 7, plus the extra copies inside headless and ACP | 1      |
| Loops that call `LlmChat.sendMessageStream` directly | 3                                                | 0      |
| Loops that parse stream chunks outside `turn.ts`     | 3                                                | 0      |
| Loops that call `finalizeToolResponses`              | 6                                                | 1      |
| Session turn-cap formulas                            | 3                                                | 1      |

## Open questions

- Should `model.maxSessionTurns: 0` mean "no turns" or be rejected? Today the loops disagree (#15325).
- The parity suite compares frames in order, and no scenario yet runs concurrent calls with live output, whose progress frames have no fixed order in either loop. Should such scenarios compare progress frames per call?
- A call `beforeToolLaunch` refuses is still a member of its batch for PostToolBatch, so a stop or added context the hook attaches to it does not reach the model. Headless refuses a call only when the run ends, so this does not show there. Before another surface uses `beforeToolLaunch`, should refused calls leave the batch the hook sees, or should the hook's output move to the last call that ran?

## Follow-up

- Session-level scheduling: one place that decides when a notification, cron job, Goal turn or teammate message starts a loop.
- The Hosted Harness evaluation: whether its journaled dispatch becomes a scheduler behind the same `schedule` contract.

# Unified agent loop

[English](2026-10-23-unified-agent-loop.md) | [简体中文](2026-10-23-unified-agent-loop.zh-CN.md)

- **Status**: proposed. This document is PR 0 and changes no code. PR 1 (headless) has not started.
- **Date**: 2026-10-23, against upstream `779a4d5d0d`.
- **Related**:
  - tracking issue #15327;
  - the earlier proposal #8775;
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
- changing any default during this round.

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

The loop is an async generator. It yields every model event unchanged, plus tool lifecycle events, so the existing surface adapters keep working. It returns a result whose stop reason the surface maps to its own outcome. Decisions the surface owns are callbacks.

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
3. **Plan-mode entry.** When the batch enters plan mode, its sibling calls are skipped through the existing `findPlanModeEntryBatchBoundaryIndex`.
4. **Scheduling.** The whole batch is scheduled on one scheduler.
   - The default is `CoreToolScheduler`. It already provides partitioning by concurrency safety, the in-flight cap, approvals, hooks, the partial-edit guard, Mod tool checks and runtime views.
   - The surface supplies the scheduler options it owns today: the approval wiring, progress output and the full-turn model callback.
   - A surface whose Mods have tool hooks passes the Mod-aware scheduler it uses today, with the same `schedule` contract, so Mod behavior does not change: Ink and OpenTUI use `InteractiveModToolScheduler`, headless a per-call Mod runner.
5. **Launch hook.** One new `CoreToolScheduler` option, `beforeToolLaunch(call)`, runs serially in request order right before each launch, including inside a concurrent batch. Returning `false` leaves the call unexecuted. Headless needs it for:
   - the exact `--max-tool-calls` count (tick before launch);
   - "the first valid `structured_output` ends the session".
6. **Ordered results.** Results are yielded in request order as soon as every earlier call has settled. Tool progress goes through the same queue, so stream-json frames keep their current order.

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
- `cancelled`;
- `loop_detected`;
- `duplicate_provider_call`;
- `tool_ended_turn`;
- `surface_ended` — a callback ended the loop, e.g. a structured-output success;
- `max_session_turns`;
- `session_token_limit`;
- `user_prompt_blocked`;
- `error`.

The surface maps the reason. Headless maps it to exit codes and results; ACP later to `stopReason`; AgentCore to `terminateMode`.

### Surface policies

Behavior that only some surfaces have is passed in as a policy instead of copying the loop. Examples:

- the `--max-tool-calls` ticker;
- structured output;
- model-override precedence;
- teammate merging;
- and later, the daemon tool-loop guards and the Todo stop guard.

A policy affects only the surface that passes it.

### The setting

`experimental.unifiedAgentLoop` is a boolean, `false` by default, and takes effect after a restart. `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP=1` overrides it, which lets CI and scripts run the suites with the shared loop. Both follow the pattern of `experimental.agentTeam` / `QWEN_CODE_ENABLE_AGENT_TEAM`.

`Config.isUnifiedAgentLoopEnabled()` exposes it. Each surface reads it at its loop's entry point:

```ts
if (config.isUnifiedAgentLoopEnabled()) {
  return runOnSharedLoop(...);
}
// current loop, unchanged
```

The current loop stays as the `else` branch and is not refactored while the setting exists. A surface that has not moved yet ignores the setting, and the setting's description names the surfaces it covers. ACP children started by `qwen serve` read the same settings, so the daemon and Web Shell follow the setting once ACP moves.

### Headless on the shared loop (PR 1)

| Headless today                                                                     | With the setting on                                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `while (true)` round loop, plus a second copy in `drainBatch`                      | one loop call per interaction; each drain item is another call with its own send type                             |
| `limitedTurnCount` gate (exit 53)                                                  | unchanged; the client's `MaxSessionTurns` now ends with the same error result instead of a false success (#15325) |
| `discardAbandonedAttempt` on `Retry` / `ModelFallback`                             | the loop drops the calls; the surface restarts its attempt and writes the retry frame                             |
| `processToolCallBatch` duplicate and replay handling                               | the loop                                                                                                          |
| `structured_output` pre-scan and first-success end                                 | surface policy: call selection plus a result callback that ends the loop                                          |
| plan-mode-entry sibling skip                                                       | the loop                                                                                                          |
| `executeToolCall` per call, `partitionHeadlessToolCalls`, the in-flight cap        | one scheduler per round, with the same partitioning and cap                                                       |
| tick before launch                                                                 | `beforeToolLaunch`                                                                                                |
| Mods with tool hooks run serially                                                  | the per-call Mod runner as the batch scheduler                                                                    |
| ordered finalize, `finalizeToolResponses`, `recordToolResult` with Goal provenance | the loop                                                                                                          |
| model-override precedence (inline `/model` > full-turn vision > `\0` sentinel)     | surface policy                                                                                                    |
| teammate text merged into the tool-result turn                                     | input at the tool boundary, sent as `Teammate`                                                                    |
| Goal `terminateTurn`                                                               | stop reason `tool_ended_turn`                                                                                     |
| `LoopDetected` → exit 1; a repeated duplicate id → loop-detected result            | stop reasons `loop_detected`, `duplicate_provider_call`                                                           |
| abort → `routeAbort` (55 / 130)                                                    | stop reason `cancelled`; the surface still routes the abort                                                       |
| idle phase: next Goal, teammates, cron, background holdback, memory, final result  | unchanged, outside the loop                                                                                       |

## Migration

| PR  | Content                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | this design                                                                                                                                            |
| 1   | the shared loop, `beforeToolLaunch`, the setting, headless (`-p` and stream-json), the parity suite                                                    |
| 2   | ACP sessions; the model round moves to `LlmClient` and ACP's re-implementations stay out of the shared path; may split into model round and tool batch |
| 3   | Ink TUI                                                                                                                                                |
| 4   | OpenTUI                                                                                                                                                |
| 5   | AgentCore on a `Turn` round (subagents, background and forked agents, workflows)                                                                       |
| 6   | speculation                                                                                                                                            |
| —   | Hosted Harness: separate evaluation                                                                                                                    |
| 7   | default on                                                                                                                                             |
| 8   | remove the current loops                                                                                                                               |

A surface counts as moved when it passes its parity suite with the setting on and its known differences are listed. The default changes after every surface in scope has moved and the setting has been used in CI and by opt-in users for at least one release. The current loops are removed after the default has shipped for at least one release.

## Parity suite

`integration-tests/fake-openai-server.ts` already records every request body.

**How it runs.** The suite runs each scripted scenario on a surface twice, once with `QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP` unset and once with it set to `1`. It compares:

- the request sequence the model saw, normalized by removing timestamps, the date reminder, ids and durations;
- the surface's output: the stream-json frames for headless, and later the ACP `session/update` notifications.

A difference fails the scenario unless it is listed with a linked issue.

**First scenarios:**

- plain text;
- one tool;
- a parallel read-only batch;
- mixed safe and unsafe calls;
- approval allowed and denied (stream-json `can_use_tool`);
- cancel during a tool;
- a mid-stream retry and a model fallback;
- an output-truncated edit;
- loop detection;
- a blocking Stop hook;
- `--max-tool-calls` at the budget edge;
- `--max-session-turns` across two stream-json messages;
- structured output with a sibling call;
- a teammate message merged into a tool-result turn.

The suite runs in the integration job. A scheduled job also runs the whole headless integration suite with the setting on.

## Compatibility

- With the setting off, no surface changes. The only shared code that changes is the scheduler's new optional `beforeToolLaunch`, which does nothing when it is not passed.
- With the setting on, the intended differences are:
  - the fixes for #15325 (headless);
  - and later #15324 (ACP), #15326 (OpenTUI), #14114 and #12209 (ACP).

  Each is listed in the parity suite.

- No setting, protocol field or file format is removed.

## Risks

| Risk                                                                                              | Mitigation                                                                                                |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Whole-batch scheduling changes headless frame order or the exact `--max-tool-calls` count         | ordered result streaming; `beforeToolLaunch`; parity scenarios at the budget edge                         |
| Moving ACP onto `LlmClient` adds behavior (caps, heuristics, reminders) and could run hooks twice | ACP's own copies stay off the shared path; parity lists every added behavior; separate PR                 |
| AgentCore's deferred approvals must restore four async-local frames                               | move the existing contract tests with the code; a real deferred-approval run in the TUI agent view (PR 5) |
| Two implementations coexist while the setting exists                                              | the current loops are not refactored; parity runs in CI; removal is scheduled in the plan                 |
| Large PRs touch core                                                                              | each PR moves one surface; PR 1 is a feature PR behind an off-by-default setting                          |

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
- Should the parity suite's output comparison tolerate tool-progress frames that move relative to each other inside a concurrent batch, where the order is not deterministic today either?

## Follow-up

- Session-level scheduling: one place that decides when a notification, cron job, Goal turn or teammate message starts a loop.
- The Hosted Harness evaluation: whether its journaled dispatch becomes a scheduler behind the same `schedule` contract.

# Event-bus agent loop

[English](2026-11-11-event-bus-agent-loop.md) | [简体中文](2026-11-11-event-bus-agent-loop.zh-CN.md)

- **Status**: PRs 1–3 merged (#16935 primitives, #16938 handlers, #16949 streaming evaluation); PR 4 (headless opt-in setting) merged in #16994; with the same setting, AgentCore's rounds run on the kernel from unified-loop PR 5c; no surface default changes.
- **Date**: 2026-11-11, against `origin/main` `da270e434957`.
- **Related**:
  - [Unified agent loop](2026-10-23-unified-agent-loop.md) — the accepted design this one re-architects internally; tracking issue #15327, accepted in #15343, headless merged in #15369, ACP model round merged in #15509;
  - source of the ported architecture: the `v1.0.0-preview` branch at `587e3429cabf`, `packages/core/src/event-bus/` (20 files, 6,237 lines);
  - the preview-port pilot issue #16896 (file-history hardening) — a separate, smaller track.

## Problem

The shared agent loop (`packages/core/src/core/agent-loop.ts`, 660 lines) is a procedural `for` loop: `runModelRound` → `runToolBatch` → continuation, with every surface decision expressed as an optional callback on `AgentLoopHost`. This was the right first step for the unified-loop convergence: it keeps every surface adapter working while the seven copies move onto one implementation.

The `v1.0.0-preview` branch re-expressed the same cycle as an event-driven state machine, and its shape has properties the procedural loop lacks:

- **An explicit event vocabulary.** Ten bus events (`query.submitted/output/cancelled/finished`, `llm.request/tool_use/settled`, `tool.cancel/settled`, `handler.failed`) name every transition. In the procedural loop the same transitions are implicit in control flow, so a new loop-level behavior has to be threaded through the function body.
- **Delivery guarantees.** The bus delivers events for one subscriber and one query serially in publish order, and different queries never block each other. A listener that throws becomes a `handler.failed` event instead of an unhandled rejection. Callbacks today have neither ordering nor failure semantics beyond "throwing ends the loop".
- **Writer ownership.** Per-query state is split so that Conversation owns decisions and context, Llm owns selection and the model result, Tool owns the dispatched batch. The procedural loop shares mutable locals across all three concerns.
- **Round scoping.** Round-scoped events carry a `roundId`; late events from an abandoned round are dropped by construction (`currentRound`). The procedural loop handles this with ad-hoc checks (for example dropping collected calls on `Retry`/`ModelFallback`).
- **Bounded settlement.** Cancellation and consumer close settle within a cap (10 s in preview) instead of waiting on a stuck handler.

We want these properties in main's shared loop without disturbing the convergence that is already in flight, and without a second competing loop.

## Current behavior

### main (verified at `da270e434957`)

| Concern        | Where                                                                                                                                              | Shape                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Shared loop    | `core/agent-loop.ts:200` `runAgentLoop`                                                                                                            | procedural `for`; stop reasons `AgentLoopStopReason` (`:40`)                                                                      |
| Model round    | `core/agent-loop.ts:262` `runModelRound`                                                                                                           | `LlmClient.sendMessageStream` generator; events forwarded to `host.onModelEvent`; `Retry`/`ModelFallback` discard collected calls |
| Tool batch     | `core/agent-loop.ts:351` `runToolBatch`                                                                                                            | duplicates/replays → `host.selectCalls`/`beforeToolLaunch` → executor → `finalizeToolResponses`                                   |
| Executor seam  | `core/agent-loop.ts:162` `AgentLoopToolExecutor`                                                                                                   | replaceable; default wraps one `CoreToolScheduler` (`:613`)                                                                       |
| Surface seam   | `core/agent-loop.ts:110` `AgentLoopHost`                                                                                                           | optional callbacks, not subscriptions                                                                                             |
| Model events   | `core/turn.ts:78` `LlmEventType` (21 kinds), `Turn` (`:752`)                                                                                       | already a normalized event stream                                                                                                 |
| Existing buses | `confirmation-bus/message-bus.ts:15` `MessageBus`; `agents/runtime/agent-events.ts:296` `AgentEventEmitter`; `packages/acp-bridge/src/eventBus.ts` | hooks request/response; subagent-scoped events; transport fan-out with replay — none is a loop control bus                        |

Surfaces: headless runs `runAgentLoop` (merged, #15369); ACP uses `runModelRound` with its own tool step (#15509 merged); Ink TUI (`use-llm-stream.ts`), OpenTUI, AgentCore, speculation and the Hosted Harness still run their own loops, governed by the unified-agent-loop migration plan.

### preview (verified at `587e3429cabf`)

`packages/core/src/event-bus/`:

- `bus.ts` (147 lines) — `QueryEventBus`: typed publish/subscribe, routing by `queryId`, per-`(subscriber, query)` serial promise chains, listener failures republished as `handler.failed`, an `eventId` identifier consumers can dedup on (the bus does not deduplicate).
- `events.ts` (114) — the event map and the reason enums (`RequestReason`, `LlmFailureKind`, cancel reasons).
- `state.ts` (292) — `QueryStateStore` plus the ownership split described above.
- `conversation-handler.ts` + `conversation/` (~2,400) — the only decision maker: submit, model-settled, tool-settled, failure finalization.
- `llm-handler.ts` + `llm/` (~2,100) — one model request per `llm.request`: preparation, inference, result classification.
- `tool-handler.ts` (347) — executes dispatched calls through an injected `ToolExecutor`; cancellation races the wait (`waitOrStop`).
- `query-stream.ts` (534) — bridges the bus to `AsyncGenerator<QueryEvent, Terminal>` with four cancellation sources and a 10 s settlement cap.
- `core/agent-loop.ts` (85) — the entry only validates and delegates.

Two preview behaviors are deliberately **not** part of the first port: streaming tool dispatch (a `tool_use` block executes while the model stream is still running) and the qoder business-reporting path. Both change semantics main does not have today; see Scope.

## Goals and scope

Goals:

- Port the bus, event vocabulary, state store and handler decomposition into `packages/core` as the **internal architecture of the existing shared loop**.
- Keep every external contract of the unified loop unchanged: `runAgentLoop`, `runModelRound`, `runToolBatch`, `AgentLoopHost`, `AgentLoopToolExecutor`, `AgentLoopOptions`, `AgentLoopResult`, and the `experimental.unifiedAgentLoop` rollout.
- Keep the unified-loop parity suites green at every step; a surface notices nothing.
- Land the architecture in reviewable slices, each with its own tests.

Out of scope:

- A second loop, or a new `query()` entry point. The unified design's "one implementation" goal stands.
- `LlmChat`, `Turn`, the provider layer, and `CoreToolScheduler` internals — the handlers wrap them, they are not rewritten.
- The history/transcript model, hooks (they stay on `MessageBus`), compression, telemetry, UI and wire protocols.
- preview's qoder business-info/reporting, `protocol/`, `provider/`, `compression-v2/` modules — main keeps its own equivalents.
- Streaming tool dispatch in the first port (Phase 3 evaluates it separately, behind its own gate).
- Surface migration itself (TUI, OpenTUI, AgentCore, speculation, Hosted) — that stays with the unified-agent-loop program; this design only changes what the shared loop looks like inside.

## Design

### Layering

```text
Surfaces (unchanged): AgentLoopHost callbacks, AgentLoopToolExecutor, scheduler wiring
   ▼
runAgentLoop (same signature) — adapter: hosts ↔ bus subscriptions
   ▼
event-bus/  (new, packages/core/src/event-bus/)
   bus.ts          LoopEventBus: routing, serial delivery, handler.failed
   events.ts       loop event vocabulary over main's types
   state.ts        per-run state, writer ownership
   conversation.ts decisions: continue / stop / next round
   llm.ts          one model round per llm.request (wraps runModelRound)
   tool.ts         one batch per round (wraps runToolBatch)
   ▼
LlmClient → Turn → LlmChat, CoreToolScheduler (unchanged)
```

The adapter is the compatibility boundary: it owns run-state creation and subscribes only for `loop.finished`/`handler.failed`. The **handlers** fire `AgentLoopHost` callbacks in the procedural order — Conversation fires the boundary callbacks (`onRoundStart`/`onRoundEnd`/`nextRound`), Llm and Tool drive the rest through `runModelRound`/`runToolBatch` — converting a host callback that throws into the loop's error outcome, matching today's "throwing ends the loop". Callback **order** is preserved, not the exact tick: the first callback fires one bus-delivery hop after `runAgentLoop` returns rather than synchronously within the call, which no surface observes while the flag is off. Surfaces never see the bus in this design. Exposing subscriptions to surfaces is a possible later step, not a goal here.

### Identity and event mapping

Preview routes by `queryId` and scopes rounds by a UUID `roundId`. Main's loop runs once per interaction with a `promptId` and a numeric round counter. The port keeps main's identities:

- `runId`: generated at `runAgentLoop` entry; the routing key (one run = one preview "query"). `promptId` is attribution, carried on events, never a routing key — a drain turn may reuse a prompt id across runs. It is **run-level**: set once from `first.promptId`, so continuation rounds keep the run's first `promptId` on events even when a host `nextRound` returns a different one (host callbacks report the round's `promptId`). Whether `promptId` should instead follow the round is a decision for the slice that exposes subscriptions.
- `round`: the run's round number, assigned when Conversation publishes `llm.request`. Late events are dropped by the same `currentRound` check.

| Bus event        | Payload (main types)                   | Published by                     |
| ---------------- | -------------------------------------- | -------------------------------- |
| `loop.started`   | `{ promptId }`                         | adapter, after state creation    |
| `loop.output`    | `{ event: ServerLlmStreamEvent }`      | planned (streaming slice)        |
| `loop.cancelled` | `{ reason }`                           | planned (streaming slice)        |
| `loop.finished`  | `{ result: AgentLoopResult }`          | Conversation                     |
| `llm.request`    | `{ round, send: AgentLoopRound }`      | Conversation                     |
| `llm.tool_call`  | `{ call: ToolCallRequestInfo }`        | planned (streaming slice)        |
| `llm.settled`    | `{ round }`                            | Llm, at round end                |
| `tool.request`   | `{ round, calls }`                     | Conversation, after `onRoundEnd` |
| `tool.cancel`    | `{ reason }`                           | planned (streaming slice)        |
| `tool.settled`   | `{ round }`                            | Tool, at batch end               |
| `handler.failed` | `{ source, eventType, round?, error }` | bus, on listener failure         |

Events marked _planned_ are in the vocabulary but not emitted by this slice; they arrive with streaming dispatch. Cancellation today flows through the signal into `runModelRound`/`runToolBatch`, not through a bus event.

`llm.settled` is the round-end signal; the terminal classification (the `STOP_EVENTS` mapping that `runModelRound` does today) lives in run state (`state.model.stop`), and Conversation is the only place that turns that round-end state into the loop result. Duplicate/replay bookkeeping stays in the Tool handler, using the existing `toolCallIdUtils` helpers, exactly where `runToolBatch` does it today. Event payloads carry only routing and decision data; the full model result and tool batch live in the run state under their owner's slot, so the bus never duplicates them.

### State and ownership

One state object per run, created by the adapter, deleted when the run settles:

- **Conversation** writes: the current round, the continuation decision, and the final result.
- **Llm** writes: the round's model slot — the collected calls, the turn, and any terminal stop reason.
- **Tool** writes: the round's settled tool batch.

The store rejects a second create for the same `runId`, and `currentRound(state, round)` returns undefined for a late event — the same construction preview uses to make abandoned rounds harmless.

### Delivery and failure

The bus (`LoopEventBus`) is ported essentially as-is (it depends only on a logger): serial chains per `(subscriber, runId)`, cross-run isolation, `handler.failed` republication, and an `eventId` identifier that consumers can dedup on — the bus itself does not deduplicate, so two publishes with the same id are both delivered. Two adaptations:

- The logger becomes main's `debugLogger` convention (main has no `runLogger`).
- On `handler.failed` (including from a **host callback**) the adapter rejects with the **original thrown value**, preserving today's "throwing ends the loop". The `source` field lives only on the event payload (for logging); the adapter discards it when rejecting, so it never reaches the caller.

### Cancellation

The handlers read the run's `signal` and `toolSignal` and pass them to `runModelRound`/`runToolBatch` exactly as today; Tool cancels the in-flight batch through the executor's signal, and Conversation finalizes once Llm and Tool are quiet. The run settles when `loop.finished` arrives. A published `loop.cancelled` event and a bounded settlement cap (preview's `QueryListener` uses 10 s) belong to the streaming slice, not this one — see the _planned_ note in the event table.

### Why not reuse an existing bus

- `MessageBus` (confirmation-bus): synchronous `EventEmitter`, request/response correlation, no per-run serialization, no failure events; today it carries hooks only. Its purpose is policy messaging, not loop control.
- `AgentEventEmitter`: vocabulary and lifetime scoped to the subagent runtime.
- acp-bridge `eventBus`: transport fan-out with replay rings and byte budgets; it sits above the loop, not inside it.

None provides query routing + serial async delivery + failure events, which are the properties being ported. The new module is ~300 lines of primitives; the handlers are a re-expression of logic that already exists in `agent-loop.ts`, not new behavior.

## Migration (PR slices)

Each slice keeps the parity suites green and changes no surface default.

1. **PR 1 — primitives.** `event-bus/{bus,events,state}.ts` + unit tests (port preview's `bus.test.ts`; add serial-delivery, cross-run isolation, failure-republication, late-round tests). Nothing consumes the module yet; zero behavior change. This design doc lands here. `runtime.ts` (handler wiring) and `handler-support.ts` arrive with the handlers in PR 2.
2. **PR 2 — handlers behind an opt-in flag.** Re-express `runAgentLoop` internals as Conversation/Llm/Tool handlers plus the host adapter, selected by a new `AgentLoopOptions.useEventBus` flag (default off, so the procedural path stays the default within the unified loop until parity is proven). `runModelRound`/`runToolBatch` keep their exports and signatures (ACP #15509 depends on them) and are reused unchanged by the handlers. An equivalence test runs both paths over scripted scenarios and asserts identical results and host-callback order; the headless parity suite and the ACP round tests are the acceptance gate.
3. **PR 3 — streaming dispatch evaluation (optional, separate gate).** Preview executes a `tool_use` block while the stream is still running. Main runs the batch after the round ends, and approvals are batch-ordered; streaming dispatch changes approval timing and output interleaving. This slice first writes down the parity differences and gets an explicit decision; it is not required for the architecture port.
4. **PR 4 — headless opt-in.** A new `experimental.eventBusAgentLoop` setting (env override `QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP=1`, read by `Config.isEventBusAgentLoopEnabled()`) makes the headless shared-loop path pass `useEventBus`. The flag only applies where the full shared loop runs: headless is today's only `runAgentLoop` caller, while ACP, Ink TUI and OpenTUI use `runModelRound` directly and are unaffected. The adapter logs an `[EVENT_BUS]` execution marker through `debugLogger`, so with `QWEN_DEBUG_LOG_FILE` on, a run's path is provable from the debug log instead of assumed. Default off; the procedural path stays the default, and the flag alone (without `experimental.unifiedAgentLoop`) changes nothing.
5. **Later — surface convergence** continues under the unified-agent-loop program (TUI, OpenTUI, AgentCore, speculation, Hosted). The bus makes loop-level attachments (hooks, Mods, protection, recording) single-place, which is that program's stated goal; no surface work is scheduled here.

## Testing

- Unit: bus primitives (ported + new), state ownership and late-round drops, each handler's transitions, and the adapter's callback order/throw semantics. Collocated `*.test.ts`, vitest.
- Parity: the unified-loop suites (headless merged; ACP round merged) run unchanged against PR 2 — they are the proof that surfaces notice nothing.
- E2E: a plan under `.qwen/e2e-tests/` covering headless and ACP prompt turns with the setting on and off, per the feat-dev workflow; baseline dry-run before implementation.

### Real-scenario evidence (PR 4)

Headless runs against a deterministic mock OpenAI endpoint (real tool execution, real retry, real SIGINT cancellation): off = procedural shared loop, on = bus shared loop, both with `experimental.unifiedAgentLoop` enabled. The bus path is confirmed by the adapter's `[EVENT_BUS] runAgentLoopOnBus started` debug marker (`QWEN_DEBUG_LOG_FILE=1`) — every off run logs 0 markers, every on run at least one — so the parity is not a false green. Outputs are identical after normalizing per-run identity and timing fields.

| Scenario                              | Result (off = on)                 | Markers off/on |
| ------------------------------------- | --------------------------------- | -------------- |
| G1 single turn                        | MOCK_OK                           | 0 / 1          |
| G2 tool loop (glob)                   | TOOL_LOOP_DONE, 1 tool result     | 0 / 2          |
| G3 retry (500 → ok)                   | RETRY_OK                          | 0 / 1          |
| G4 cancel during model stream         | exit 130, no hang                 | 0 / 1          |
| G5 settings-file enablement (no env)  | MOCK_OK                           | 0 / 1          |
| G6 multi-tool batch + two tool rounds | MULTI_ROUND_DONE, 3 tool results  | 0 / 3          |
| G7 tool error finalization            | TOOL_ERROR_DONE, error result     | 0 / 2          |
| G8 stream-json output                 | identical envelope stream         | 0 / 1          |
| G9 cancel during tool execution       | exit 130, no hang                 | 0 / 1          |
| G10 same-batch duplicate calls        | DUPLICATE_DONE, replayed response | 0 / 2          |

G5 enables both flags through an isolated user settings file with no environment variables, proving the settings-to-flag chain. G9 cancels while a foreground tool runs (the toolSignal path), complementing G4's mid-stream cancel. Marker counts above 1 reflect headless invoking the loop once per round.

## Acceptance criteria

- PR 1 (primitives): the bus/state/events module lands with unit tests, no runtime consumer, and zero behaviour change (the loop path is unchanged while nothing consumes it); `tsc --build`, ESLint and Prettier are clean.
- PR 2 (handlers, opt-in): the equivalence suite proves identical results and ordered callback logs between the bus and procedural paths across the scripted scenarios, and the existing agent-loop tests stay green; the flag defaults off so no surface's behaviour changes; `tsc --build`, ESLint and Prettier are clean.
- Each slice lands its implementation and its tests in the same PR, and the bilingual design doc stays synchronized (structure, decisions, constraints, and this acceptance-criteria section).
- PR 4 (headless opt-in): the setting defaults off and changes no surface default; with both experimental flags on, the headless run takes the bus path, confirmed by the adapter's `[EVENT_BUS]` debug marker; the real-scenario parity below holds; `tsc --build`, ESLint and Prettier are clean.
- Real headless scenarios (single turn, tool loop, retry, cancellation) produce parity between the procedural and bus paths with the flag on and off, with the bus path confirmed by an execution marker rather than assumed. PR 4 delivers the enablement and the marker; the scenario evidence is summarized in the Testing section above (full logs live in the local E2E plan under `.qwen/e2e-tests/`).

## Risks and open questions

- **Callback order is a contract.** Surfaces depend on the exact order of `onModelEvent`/`onToolResult`/output callbacks. The adapter must preserve it; the parity suites are the check, and PR 2 adds an explicit order test.
- **`runModelRound`/`runToolBatch` are public seams.** ACP's merged round step (#15509) calls them directly; PR 2 keeps them as the handlers' inner implementations rather than deleting them.
- **Round identity.** Numeric rounds are simpler than preview's UUIDs and match main's logs; if a future surface needs globally unique round ids, the event payload can carry both without a routing change.
- **Streaming dispatch** remains an open product decision (latency win vs approval/ordering semantics); Phase 3 exists to force that decision explicitly rather than smuggling it in.
- **Throwaway risk.** The 1.0 line may eventually replace main wholesale; this port is justified only as long as main's unified-loop program continues. It reuses main's types and contracts precisely so the work is not preview-specific.

## Files affected

- New: `packages/core/src/event-bus/{bus,events,state}.ts` and collocated tests (PR 1); `runtime.ts`, `handler-support.ts`, `conversation.ts`, `llm.ts`, `tool.ts`, `adapter.ts` (PR 2).
- Modified: `packages/core/src/core/agent-loop.ts` internals (PR 2); its public types and exports unchanged.
- PR 4: `packages/core/src/config/config.ts` (parameter + `isEventBusAgentLoopEnabled`), `packages/core/src/event-bus/adapter.ts` (debug execution marker), `packages/cli/src/config/config.ts` and `settingsSchema.ts` (setting + wiring), `packages/cli/src/nonInteractiveCli.ts` (`useEventBus`), `packages/web-shell/client/settings.ts` and `settings/messages.ts` (public alias + zh-CN entries), and the regenerated `packages/vscode-ide-companion/schemas/settings.schema.json`; tests collocated with each change.
- Docs: this pair; the unified-agent-loop doc gains a cross-reference once PR 2 lands.

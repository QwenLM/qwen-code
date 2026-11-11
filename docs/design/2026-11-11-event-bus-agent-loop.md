# Event-bus agent loop

[English](2026-11-11-event-bus-agent-loop.md) | [简体中文](2026-11-11-event-bus-agent-loop.zh-CN.md)

- **Status**: proposed. Implementation starts with PR 1 (bus primitives); no surface default changes.
- **Date**: 2026-11-11, against `origin/main` `19f73eb7ec0a`.
- **Related**:
  - [Unified agent loop](2026-10-23-unified-agent-loop.md) — the accepted design this one re-architects internally; tracking issue #15327, accepted in #15343, headless merged in #15369, ACP model round in review in #15509;
  - source of the ported architecture: the `v1.0.0-preview` branch at `587e3429cabf`, `packages/core/src/event-bus/` (19 files, 6,237 lines);
  - the preview-port pilot issue #16896 (file-history hardening) — a separate, smaller track.

## Problem

The shared agent loop (`packages/core/src/core/agent-loop.ts`, 620 lines) is a procedural `for` loop: `runModelRound` → `runToolBatch` → continuation, with every surface decision expressed as an optional callback on `AgentLoopHost`. This was the right first step for the unified-loop convergence: it keeps every surface adapter working while the seven copies move onto one implementation.

The `v1.0.0-preview` branch re-expressed the same cycle as an event-driven state machine, and its shape has properties the procedural loop lacks:

- **An explicit event vocabulary.** Ten bus events (`query.submitted/output/cancelled/finished`, `llm.request/tool_use/settled`, `tool.cancel/settled`, `handler.failed`) name every transition. In the procedural loop the same transitions are implicit in control flow, so a new loop-level behavior has to be threaded through the function body.
- **Delivery guarantees.** The bus delivers events for one subscriber and one query serially in publish order, and different queries never block each other. A listener that throws becomes a `handler.failed` event instead of an unhandled rejection. Callbacks today have neither ordering nor failure semantics beyond "throwing ends the loop".
- **Writer ownership.** Per-query state is split so that Conversation owns decisions and context, Llm owns selection and the model result, Tool owns the dispatched batch. The procedural loop shares mutable locals across all three concerns.
- **Round scoping.** Every event carries a `round`; late events from an abandoned round are dropped by construction (`currentRound`). The procedural loop handles this with ad-hoc checks (for example dropping collected calls on `Retry`/`ModelFallback`).
- **Bounded settlement.** Cancellation and consumer close settle within a cap (10 s in preview) instead of waiting on a stuck handler.

We want these properties in main's shared loop without disturbing the convergence that is already in flight, and without a second competing loop.

## Current behavior

### main (verified at `19f73eb7ec0a`)

| Concern        | Where                                                                                                                                              | Shape                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Shared loop    | `core/agent-loop.ts:194` `runAgentLoop`                                                                                                            | procedural `for`; stop reasons `AgentLoopStopReason` (`:41`)                                                                      |
| Model round    | `core/agent-loop.ts:256` `runModelRound`                                                                                                           | `LlmClient.sendMessageStream` generator; events forwarded to `host.onModelEvent`; `Retry`/`ModelFallback` discard collected calls |
| Tool batch     | `core/agent-loop.ts:324` `runToolBatch`                                                                                                            | duplicates/replays → `host.selectCalls`/`beforeToolLaunch` → executor → `finalizeToolResponses`                                   |
| Executor seam  | `core/agent-loop.ts:161` `AgentLoopToolExecutor`                                                                                                   | replaceable; default wraps one `CoreToolScheduler` (`:564`)                                                                       |
| Surface seam   | `core/agent-loop.ts:106` `AgentLoopHost`                                                                                                           | optional callbacks, not subscriptions                                                                                             |
| Model events   | `core/turn.ts:74` `LlmEventType` (22 kinds), `Turn.run` (`:764`)                                                                                   | already a normalized event stream                                                                                                 |
| Existing buses | `confirmation-bus/message-bus.ts:15` `MessageBus`; `agents/runtime/agent-events.ts:285` `AgentEventEmitter`; `packages/acp-bridge/src/eventBus.ts` | hooks request/response; subagent-scoped events; transport fan-out with replay — none is a loop control bus                        |

Surfaces: headless runs `runAgentLoop` (merged, #15369); ACP uses `runModelRound` with its own tool step (#15509 in review); Ink TUI (`use-llm-stream.ts`), OpenTUI, AgentCore, speculation and the Hosted Harness still run their own loops, governed by the unified-agent-loop migration plan.

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

The adapter is the compatibility boundary: it subscribes to the bus and invokes `AgentLoopHost` callbacks exactly as the procedural loop does today, in the same order; it converts a host callback that throws into the loop's error outcome, matching today's "throwing ends the loop". Surfaces never see the bus in this design. Exposing subscriptions to surfaces is a possible later step, not a goal here.

### Identity and event mapping

Preview routes by `queryId` and scopes rounds by a UUID `roundId`. Main's loop runs once per interaction with a `promptId` and a numeric round counter. The port keeps main's identities:

- `runId`: generated at `runAgentLoop` entry; the routing key (one run = one preview "query"). `promptId` is attribution, carried on events, never a routing key — a drain turn may reuse a prompt id across runs.
- `round`: the run's round number, assigned when Conversation publishes `llm.request`. Late events are dropped by the same `currentRound` check.

| Bus event        | Payload (main types)                                   | Published by                         |
| ---------------- | ------------------------------------------------------ | ------------------------------------ |
| `loop.started`   | `{ promptId }`                                         | adapter, after state creation        |
| `loop.output`    | `{ event: ServerLlmStreamEvent }` / tool output chunks | Llm, Tool                            |
| `loop.cancelled` | `{ reason }`                                           | adapter, on signal abort             |
| `loop.finished`  | `{ result: AgentLoopResult }`                          | Conversation                         |
| `llm.request`    | `{ round, send: AgentLoopRound }`                      | Conversation                         |
| `llm.tool_call`  | `{ call: ToolCallRequestInfo }`                        | Llm, per collected `ToolCallRequest` |
| `llm.settled`    | `{ round, calls, discardedCalls, terminal? }`          | Llm, at round end                    |
| `tool.cancel`    | `{ reason }`                                           | Conversation                         |
| `tool.settled`   | `{ round, results: AgentLoopSettledCall[] }`           | Tool, at batch end                   |
| `handler.failed` | `{ source, eventType, round?, error }`                 | bus, on listener failure             |

`llm.settled` carries the round's terminal classification (the `STOP_EVENTS` mapping that `runModelRound` does today) so Conversation remains the only place that maps a model outcome to an `AgentLoopStopReason`. Duplicate/replay bookkeeping stays in the Tool handler, using the existing `toolCallIdUtils` helpers, exactly where `runToolBatch` does it today.

### State and ownership

One state object per run, created by the adapter, deleted when the run settles:

- **Conversation** writes: current round, continuation decision, the pending stop reason.
- **Llm** writes: the round's collected calls, discarded calls on `Retry`/`ModelFallback`, the round outcome.
- **Tool** writes: the batch's working state and its settled results.

The store rejects a second create for the same `runId`, and `currentRound(state, round)` returns undefined for a late event — the same construction preview uses to make abandoned rounds harmless.

### Delivery and failure

The bus (`LoopEventBus`) is ported essentially as-is (it depends only on a logger): serial chains per `(subscriber, runId)`, cross-run isolation, `handler.failed` republication, and an `eventId` identifier that consumers can dedup on — the bus itself does not deduplicate, so two publishes with the same id are both delivered. Two adaptations:

- The logger becomes main's `debugLogger`/`runLogger` convention.
- `handler.failed` from a **host callback** (invoked by the adapter) ends the run with the error outcome, preserving today's semantics; `handler.failed` from an internal handler is a bug and ends the run the same way, with the source named in the error.

### Cancellation

The adapter owns the run's `AbortController` wiring exactly as today (`signal`, `toolSignal`). On abort it publishes `loop.cancelled`; Tool cancels the in-flight batch through the executor's signal; Conversation finalizes once Llm and Tool are quiet. The settlement cap from preview's `QueryListener` (10 s, bounded by the surface's deadline when it has one) guards the finalize wait so a stuck handler cannot hang the run.

### Why not reuse an existing bus

- `MessageBus` (confirmation-bus): synchronous `EventEmitter`, request/response correlation, no per-run serialization, no failure events; today it carries hooks only. Its purpose is policy messaging, not loop control.
- `AgentEventEmitter`: vocabulary and lifetime scoped to the subagent runtime.
- acp-bridge `eventBus`: transport fan-out with replay rings and byte budgets; it sits above the loop, not inside it.

None provides query routing + serial async delivery + failure events, which are the properties being ported. The new module is ~450 lines of primitives; the handlers are a re-expression of logic that already exists in `agent-loop.ts`, not new behavior.

## Migration (PR slices)

Each slice keeps the parity suites green and changes no surface default.

1. **PR 1 — primitives.** `event-bus/{bus,events,state}.ts` + unit tests (port preview's `bus.test.ts`; add serial-delivery, cross-run isolation, failure-republication, late-round tests). Nothing consumes the module yet; zero behavior change. This design doc lands here. `runtime.ts` (handler wiring) and `handler-support.ts` arrive with the handlers in PR 2.
2. **PR 2 — handlers behind the existing gate.** Re-express `runAgentLoop` internals as Conversation/Llm/Tool handlers plus the host adapter, under `experimental.unifiedAgentLoop`. `runModelRound`/`runToolBatch` keep their exports and signatures (ACP #15509 depends on them). The headless parity suite and the ACP round tests are the acceptance gate; add handler-level unit tests for every stop reason.
3. **PR 3 — streaming dispatch evaluation (optional, separate gate).** Preview executes a `tool_use` block while the stream is still running. Main runs the batch after the round ends, and approvals are batch-ordered; streaming dispatch changes approval timing and output interleaving. This slice first writes down the parity differences and gets an explicit decision; it is not required for the architecture port.
4. **Later — surface convergence** continues under the unified-agent-loop program (TUI, OpenTUI, AgentCore, speculation, Hosted). The bus makes loop-level attachments (hooks, Mods, protection, recording) single-place, which is that program's stated goal; no surface work is scheduled here.

## Testing

- Unit: bus primitives (ported + new), state ownership and late-round drops, each handler's transitions, and the adapter's callback order/throw semantics. Collocated `*.test.ts`, vitest.
- Parity: the unified-loop suites (headless merged; ACP round in review) run unchanged against PR 2 — they are the proof that surfaces notice nothing.
- E2E: a plan under `.qwen/e2e-tests/` covering headless and ACP prompt turns with the setting on and off, per the feat-dev workflow; baseline dry-run before implementation.

## Risks and open questions

- **Callback order is a contract.** Surfaces depend on the exact order of `onModelEvent`/`onToolResult`/output callbacks. The adapter must preserve it; the parity suites are the check, and PR 2 adds an explicit order test.
- **`runModelRound`/`runToolBatch` are public seams.** ACP's in-flight PR uses them directly; PR 2 keeps them as the handlers' inner implementations rather than deleting them.
- **Round identity.** Numeric rounds are simpler than preview's UUIDs and match main's logs; if a future surface needs globally unique round ids, the event payload can carry both without a routing change.
- **Streaming dispatch** remains an open product decision (latency win vs approval/ordering semantics); Phase 3 exists to force that decision explicitly rather than smuggling it in.
- **Throwaway risk.** The 1.0 line may eventually replace main wholesale; this port is justified only as long as main's unified-loop program continues. It reuses main's types and contracts precisely so the work is not preview-specific.

## Files affected

- New: `packages/core/src/event-bus/{bus,events,state}.ts` and collocated tests (PR 1); `runtime.ts`, `handler-support.ts`, `conversation.ts`, `llm.ts`, `tool.ts`, `adapter.ts` (PR 2).
- Modified: `packages/core/src/core/agent-loop.ts` internals (PR 2); its public types and exports unchanged.
- Docs: this pair; the unified-agent-loop doc gains a cross-reference once PR 2 lands.

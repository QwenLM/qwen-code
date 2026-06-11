---
description: "Qwen Code subagent trace tree design. Isolate foreground, forked, and background subagent spans for clearer OpenTelemetry traces."
---

# Subagent Trace Tree Design (P3 Phase 3)

> Issue #3731 — Phase 3 of hierarchical session tracing. Adds a `qwen-code.subagent` span so subagent invocations get isolated, queryable trace structure instead of interleaving silently under the parent `qwen-code.interaction` span.
>
> Builds on Phase 1 (#4126), Phase 1.5 (#4302), and Phase 2 (#4321).

## Problem

Today every `AgentTool.execute` invocation runs under the parent's `qwen-code.interaction` span. Three pathologies:

1. **Concurrent subagents interleave.** `coreToolScheduler.ts:728` marks `AGENT` as concurrency-safe — `Promise.all` runs up to 10 subagents in parallel. Their LLM-request / tool / hook spans all attach to the single shared parent interaction span, so trace explorers cannot distinguish "this LLM request belongs to subagent A" from "this one belongs to subagent B".
2. **No span for the subagent boundary itself.** There's a `qwen-code.subagent_execution` LogRecord (emitted from `agent-headless.ts:268,329`) bridged to a span of the same name via `LogToSpanProcessor`, but it's a stand-alone marker, not a parent that nests the subagent's LLM / tool / hook spans underneath.
3. **Fork / background subagents float free.** Fire-and-forget paths (`runInForkContext` / background) outlive the parent `AgentTool.execute` and emit spans across multiple subsequent user turns. The parent tool span is already ended by the time those spans appear, so OTel's `context.active()` doesn't help — they attach to whichever interaction happened to be active at firing time, or none at all.

## Existing surface (no change)

| Component                          | Location                                                                                                                                                                                         | Why we don't touch it                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Spawn site (unified)               | `packages/core/src/tools/agent/agent.ts:1147` `AgentTool.execute()`                                                                                                                              | Single entrypoint; ideal hook for 3 invocation flavors      |
| Three invocation flavors           | foreground-named (`runFramed` at `:2154` — awaited), fork (`void runInForkContext(runFramedFork)` at `:1991` — fire-and-forget), background (`void framedBgBody()` at `:1934` — fire-and-forget) | Lifecycle differs — span design covers all three            |
| Concurrency                        | `coreToolScheduler.runConcurrently` (`Promise.all`, cap 10) — driven by `partitionToolCalls` marking AGENT as `concurrent: true`                                                                 | The thing that makes isolation necessary                    |
| `runInForkContext` ALS             | `packages/core/src/tools/agent/fork-subagent.ts:32` `forkExecutionStorage`                                                                                                                       | Recursive-fork guard only — does NOT propagate OTel context |
| Agent identity ALS                 | `packages/core/src/agents/runtime/agent-context.ts:46` `runWithAgentContext(agentId, ...)`                                                                                                       | Already carries `agentId`; we extend it with `depth`        |
| `SubagentExecutionEvent` LogRecord | `agent-headless.ts:268,329` → `loggers.ts:773` → 3 downstreams (LogToSpanProcessor span bridge + QwenLogger RUM + `recordSubagentExecutionMetrics`)                                              | LogRecord stays; downstreams depend on it                   |

## Out-of-scope (deferred)

- **Token usage aggregation per subagent** (`gen_ai.usage.*` summed across all LLM spans inside a subagent). Belongs in Phase 4 (LLM request decomposition).
- **Migrating the `qwen-code.subagent_execution` LogRecord onto the new span as span events.** RUM and metrics are tightly coupled to the LogRecord; deferred to a follow-up that can renegotiate all 3 consumers together.
- **Auto-cost rollup.** Same reason — needs token usage first.
- **Removing the AGENT-tool `concurrent: true` marker.** Concurrency is correct; we instrument it, we don't constrain it.

## References (decision evidence)

| Source                                                                                                                 | Key takeaway                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OTel Trace Spec — Links between spans](https://opentelemetry.io/docs/specs/otel/overview/#links-between-spans)        | Verbatim: "The new linked Trace may also represent a long running asynchronous data processing operation that was initiated by one of many fast incoming requests." → fork/background should be linked roots, not children.                                                                                                  |
| [OTel GenAI Agent Spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) (status: Development) | Span name `invoke_agent {gen_ai.agent.name}`; required attrs `gen_ai.operation.name`, `gen_ai.provider.name`; recommended: `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id`.                                                                                                                                 |
| LangSmith — 25,000 runs / trace cap                                                                                    | Long agent sessions force trace splitting eventually; favors hybrid traceId design.                                                                                                                                                                                                                                          |
| [Sentry — distributed tracing](https://docs.sentry.io/concepts/key-terms/tracing/distributed-tracing/)                 | "Child transactions may outlive the transactions containing their parent spans" — child-with-outliving-life is supported.                                                                                                                                                                                                    |
| claude-code (Anthropic)                                                                                                | Has subagent hierarchy in local Perfetto JSON file only; OTel export is flat. No portable code.                                                                                                                                                                                                                              |
| opencode (sst/opencode)                                                                                                | Uses `@effect/opentelemetry` auto-instrumentation; explicit `context.with(trace.setSpan(active, span), fn)` for `withRunSpan`. **Validates the context.with isolation pattern.** Their warning about manual `AsyncLocalStorageContextManager` registration doesn't apply — qwen-code's `NodeSDK` registers it automatically. |

## Design — six decisions, each justified

### D1 — Span lifecycle: caller opens, callee runs inside `context.with(span, fn)`

`agent.ts` (caller) constructs the span. The body — whether awaited (`runFramed`) or fire-and-forget (`runInForkContext` / background) — runs inside `runInSubagentSpanContext(span, fn)`, which calls `otelContext.with(trace.setSpan(active, span), fn)`.

**Where exactly in `AgentTool.execute` does the span open?** Open it **right BEFORE the invocation-kind-specific setup** (`createAgentHeadless` / `createForkSubagent` etc.) — so setup time (config build, ToolRegistry rebuild, ContextOverride wiring) IS included in `qwen-code.subagent` duration. Operators tracking "why is this subagent slow?" see the full picture. Setup typically << LLM time, so this is noise-free.

Alternative considered: open after setup, exclude setup time. Rejected because subagent's setup is itself work attributable to the subagent — hiding it makes total-duration math wrong when summing all subagent spans.

**Why not callee-only**: by the time fork / background body actually runs, the caller has already returned. OTel `context.active()` then returns whatever ambient context the async runtime carries — which for `void` fire-and-forget after the parent ends is unreliable. The parent span has already been closed; reparenting after-the-fact is wrong.

**Why not caller-only**: foreground works fine that way, but fork / background spans must continue emitting child spans (LLM / tool / hook) after `AgentTool.execute` returns. Those child spans need `context.active()` to return the subagent span — which only happens if the body explicitly runs inside `context.with(subagentSpan, body)`.

Both ends are needed. **The design is the bridge** — caller creates span + invocationKind-aware traceId strategy, then hands off via `runInSubagentSpanContext`.

### D2 — Hybrid traceId: foreground = child span, fork/background = new traceId + Link

| Invocation kind | Parent                      | TraceId                 | Why                                                                                                                                                                          |
| --------------- | --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foreground`    | child of caller's tool span | inherits parent traceId | OTel default; caller fully encloses callee temporally                                                                                                                        |
| `fork`          | linked root span            | new traceId             | Caller returns immediately; fork runs across multiple subsequent interactions. OTel spec verbatim recommends Link for this. Avoids inflating parent trace's duration / size. |
| `background`    | linked root span            | new traceId             | Same reasoning as fork.                                                                                                                                                      |

**Link payload**:

```ts
tracer.startSpan(
  'qwen-code.subagent',
  {
    kind: SpanKind.INTERNAL,
    links: [
      {
        context: invokerSpanContext,
        attributes: { 'qwen-code.link.kind': 'invoker' },
      },
    ],
  } /* explicit context = root, not inheriting active */,
);
```

Cross-trace queryability via session id: `gen_ai.conversation.id` is set on every subagent span (foreground and linked-root alike), so an ARMS query by `session.id` returns both the parent interaction's trace AND the linked-root subagent traces. The Link itself shows up in the parent trace's UI as "Spawned: subagent X (other trace)" so navigation works.

**Why not always-child**: 4-hour background subagent inflates the parent trace's wall-clock duration to 4 hours; trace size grows past several backends' caps (LangSmith's 25,000-run limit is the clearest documented bound). Foreground subagents that the user is actually waiting for don't have this problem because they're temporally enclosed.

**Why not always-linked-root**: foreground breaks the natural trace tree. A user prompt that runs a synchronous Explore subagent SHOULD show one tree, not two linked traces.

### D3 — TTL: type-aware, subagent fork/background = 4h, others = 30min

`session-tracing.ts:124` defines `SPAN_TTL_MS = 30 * 60 * 1000`. The sweep at `:144-152` already special-cases `tool.blocked_on_user` to stamp `decision: 'aborted' + source: 'system'`. It's already type-aware in spirit.

**Change**: introduce per-type TTL:

```ts
const SPAN_TTL_MS_DEFAULT = 30 * 60 * 1000; // 30min
const SPAN_TTL_MS_LONG = 4 * 60 * 60 * 1000; // 4h

function ttlFor(ctx: SpanContext): number {
  if (
    ctx.type === 'subagent' &&
    ctx.attributes['qwen-code.subagent.invocation_kind'] !== 'foreground'
  ) {
    return SPAN_TTL_MS_LONG;
  }
  return SPAN_TTL_MS_DEFAULT;
}
```

On TTL expiry, subagent spans get stamped:

```ts
{
  'qwen-code.span.ttl_expired': true,
  'qwen-code.span.duration_ms': age,
  'qwen-code.subagent.status': 'aborted',
  'qwen-code.subagent.terminate_reason': 'ttl_swept',
}
```

**Why not 30min flat**: legit long subagents (large repo analysis, slow builds, deep research tasks) get mis-stamped as TTL-expired. 4h covers the 99th percentile without being so loose that real hangs go undetected.

**Why not no-TTL**: process crash / OOM / kill -9 → span stays in `activeSpans` Map forever. The 30-min safety net protects against this; subagent fork/background just needs a wider window, not removal.

**Where 4h came from**: pragmatic upper bound for non-trivial agent tasks (long deep-research / large codebase analysis). Configurable via constant if production data shows we're wrong.

### D4 — LogRecord retention: keep emission, skip the LogToSpanProcessor bridge

`SubagentExecutionEvent` LogRecord has 3 downstream consumers (verified by repo audit):

| Consumer                                                                           | Position                                          | Action                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| OTel LogRecord → `LogToSpanProcessor` → bridge span `qwen-code.subagent_execution` | `loggers.ts:773` → `log-to-span-processor.ts:346` | **Skip this bridge** for the subagent event — new `qwen-code.subagent` span replaces it |
| QwenLogger RUM ingestion (Aliyun internal stats)                                   | `qwen-logger.ts:573-574`                          | Keep — RUM doesn't see OTel spans, only LogRecords                                      |
| `recordSubagentExecutionMetrics` Counter                                           | `metrics.ts:829`                                  | Keep — metric consumer is independent of trace bridge                                   |

**Bridge skip** (the only change to LogToSpanProcessor):

```ts
// log-to-span-processor.ts — inside onEmit, after deriveSpanName
const skipBridge = new Set<string>([
  EVENT_SUBAGENT_EXECUTION, // covered by native qwen-code.subagent span
]);
if (skipBridge.has(eventName)) return;
```

**Trace consumer impact**: dashboards that filter on span name `qwen-code.subagent_execution` start returning zero results. They should be updated to `qwen-code.subagent`. Note this in release notes.

**Why not delete the LogRecord**: it's the input to RUM and metrics. Deleting it is a 3-system refactor; out of scope here.

**Why not keep both**: trace would show two spans per subagent (`qwen-code.subagent` + `qwen-code.subagent_execution`) carrying overlapping info — confusing for operators reading traces, duplicate span volume.

### D5 — Span name + attrs: hybrid spec compliance, vendor-prefixed for extensions

**Span name**: `qwen-code.subagent` (matches Phase 1/2 codebase convention: `qwen-code.interaction`, `qwen-code.tool`, `qwen-code.hook`, …).

OTel GenAI spec says the canonical span name is `invoke_agent {gen_ai.agent.name}` — but **also** says "individual GenAI systems/frameworks MAY specify different span name formats." We use our own name and set `gen_ai.operation.name='invoke_agent'` so spec-aware tooling still identifies the span. Operators reading our trace tree see consistent `qwen-code.*` naming.

**Span kind**: `INTERNAL` (in-process subagent invocation, per spec).

**Attribute set**:

| Category                                                         | Attribute                                       | Source                                                               | Notes                                                                                                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Required spec**                                                | `gen_ai.operation.name='invoke_agent'`          | literal                                                              | spec-required                                                                                                                                                                    |
| **Required spec**                                                | `gen_ai.provider.name='qwen-code'`              | literal                                                              | spec-required; ambiguous for in-process agents (spec wrote it for LLM provider). Setting to `'qwen-code'` is the most honest interpretation                                      |
| **Required (dual-emit)**                                         | `gen_ai.agent.id` + `qwen-code.subagent.id`     | `agentContext.agentId`                                               | dual-emit until spec reaches Stable; remove vendor key later                                                                                                                     |
| **Required (dual-emit)**                                         | `gen_ai.agent.name` + `qwen-code.subagent.name` | `agentConfig.subagentType` (e.g. `Explore`, `code-reviewer`, `fork`) | same dual-emit                                                                                                                                                                   |
| **Recommended spec**                                             | `gen_ai.conversation.id`                        | `config.getSessionId()`                                              | enables cross-trace queries by session; co-exists with the existing `session.id` span attr (set globally per #4367) — both point at the same UUID, drop one when spec stabilises |
| **Recommended spec**                                             | `gen_ai.request.model`                          | model override if any                                                | only when subagent overrides parent model                                                                                                                                        |
| **Vendor**                                                       | `qwen-code.subagent.invocation_kind`            | `'foreground'` ❘ `'fork'` ❘ `'background'`                           | drives TTL + traceId strategy                                                                                                                                                    |
| **Vendor**                                                       | `qwen-code.subagent.is_built_in`                | bool                                                                 | dashboard filter                                                                                                                                                                 |
| **Vendor**                                                       | `qwen-code.subagent.parent_agent_id`            | parent ALS `agentId`                                                 | for nested subagents + cross-trace lineage                                                                                                                                       |
| **Vendor**                                                       | `qwen-code.subagent.depth`                      | parent depth + 1 (top = 0)                                           | recursion-bug detector                                                                                                                                                           |
| **Vendor**                                                       | `qwen-code.subagent.invoking_request_id`        | from `agentContext`                                                  | request-level correlation                                                                                                                                                        |
| **End-of-span spec**                                             | `error.type` (on failure)                       | error class                                                          | OTel standard                                                                                                                                                                    |
| **End-of-span spec**                                             | `exception.message` (on failure)                | `truncateSpanError(error.message)`                                   | OTel standard; reuses Phase 2 truncation                                                                                                                                         |
| **End-of-span vendor**                                           | `qwen-code.subagent.status`                     | `'completed'` ❘ `'failed'` ❘ `'cancelled'` ❘ `'aborted'`             | finer than OTel SpanStatus (which is OK / ERROR / UNSET)                                                                                                                         |
| **End-of-span vendor**                                           | `qwen-code.subagent.terminate_reason`           | from `SubagentExecutionEvent.terminate_reason`                       | e.g. `task_complete`, `max_iterations`, `user_abort`, `ttl_swept`                                                                                                                |
| **End-of-span vendor**                                           | `qwen-code.subagent.result_summary_present`     | bool                                                                 | "did subagent produce output" — bounded                                                                                                                                          |
| **Opt-in (sensitive)** gated on `includeSensitiveSpanAttributes` | `gen_ai.input.messages`                         | structured chat history                                              | reuses #4097's gate                                                                                                                                                              |
| **Opt-in (sensitive)**                                           | `gen_ai.output.messages`                        | model responses                                                      | same gate                                                                                                                                                                        |
| **Opt-in (sensitive)**                                           | `gen_ai.system_instructions`                    | system prompt                                                        | same gate                                                                                                                                                                        |
| **Opt-in (sensitive)**                                           | `gen_ai.tool.definitions`                       | tool schemas                                                         | same gate                                                                                                                                                                        |

**SpanStatus mapping**:

- `status === 'completed'` → `SpanStatus { code: OK }`
- `status === 'failed'` → `SpanStatus { code: ERROR, message: truncated(error.message) }`
- `status === 'cancelled'` or `'aborted'` → `SpanStatus { code: UNSET }` (matches Phase 2 convention)

**Why dual-emit on `id` + `name`**: spec is in Development (one step earlier than Experimental). `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` exists for opt-in. Spec attr names may rename before Stable. Dual-emit is the same pattern Phase 2 used for `call_id` → `tool.call_id`; remove the vendor key when spec reaches Stable.

**Why `qwen-code.subagent.*` (not `qwen.subagent.*`)**: every existing vendor-prefixed key in `constants.ts` uses `qwen-code.*` (`qwen-code.user_prompt`, `qwen-code.tool_call`, etc.). Internal consistency > OTel naming-convention preference, since operators query ARMS by prefix.

**Cardinality**: span attrs are not metric labels in OTel; UUID-keyed attrs (`id`, `parent_agent_id`, `invoking_request_id`) are safe at the span layer. Don't promote them to metric labels later.

**~10-15 attrs per span** (depending on invocation kind, failure, nesting). Same order as `qwen-code.tool`.

### D6 — `AgentContext.depth` field added directly

`AgentContext` (`agent-context.ts:32`) is **not exported** — only the helpers (`getCurrentAgentId`, `runWithAgentContext`, `getRuntimeContentGenerator`, `runWithRuntimeContentGenerator`) are. Zero TypeScript-level downstream breakage. The 6 known readers via `getCurrentAgentId()` only read `agentId`; adding `depth?: number` is invisible to them.

```ts
interface AgentContext {
  agentId: string;
  subagentName: string;
  invokingRequestId: string;
  invocationKind: 'spawn' | 'resume';
  isBuiltIn: boolean;
  depth?: number; // NEW — default 0 in readers
}
```

`runWithAgentContext` already uses `{ ...current, agentId }` spread, so `depth` survives existing call sites unchanged. **Update `runWithAgentContext` to auto-increment depth internally** — no caller needs to know about depth:

```ts
function runWithAgentContext<T>(agentId: string, fn: () => T): T {
  const parent = agentContextStorage.getStore();
  const next: AgentContext = {
    ...parent,
    agentId,
    depth: (parent?.depth ?? -1) + 1, // auto-increment
  };
  return agentContextStorage.run(next, fn);
}
```

Top-level subagent: no parent ALS → `depth: 0`. Nested: parent depth+1.

A new tiny accessor `getCurrentAgentDepth(): number` returns `agentContextStorage.getStore()?.depth ?? 0` — used by `startSubagentSpan` to populate `qwen-code.subagent.depth`.

**Why not a separate ALS just for telemetry**: would duplicate the same context shape we already maintain. Bad. Reuse the existing one.

## Helper API (`session-tracing.ts`)

```ts
// constants.ts
export const SPAN_SUBAGENT = 'qwen-code.subagent';

// session-tracing.ts
export interface StartSubagentSpanOptions {
  agentId: string;
  subagentName: string;
  invocationKind: 'foreground' | 'fork' | 'background';
  isBuiltIn: boolean;
  parentAgentId?: string;
  depth: number;
  invokingRequestId?: string;
  sessionId: string;
  modelOverride?: string;
  invokerSpanContext?: SpanContext; // required for fork / background (Link source)
}

export interface SubagentSpanMetadata {
  status: 'completed' | 'failed' | 'cancelled' | 'aborted';
  terminateReason?: string;
  resultSummaryPresent?: boolean;
  error?: string;
  errorType?: string;
}

export function startSubagentSpan(opts: StartSubagentSpanOptions): Span;
export function endSubagentSpan(
  span: Span,
  metadata: SubagentSpanMetadata,
): void;
export function runInSubagentSpanContext<T>(
  span: Span,
  fn: () => Promise<T>,
): Promise<T>;
```

`runInSubagentSpanContext` is the isolation primitive:

```ts
export function runInSubagentSpanContext<T>(
  span: Span,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = trace.setSpan(otelContext.active(), span);
  return otelContext.with(ctx, fn);
}
```

`startSubagentSpan` internally branches on `invocationKind`:

```ts
function startSubagentSpan(opts: StartSubagentSpanOptions): Span {
  const attributes = buildSpanAttributes(opts);
  const tracer = getTracer();

  if (opts.invocationKind === 'foreground') {
    // Child of current active span (caller's tool span)
    return tracer.startSpan(SPAN_SUBAGENT, {
      kind: SpanKind.INTERNAL,
      attributes,
    });
  }

  // fork / background: linked root span
  return tracer.startSpan(SPAN_SUBAGENT, {
    kind: SpanKind.INTERNAL,
    attributes,
    links: opts.invokerSpanContext
      ? [
          {
            context: opts.invokerSpanContext,
            attributes: { 'qwen-code.link.kind': 'invoker' },
          },
        ]
      : undefined,
    root: true, // forces new traceId; ignores active context as parent
  });
}
```

## Lifecycle wiring

### Foreground named (the common path)

```ts
// agent.ts:~2154
// Pull parent ALS frame to set parentAgentId on the span. The new child's
// depth is computed inside runWithAgentContext automatically (D6) — we
// read it via getCurrentAgentDepth() once we're INSIDE the child ALS
// frame. Two-step:
const parentAgentId = getCurrentAgentId();  // BEFORE entering child frame

// ... existing runFramed call enters runWithAgentContext(hookOpts.agentId, ...) ...

// INSIDE runFramed, we can read child's depth:
//   const depth = getCurrentAgentDepth();
//
// Practical placement: thread `depth` as a closure variable, set after
// runWithAgentContext takes effect — OR compute it as
// `(getCurrentAgentDepth() outside) + 1` from the caller side (simpler).
const depth = getCurrentAgentDepth();  // outside frame; child will be this + 1
// (set qwen-code.subagent.depth = depth in startSubagentSpan args)

const span = startSubagentSpan({
  agentId, subagentName, invocationKind: 'foreground',
  isBuiltIn, parentAgentId, depth, invokingRequestId, sessionId,
  modelOverride,
  // invokerSpanContext omitted — foreground inherits naturally via context.with
});
let metadata: SubagentSpanMetadata = { status: 'aborted' };
try {
  await runInSubagentSpanContext(span, () =>
    runFramed(() => this.runSubagentWithHooks(...)),
  );
  metadata = { status: 'completed' /* + resultSummaryPresent */ };
} catch (error) {
  metadata = {
    status: signal.aborted ? 'aborted' : 'failed',
    error: error instanceof Error ? error.message : String(error),
    errorType: error?.constructor?.name,
  };
  throw error;
} finally {
  endSubagentSpan(span, metadata);
}
```

### Fork (fire-and-forget)

```ts
const invokerSpanContext = trace.getSpan(otelContext.active())?.spanContext();
const span = startSubagentSpan({
  ..., invocationKind: 'fork', invokerSpanContext,
});
void runInForkContext(() =>
  runInSubagentSpanContext(span, async () => {
    let metadata: SubagentSpanMetadata = { status: 'aborted' };
    try {
      await runFramedFork();
      metadata = { status: 'completed' };
    } catch (error) {
      metadata = {
        status: signal.aborted ? 'aborted' : 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      endSubagentSpan(span, metadata);
    }
  }),
);
// AgentTool.execute returns FORK_PLACEHOLDER_RESULT immediately;
// span lives across subsequent interactions of the parent session.
```

### Background

Same shape as fork, with `invocationKind: 'background'` and `bgEventEmitter` instead of `eventEmitter`. TTL is 4h (same as fork — type rule from D3).

## Concurrent isolation — the headline guarantee

Three concurrent subagent invocations from one user prompt (model emits 3 AGENT tool_use blocks → `coreToolScheduler.runConcurrently` runs 3 `executeSingleToolCall` in parallel; each opens its own `qwen-code.tool` span per Phase 2):

```
qwen-code.interaction                         [traceId=T0]
├─ qwen-code.tool [agent call #A]
│  └─ qwen-code.subagent (A, foreground)     [traceId=T0, child]
│     ├─ qwen-code.llm_request
│     └─ qwen-code.tool [...]
│        └─ qwen-code.tool.execution
├─ qwen-code.tool [agent call #B]
│  └─ qwen-code.subagent (B, foreground)     [traceId=T0, child]
│     └─ qwen-code.llm_request
└─ qwen-code.tool [agent call #C]
   └─ qwen-code.subagent (C, fork)           [traceId=T1, linked root]
      └─ qwen-code.llm_request                [traceId=T1]
         └─ ...                               [traceId=T1, may emit hours later]
```

`context.with(span, runX)` for each of A, B, C runs concurrently. `AsyncLocalStorageContextManager` (already auto-registered by NodeSDK at `sdk.ts:273`) scopes per fiber; no cross-talk. Each subagent's child LLM / tool / hook spans see `span` via `context.active()` inside their own async chain.

Fork (C) is a separate trace — its child spans inherit `traceId=T1` even when emitted across multiple subsequent interactions of the parent session. ARMS query by `session.id` returns both T0 and T1; the Link from T1's root → C's invoking `qwen-code.tool` span provides explicit navigation.

## Files to change

| File                                                        | Change                                                                                                                                                                                        | LOC est |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/core/src/telemetry/constants.ts`                  | Add `SPAN_SUBAGENT`, `SPAN_TTL_MS_LONG`, attribute key constants                                                                                                                              | +8      |
| `packages/core/src/telemetry/session-tracing.ts`            | Add `startSubagentSpan` (foreground/linked-root branch), `endSubagentSpan`, `runInSubagentSpanContext`, types; extend `SpanType` union with `'subagent'`; extend TTL sweep with `ttlFor(ctx)` | +120    |
| `packages/core/src/telemetry/log-to-span-processor.ts`      | Skip-list to bypass bridging `qwen-code.subagent_execution`                                                                                                                                   | +6      |
| `packages/core/src/telemetry/index.ts`                      | Re-export new helpers + types                                                                                                                                                                 | +6      |
| `packages/core/src/agents/runtime/agent-context.ts`         | Add `depth?: number` to `AgentContext` + `getCurrentAgentDepth()` accessor                                                                                                                    | +12     |
| `packages/core/src/tools/agent/agent.ts`                    | Wrap 3 execution paths (foreground/fork/background) in `runInSubagentSpanContext` with try/catch/finally                                                                                      | +60     |
| `packages/core/src/telemetry/session-tracing.test.ts`       | New `describe('subagent spans')`: start/end, child vs linked-root, context propagation, depth, TTL per type, idempotent end, NOOP under SDK-uninitialized                                     | +120    |
| `packages/core/src/telemetry/log-to-span-processor.test.ts` | Assert skip-list short-circuits subagent_execution bridging                                                                                                                                   | +20     |
| `packages/core/src/tools/agent/agent.test.ts`               | End-to-end: 3 concurrent subagents each get isolated subtree; fork's spans inherit new traceId via Link; background lifecycle                                                                 | +80     |

Total: 9 files, ~430 LOC. Larger than typical Phase 2 commits but justified — TTL change touches a separate file, LogToSpanProcessor skip is a separate file, and the test files double up. Splitting would land an incomplete telemetry surface.

If review pushes back on size: split into 2 PRs — (A) telemetry helpers + tests, (B) `agent.ts` wiring + e2e tests. Helpers landed first don't change runtime behavior.

## Testing strategy

| Test                                                                         | What it proves                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `startSubagentSpan foreground parents to active OTel span`                   | Child-span path                                                 |
| `startSubagentSpan fork creates new traceId + Link to invoker`               | Linked-root path                                                |
| `runInSubagentSpanContext propagates span through awaits / Promise.all`      | Isolation primitive                                             |
| `3 concurrent subagent spans don't share children`                           | Headline concurrency guarantee                                  |
| `nested subagent records depth + parentAgentId`                              | Nesting metadata                                                |
| `endSubagentSpan status mapping (completed / failed / cancelled / aborted)`  | Status taxonomy                                                 |
| `endSubagentSpan dual-emits gen_ai.agent.id + qwen-code.subagent.id`         | Spec-compliance dual-emit                                       |
| `fork lifecycle: span survives AgentTool.execute return`                     | Fire-and-forget correctness                                     |
| `TTL: subagent fork stays past 30min, gets stamped + ended at 4h`            | Type-aware TTL                                                  |
| `TTL: foreground subagent at 30min gets default sweep`                       | TTL doesn't over-extend                                         |
| `LogToSpanProcessor skips qwen-code.subagent_execution but still RUM-emits`  | Bridge skip works                                               |
| `runConcurrently of 3 agent tool calls produces 3 distinct subagent spans`   | End-to-end at scheduler level                                   |
| `failed subagent sets exception.message + error.type + SpanStatus=ERROR`     | OTel-standard error path                                        |
| `opt-in attrs gated on includeSensitiveSpanAttributes`                       | Reuses #4097's gate correctly                                   |
| `startSubagentSpan returns NOOP_SPAN when SDK is uninitialized`              | Matches Phase 1/2 NOOP discipline; downstream calls remain safe |
| `fork span Link.context matches invoker tool span's spanContext`             | Cross-trace navigation works end-to-end                         |
| `runWithAgentContext auto-increments depth: parent=0, child=1, grandchild=2` | Depth bookkeeping is correct without caller cooperation         |

## Edge cases

| Case                                                                                                                    | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagent inside tool inside subagent (depth > 1)                                                                        | `depth` attr tracks; recommend soft `debugLogger.warn` at depth ≥ 5 (infinite-recursion detector)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Subagent spawned during a parent tool's `awaiting_approval`                                                             | Subagent span is a child of the AGENT tool span; the AGENT tool's `tool.blocked_on_user` is a sibling, not parent — both children of the AGENT tool span. Tree stays correct                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `signal.aborted` mid-subagent                                                                                           | `runInSubagentSpanContext`'s callback throws or resolves; `finally` sets `status='aborted'`, SpanStatus UNSET                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Fork still alive when parent session ends                                                                               | 4h TTL fires; sentinel attrs `qwen-code.span.ttl_expired:true`, `qwen-code.subagent.terminate_reason='ttl_swept'`, `status='aborted'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `endSubagentSpan` called twice                                                                                          | Idempotent — checks `activeSpans` map; second call no-ops (matches Phase 2 pattern)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Subagent's LLM call uses a different model from parent                                                                  | `gen_ai.request.model` set on subagent span; LLM-request sub-span ALSO records the model — no conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Sister subagent prelude throw escapes `attemptExecutionOfScheduledCalls`                                                | Lands in Phase 2's recently-fixed `handleConfirmationResponse` catch which is OUTSIDE the try — not attributed to confirmed tool's span. Subagent span correctly closes via its own try/finally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Concurrent fork + foreground from one parent                                                                            | Foreground inherits T0 traceId, fork gets T1. Both have correct context propagation independently. The parent tool span ends when its synchronous work returns; the fork span (separate trace) lives on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Fork span starts in caller sync flow but body runs later                                                                | `startSubagentSpan` is called BEFORE `void runInForkContext(...)` so the span (and its Link to the invoker) is captured while the invoker's spanContext is still readable. Span duration therefore includes any microtask-queue scheduling delay before the body actually starts — typically sub-ms; if production shows non-trivial gaps a separate `qwen-code.subagent.scheduling_delay_ms` attribute can be added (open question)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SDK not initialized (telemetry disabled)                                                                                | `startSubagentSpan` early-returns NOOP_SPAN (matches every other Phase 1/2 helper). `runInSubagentSpanContext(NOOP_SPAN, fn)` still calls `fn` normally. `endSubagentSpan(NOOP_SPAN, …)` is a no-op                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Fork's log-bridge spans (`tool_call`, `api_request`, etc.) use session-derived traceId while fork's native spans use T1 | Pre-existing behavior — log-bridge spans always use `deriveTraceId(sessionId)`, native spans use OTel context. The divergence is invisible inside one trace but means an ARMS-by-traceId lookup on T1 won't include log-bridge children of the fork. Out of scope for this PR; called out as open question #5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Foreground vs background `SubagentStart` hook span parents differ                                                       | Foreground fires `fireSubagentStartEvent` inside `runSubagentWithHooks` → already inside `runInSubagentSpanContext`, so the hook span parents under `qwen-code.subagent`. Background fires it BEFORE the `runWithSubagentSpan` wrapping (so the subagent span doesn't yet exist), so its hook span parents under the AGENT `qwen-code.tool`. Operators querying "hook spans under subagent spans" should expect bg `SubagentStart` to be missing from that view. Moving the bg hook fire inside `framedBgBody` is mechanically simple (the `contextState` mutation reaches `bgSubagent.execute` either way), but it changes user-visible semantics: today the hook fires synchronously before `AgentTool.execute` returns the "Background agent launched" message, so any synchronous setup work the hook does happens inside the user-blocking turn; moving it makes the hook fire detached after the launch message returns. Deferred pending a deliberate decision on which semantic is preferred |

## Rollback

The change is additive at the OTel level — existing dashboards that don't filter on subagent-related span names keep working. Trace consumers that group by parent span will see new `qwen-code.subagent` nodes between `qwen-code.tool` and `qwen-code.llm_request`; document in release notes.

Behavior-affecting change is the LogToSpanProcessor skip — dashboards previously consuming `qwen-code.subagent_execution` span return zero. Mitigation: keep the LogRecord intact (RUM + metrics still see it); only the span bridge is removed. Existing log-based queries unaffected.

Rollback path: revert the single PR. The new span helpers are only invoked from `agent.ts`; dropping the wiring + the LogToSpanProcessor skip restores prior behavior 1:1.

## Sampling implications

| Invocation                                       | Sampling decision source                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `foreground` (child span, same traceId)          | Inherits parent trace's sampled-or-not decision via parent-based sampler |
| `fork` / `background` (linked root, new traceId) | Independent sampling decision at root creation                           |

For qwen-code's current default (per `tracer.ts:shouldForceSampled()` — parentbased + always_on else always_on), every span is sampled, so the divergence doesn't bite. For deployments using probabilistic samplers (e.g. `traceidratio=0.1`), this means:

- A user prompt may be sampled (T0 fully captured) but its fork (T1) may be dropped, or vice versa.
- Operators reading parent T0 see "Link: subagent C (T1)" — clicking through may 404 if T1 was not sampled.

Mitigation: document for operators. If full subagent capture matters, force sampling for fork/background via a future config knob. Out of scope here.

## Sensitive attributes (#4097 integration)

Reuse the existing `includeSensitiveSpanAttributes` gate. When true, set on the subagent span at lifecycle hooks where the data is available:

| Spec attr                    | Source                                                     | When set                                                                                 |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gen_ai.system_instructions` | rendered system prompt from `agentConfig` / parent context | `startSubagentSpan` (if available before span open) or via `setAttributes` early in body |
| `gen_ai.tool.definitions`    | tool declarations available to the subagent                | same as above                                                                            |
| `gen_ai.input.messages`      | initial input passed to subagent (prompt + extraHistory)   | at start of body                                                                         |
| `gen_ai.output.messages`     | final response messages returned by subagent               | in `endSubagentSpan` metadata                                                            |

These are all already gated; #4097's pattern is to call `addSubagentSensitiveAttributes(span, opts)` helper from inside the body. Implementation detail — design just notes the integration point.

## Sequencing

- Independent of #4367 (resource attributes — in review). No merge-order constraint, but `gen_ai.conversation.id` on subagent spans benefits from #4367's `session.id` moved off resource. **Recommend landing #4367 first** so `getSessionId()` source-of-truth is settled.
- Independent of Phase 4 (LLM request decomposition / TTFT). Phase 4 attaches to `qwen-code.llm_request` spans regardless of whether they're under a subagent or an interaction. Recommend Phase 3 before Phase 4 so Phase 4's per-attempt metrics can be aggregated per-subagent.

## Open questions

1. **`gen_ai.provider.name`**: spec requires it but writes the description for LLM provider, not agent framework. Setting to `'qwen-code'` is best interpretation; if a future spec revision adds an `agent.provider.name` variant we should switch.
2. **Span name `qwen-code.subagent` vs spec `invoke_agent {name}`**: chose internal consistency. If GenAI-aware tooling adoption grows and `invoke_agent ${name}` becomes critical for auto-discovery, we can switch — span name is the most rebrandable thing in OTel.
3. **Soft-warn at depth ≥ 5**: arbitrary number. Could be a config knob. Defer until production data shows a need.
4. **`SubagentExecutionEvent.result`'s full LLM output is large**: today it bloats LogRecord volume. The migration plan (LogRecord → span events) is deferred but worth doing once token-usage aggregation lands in Phase 4.
5. **Log-bridge spans inside a fork end up on the session-derived traceId, not the fork's T1**: see edge cases. The fix is the broader "interaction span doesn't inherit session root context" issue raised in the sessionId-vs-traceId thread — a separate design that affects all native spans, not just subagent. Out of scope.

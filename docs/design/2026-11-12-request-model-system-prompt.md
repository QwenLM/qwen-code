# Resolve the main system prompt for the request model

[English](2026-11-12-request-model-system-prompt.md) | [简体中文](2026-11-12-request-model-system-prompt.zh-CN.md)

## Status and scope

Implemented and locally verified, 2026-11-12. Baseline source inspection uses main commit
`dd5f1d1b89ab5d1edd9087813b14fc65a0707863`. The reference implementation is tag
`v1.0.0-preview`, commit `587e3429cabf8cfb7c6be2d774ab63d0f36fe97e`.
Local verification results and remaining limits are recorded below.

Deliver one focused bugfix PR: resolve the main session's default system prompt
after selecting the model for an outgoing request. Reuse main's prompt content,
model routing, and provider adapters. Do not port preview's event bus, prompt
bundles, behavior policies, or section cache.

## Problem and baseline behavior

Before this fix, the main session builds its system instruction when a chat starts.
`getMainSessionBaseSystemPrompt()` reads `config.getModel()`, and `startChat()`
stores the assembled string in `LlmChat.generationConfig`. Later requests reuse
that string even when they target another model.

For example, a conversation started with `qwen3-coder` can send a later request
to `qwen3-vl` while still carrying the coder tool-call examples. Current
model-dependent content is primarily the examples selected by
`getToolCallExamples()`: qwen-coder, qwen-vl, gemma4, or general. Code mode and
`QWEN_CODE_TOOL_CALL_STYLE` can make this model difference irrelevant; tests must
not accidentally enable either when demonstrating the gap.

| Path                                       | Current behavior                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Local TUI model switch                     | The model-change listener refreshes UI state; it does not refresh the system instruction.                      |
| One-shot `/model <id> <prompt>`            | The request receives a model override and retains the chat's stored instruction.                               |
| Model fallback                             | Another generator/model serves the request with the stored instruction.                                        |
| ACP/serve model switch                     | Explicit refresh calls cover these switch handlers, but do not establish a request-wide invariant.             |
| Non-streaming default instruction          | `LlmClient.generateContent()` builds the default instruction before resolving the requested model's generator. |
| Explicit side-query/agent/fork instruction | The caller owns the instruction; replacing it with the main default would be a regression.                     |

Preview provides the useful ordering: select the model, then resolve the prompt
with that selected model. It also distinguishes assembled default prompts from
fixed user/agent bodies. Main can adopt those two properties locally.

## Required behavior

For every newly prepared main-session request using the default prompt, choose
model-dependent content using the target selected under the adapter's current
model semantics. Bind that selection and instruction in a preparation snapshot
before durability capture and dispatch. This PR covers selection before request
preparation; concurrent mutation of an already-running generator has a separate
limitation described under Delivery and tradeoffs.

- A normal model switch affects the next request, including a tool-result
  continuation that starts a new model request.
- A one-shot override or fallback uses examples for the adapter-selected target.
  A subsequent ordinary request uses the selected session model again.
- An HTTP retry or transport recovery on the same target retains the prepared
  instruction bytes. Moving to another fallback target creates another snapshot.
- Preserve history, source precedence, prompt layer order, tool-surface gates,
  output style, memory, and SessionStart additions.
- Explicit request instructions and saved prepared requests remain authoritative.
  Agent prompts and forked rendered prompts retain their fixed-body contract.

## Implementation

### 1. Give prompt rendering an explicit model

Add a model argument to the main-session prompt builder, defaulting to the
selected session model for existing callers. Pass that argument through to the
existing `getCoreSystemPrompt()` model selection. Never temporarily change
`Config.getModel()` or invoke model switching to render another variant.

Split instruction rendering from publication of the session's static cache
prefix. Render the complete instruction for the request model and publish the
stable prefix separately for the canonical session variant, preserving the
existing layer order:

1. Base prompt.
2. Media guidance.
3. Context files.
4. Appended system prompt.
5. Auto-memory.
6. Cached SessionStart context, when present.

The stable prefix still ends before auto-memory and SessionStart context.

Separate source loading and diagnostic dumping from the reusable render path.
Load file-backed full-system and identity overrides at startup and through the
existing explicit refresh lifecycle. Retain their literal text in a small
session-owned source snapshot; custom full-system bodies bypass default-template
rendering. Keep the existing public `getCoreSystemPrompt()` behavior through its
wrapper. The request path must not repeatedly read override files, write
`QWEN_WRITE_SYSTEM_MD` dumps, warm the tool registry, or execute hooks.

This is source ownership and rendering separation, not a new prompt-cache
framework. Do not add a persistent per-model cache, file watcher, configuration
flag, or new invalidation protocol. Render from the loaded source and current
in-memory session inputs at each new request boundary. Existing refresh entry
points continue to reload sources and perform their existing dump behavior.

### 2. Install a resolver only on the main chat

Give `LlmChat` a chat-local resolver installed through a separate internal setter
by `LlmClient.startChat()`. Keep the existing constructor call shape. The
resolver belongs to the chat instance; it must never enter
`GenerateContentConfig`, saved requests, or cloneable cache snapshots.

`AgentCore` and `createForkedChat()` do not install the main-session resolver.
An ordinary `LlmChat` with a fixed instruction retains its existing behavior.

Resolve instructions using this precedence:

1. A saved prepared request uses its saved instruction without reevaluation.
2. An explicitly supplied request instruction keeps the entry point's existing
   normalization and empty-value semantics.
3. A main chat with a resolver generates its instruction for the effective model.
4. Other chats use their stored generation configuration.

Keep source provenance explicit through resolver installation and the request
override decision. Do not infer ownership by matching or replacing prompt text.

### 3. Resolve at the common request boundary

Use one send-local preparation helper after the send lock is acquired and the
target generator configuration is known. Prepare the primary instruction before
tool-output pressure budgeting and initial compression, not only immediately
before the API call. Resolve its prompt model according to the existing adapter:

| Adapter                    | Prompt model at preparation                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI/QWEN_OAUTH          | Reuse `getRequestModel(actualConfig, model)`, including `samplingParams.model` and `extra_body.model` precedence.                                                                              |
| Anthropic/OpenAI Responses | Use `actualConfig.model`, which these adapters currently put on the wire.                                                                                                                      |
| Gemini/Vertex AI           | Use the request model, following the existing adapter.                                                                                                                                         |
| Qwen Subscription          | Follow its OpenAI pipeline: the request model, with a string `extra_body.model` override applied by the provider. Do not assume Chat's sampling-model override rule applies to this auth type. |

Keep this small adapter-aware selection helper next to the existing request-model
utility and cover it with wire tests. `getRequestModel()` alone is not a universal
wire-model resolver. Qwen Subscription delegates to the OpenAI pipeline through
`SubscriptionProvider`; cover that delegation as well. Do not change adapter
override support, route selectors, provider pins,
credentials, or telemetry model identifiers in this fix. For example, if an
adapter sends configured A despite a one-shot request naming B, the prompt follows
actual A; adding B support is a separate behavior change.

Keep the resolved instruction in request-local configuration and pass it through
the existing pending-request configuration to compression. Invalidate a changed
fixed-input anchor before pressure budgeting reads it.
`LlmChat.makeApiCallAndProcessStream()`, shared by normal and fallback streams,
consumes the prepared snapshot after selecting `actualConfig`; fallback uses the
same helper for its own target. A temporary target must not overwrite the chat's
canonical instruction or selected session model. Complete preparation before
`onPreparedRequest` so durability records the instruction that will be sent.

Reuse the prepared prompt within the current send for the same resolved target,
including outer transport-recovery attempts. A small send-local snapshot is
sufficient; it is discarded after the send. Fallback prepares a snapshot for its
own target. Preserve whether an instruction was caller-supplied independently
of these generated snapshots, so a generated primary instruction cannot be
mistaken for an explicit override on fallback. A resolver error ends preparation
before dispatch instead of sending a stale instruction or trying another model.
Fallback replaces the generated instruction in the current request configuration,
preserving output-token clamps and other recovery adjustments already applied.

For `LlmClient.generateContent()`, move default prompt resolution after
`resolveForModel()`, use the resolved generator configuration and model, and
build the instruction once outside its HTTP retry callback. Preserve the
existing explicit side-query prompt composition. `BaseLlmClient`'s purpose-built
side queries do not acquire the main prompt resolver.

### 4. Preserve SessionStart context and canonical snapshots

Retain the already-produced SessionStart addition as chat-local suffix state.
Use the existing suffix assembly rules for both fixed and resolved instructions:
exactly one trailing context block, with replacement rather than accumulation.
Startup, compact, refresh, and restore must maintain that state. Rebuilding a
request never executes SessionStart again.

`getGenerationConfig()` continues returning ordinary cloneable configuration.
For a resolver-enabled main chat, materialize its canonical instruction for the
currently selected session model, using that model's effective wire name. It
must not return the most recent temporary/fallback model's variant. Fixed chats
continue returning their stored configuration.

Separately retain the most recently dispatched request's resolved generation
configuration as a plain snapshot. Record it at actual dispatch after durability
preparation succeeds, rather than at rendering or canonical-getter time. Advisor
and fork tools invoked by that request use this snapshot: their executor context
and exact parent prefix describe the request that produced the tool call, even
when it used a temporary model. Keep the owning route/model with that snapshot;
do not pair its prompt with the canonical model or add it to shared global state.
Keep the cloneable generation configuration separate from the transient runtime
view that retains the selected generator. Copy that view's configuration with
the dispatched model rather than mutating the shared generator configuration.
A fork inherits this parent model and runtime view with its fixed prompt,
including background capacity accounting. This is transient chat state, not a
new persistence format. Existing canonical snapshot consumers retain their
session-model contract.

The same renderer supplies canonical snapshots and outgoing requests. When
preparing cache-sharing compression with an already-resolved pending request,
pass its resolved instruction through the existing `requestGenerationConfig`
slot. Keep the current cold compression prompt and same-route cache-sharing
eligibility rules; do not replace the compression task's instruction with the
main coding-assistant default.

### 5. Preserve cache and budget behavior

Publish `Config.staticSystemPrefix` only for the canonical session variant.
Rendering one-shot, fallback, or non-streaming temporary variants does not
replace it. Continue using Anthropic's existing exact-prefix check: a temporary
variant that does not match safely uses the existing single-system-block layout.
This PR accepts that temporary variants may miss the extra stable-prefix cache
breakpoint. It adds no request metadata field or provider-adapter change.

Before dispatch, compare the resolved fixed instruction against the instruction
used by the previous request. If it changed, invalidate the tool-budget usage
anchor and advance its fixed-input version before capturing the request version.
Preserve the existing protection against a late response or a setter during
backoff creating a current anchor for stale input. Merely reading a canonical
snapshot must not attribute temporary-request usage to the canonical prompt.

## Affected files and consumers

Line numbers below refer to the inspected main commit.

| Component                                                                      | Changes                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/core/client.ts`                                             | Explicit prompt-model argument (573), rendering/prefix publication split (2242), resolver installation (3041), non-streaming resolution order (6506).                                                         |
| `packages/core/src/core/llm-chat.ts`                                           | Chat-local resolver, retained SessionStart suffix (3327), preparation before budgeting/compression, common dispatch (5995), canonical getter (6969), dispatched-request snapshot, budget-anchor invalidation. |
| `packages/core/src/core/prompts.ts`                                            | Reuse existing rendering with loaded source text; keep file loading/dumping outside the per-request path. Keep example selection (1362) unchanged.                                                            |
| `packages/core/src/core/request-model.ts`                                      | Add the small adapter-aware prompt-model selector while preserving existing callers of `getRequestModel()`.                                                                                                   |
| `packages/core/src/tools/advisor.ts`, `packages/core/src/tools/agent/agent.ts` | Read the dispatched parent snapshot for active executor/fork context instead of the canonical session snapshot.                                                                                               |
| Collocated tests                                                               | Cover rendering, request target selection, fallback/retry/replay, snapshot ownership, and budget behavior.                                                                                                    |
| Design and E2E artifacts                                                       | This English/Chinese pair and a baseline/local E2E report under `.qwen/e2e-tests/`.                                                                                                                           |

The following existing consumers need regression coverage for the two snapshot
contracts:

| `getGenerationConfig()` consumer                        | Required behavior                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `client.ts:1706` → cache-safe params → fork/speculation | Cloneable canonical prompt paired with the selected session model.               |
| `tools/advisor.ts:110`                                  | Use the dispatched request's executor instruction and tool context.              |
| `tools/agent/agent.ts:2010`                             | Use the dispatched parent's fixed rendered prompt and matching route for a fork. |
| `agents/background-agent-resume.ts:1801`                | Persist literal configuration without executable callbacks.                      |
| `utils/btwUtils.ts:52`                                  | Preserve cloneable side-question snapshots.                                      |
| `services/chatCompressionService.ts:1022`               | Share the intended request prefix only under existing eligibility rules.         |
| `packages/cli/src/ui/commands/summaryCommand.ts:194`    | Preserve explicit inherited instructions.                                        |
| `packages/cli/src/ui/opentui/live-session.ts:863`       | Preserve tool visibility checks.                                                 |

Other boundaries to verify are the static chat constructors in
`agents/runtime/agent-core.ts:615` and `agents/forkedAgent.ts:233`, prepared replay
in `llm-chat.ts:3380`, and Anthropic's prefix handling in
`anthropicContentGenerator.ts:894` / `converter.ts:1153`. No daemon route, host
API, persisted schema, or CLI option is added. Runtime implementation is confined
to Core.

## Validation and acceptance

Use captured outgoing request bodies as the oracle. A model saying which model
it is, a UI label, or a resolver mock being called does not prove the right
instruction was sent. Use distinct example families and assert both the expected
family and absence of the previous family's examples.

| Scenario                                                              | Acceptance                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A → B → A in one TUI session                                          | Each next request carries its target's examples; history is retained.                                                                                                   |
| One-shot B while A is selected, on an adapter supporting the override | B receives its examples; the next ordinary request and canonical snapshot use A.                                                                                        |
| Primary A → fallback B → next primary A                               | Each target gets its own examples; fallback does not change session selection.                                                                                          |
| OpenAI sampling/extra-body model override                             | Prompt follows `getRequestModel()` and the actual wire model, including precedence.                                                                                     |
| Tool-result continuation after a model switch                         | The newly prepared request uses the new target's prompt without restarting the chat.                                                                                    |
| Same-target retry and transport recovery                              | Instruction bytes remain identical when prompt inputs such as memory/style change during backoff; concurrent generator-route mutation is the separate limitation below. |
| Non-streaming default vs explicit instruction                         | Default follows the resolved model; explicit task instructions retain existing composition.                                                                             |
| Custom system/agent/fork and tool-call-style override                 | Bodies and explicit style choices retain their existing ownership and precedence.                                                                                       |
| SessionStart, refresh, compact, restore                               | Hook context appears exactly once, and rendering causes no extra hook executions.                                                                                       |
| Prepared-request replay after a model/style change                    | Saved instruction is replayed unchanged; existing provider-pin checks still apply.                                                                                      |
| Canonical snapshot during/after temporary routing                     | Snapshot is cloneable and describes the selected session model.                                                                                                         |
| Advisor/fork invoked by temporary model B                             | Executor context and fixed fork prompt describe dispatched B; the canonical session snapshot remains A.                                                                 |
| Prompt change before pressure budgeting/compression                   | Old anchors are invalidated before use, and shared compression receives the resolved pending instruction.                                                               |
| Adapter uses configured model despite request override                | Prompt matches the captured wire model; this PR does not add override support to that adapter.                                                                          |
| Anthropic cache and changed fixed input                               | Canonical prefix remains usable, temporary mismatch safely falls back, and stale budget anchors are rejected.                                                           |
| Source I/O and deterministic rendering                                | Normal request preparation performs no repeated file reads/dumps; unchanged inputs produce byte-identical text.                                                         |

### Local results

`npm run build`, `npm run typecheck`, `npm run bundle`, and scoped ESLint passed.
Focused tests in the six changed test files passed all 2,034 cases. Another 328
tests passed for compression, fork cache/agents, agent runtime, and side-query
snapshots: 2,362 unit tests in total.

The E2E plan was first dry-run against global `qwen` version `0.18.5-preview.0`,
which reproduced the stale coder examples after a switch to the VL model. A
same-version `0.27.2` baseline also reproduced it. That control bundle used the
same checkout and dependencies with esbuild source-input substitution restoring
the six modified production modules to main commit `dd5f1d1b89`; it was not an
independently clean main worktree. Captured baseline requests used different wire
models but identical system bytes and coder examples.

The fixed `0.27.2` bundle passed 11 interactive PTY cases against an isolated
loopback provider with synthetic credentials: seven default-prompt cases
(A → B → A, one-shot B → A, forced fallback B → A) and four custom-system plus
appended-system cases. Each fallback group forced seven primary HTTP 503 attempts
before B succeeded. Default requests contained the actual target's example
family and excluded the other family. Custom instruction bytes stayed identical.
History was retained, and SessionStart context appeared exactly once with one
Hook execution per session. PTY automation replaced tmux, which was unavailable.

The ignored E2E plan/report is `.qwen/e2e-tests/request-model-system-prompt.md`;
raw request bodies, transcripts, Hook counters, and machine-readable assertions
are retained under `/private/tmp/qwen-request-model-verify-20261112/`. Post a
separate E2E report on the PR. Adapter selection, retries, replay, budgeting,
and snapshot ownership have focused unit coverage; live providers, other
protocols' native wire formats, Windows, and Linux were not locally E2E-tested.
The in-flight Qwen OAuth limitation below remains open.

## Delivery and tradeoffs

Suggested PR title: `fix(core): resolve system prompts for the request model`.
Keep the rendering changes, request wiring, regression tests, and bilingual
design together in one PR. Do not add a TUI-only refresh patch first: it would
leave one-shot and fallback requests outside the invariant.

The main implementation risks are retry snapshot drift, lost Hook context,
confusing canonical and dispatched-parent snapshots, and stale budget anchors. The request and snapshot
tests above are release criteria. Default prompt assembly adds local work at
request preparation; exclude file I/O, hooks, registry warming, and new caches
from that path. Optimizing temporary-model cache breakpoints can be considered
separately if measurements justify it.

Known limitation: Qwen OAuth model switching mutates a generator's configuration
in place, and its OpenAI pipeline reads that configuration again during retries
and after asynchronous credential loading. Changing a model override during an
already-running request can therefore change its wire target after prompt
preparation. A chat-level prompt snapshot cannot freeze that target. This PR
must not claim preview's stronger atomic model/prompt binding for this race.
Record it as a separate follow-up requiring a pinned wire-model contract at the
adapter boundary, with durability/retry coverage; do not silently widen this PR
into a routing rewrite. Validate ordinary switches between completed requests
here, and record in-flight generator mutation as an explicit remaining gap.

The implementation retains the ownership, precedence, and retry contracts above.
Submission requires two consecutive clean self-audit passes over the full diff
and a separate code review, in addition to the recorded checks.

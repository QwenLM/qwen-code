# Host tool invocation guard

## Status

Draft design for issue [#8102](https://github.com/QwenLM/qwen-code/issues/8102) and PR [#8032](https://github.com/QwenLM/qwen-code/pull/8032).

## Problem

An in-process embedding host can evaluate a model-proposed tool call through existing permissions and hooks, but those checks may run before Qwen Code has resolved the canonical tool name or built the final invocation parameters. A host that enforces organization policy therefore cannot prove that it evaluated the same call that reached `invocation.execute()`.

The missing primitive is a final execution-boundary decision over the effective tool call. Product-specific task state, approval workflows, policy storage, and audit transport do not belong in Qwen Code.

## Goals

- Let an in-process host provide one allow/deny function through `ConfigParameters`.
- Evaluate the canonical tool name and cloned final invocation parameters immediately before execution.
- Cover the core scheduler, ACP session runtime, and speculative execution paths.
- Fail closed when a configured guard denies, throws, returns a malformed decision, or cannot receive cloned arguments.
- Preserve the existing execution path when no guard is configured.
- Prevent execution if cancellation occurs before or while awaiting the guard.

## Non-goals

- No CLI flag, settings key, environment variable, daemon route, network client, or external policy transport.
- No task, plan, grant, business authorization, or audit schema.
- No change to permission, hook, sandbox, or approval-mode semantics.
- No claim that model planning or tool implementations become deterministic.
- No result callback or parallel tool-result protocol.
- No interception of an SDK consumer that manually calls `ToolInvocation.execute()` or `Tool.buildAndExecute()` outside a Config-owned runtime.

## Contract

The host supplies a `ToolInvocationGuard` in `ConfigParameters`. The guard receives:

- the runtime-accepted tool-call correlation identifier;
- the canonical tool name;
- a structured clone of the final invocation parameters; and
- the invocation abort signal.

The decision is either `{ allowed: true }` or `{ allowed: false, reason? }`. A missing or blank denial reason uses a stable generic message. Exceptions, malformed decisions, and clone failures use a separate stable failure message and deny execution. A supplied denial reason is user-visible and may enter existing tool-result and telemetry surfaces, so it must not contain secrets or raw provider errors.

The cloned arguments prevent a guard from mutating the invocation that Qwen Code will execute. The contract does not make arbitrary tool arguments secret; an embedding host must treat them as sensitive application data.

The tool-call identifier may originate in a model response. It is useful for
correlating the guard decision with existing lifecycle events, but it is not an
authenticated subject or a standalone idempotency key. A managed host that
needs strong identity must bind it to host-owned session and prompt identity.

## Execution placement

The core scheduler evaluates the guard after tool construction, permission handling, path normalization, and `PreToolUse`, but before the call changes to `executing` and before `invocation.execute()`.

The ACP session evaluates the same contract after tool construction, permission handling, and `PreToolUse`, but before its direct `invocation.execute()` path.

The experimental speculation engine also executes invocations directly instead of using the core scheduler. It evaluates the same guard after building the invocation and converts a denial or cancellation into a speculation boundary with zero executor calls. A future managed external-provider mode must disable speculative apply because copying an overlay into the real filesystem is a separate effect boundary outside `invocation.execute()`.

All three paths use the built invocation parameters rather than the model-provided draft arguments. In the core and ACP paths, a denial produces zero executor calls and a structured `execution_denied` tool result.

Any future Config-owned runtime that executes a `ToolInvocation` directly must evaluate the same guard or route through an already guarded scheduler. This is a code-review invariant, not a claim that arbitrary external callers can be intercepted.

Two agent-dispatch call sites — the `/fork` slash command and the ACP agent
fork handler — build and execute an agent tool invocation directly without
consulting the guard. The spawned subagent shares the caller's `Config`, so
every tool the subagent itself calls is guarded; only the dispatch call itself
is unguarded. A future change may extend the guard to these sites.

## Default-off compatibility

Qwen Code does not populate `toolInvocationGuard` in its CLI or daemon bootstrap. The field is an in-process embedding API only.

Each execution path reads the optional callback and enters the asynchronous evaluator only when the callback exists. When absent, Qwen Code performs no guard promise allocation, argument clone, provider call, capability advertisement, or additional asynchronous yield. Existing CLI and daemon deployments therefore retain their prior execution path.

The intentionally absent in-repository production setter means this change requires maintainer agreement on the public embedding seam before merge. A future external-provider change must remain a separate PR and cannot be assumed as part of this PR's approval.

## Cancellation and failure semantics

The evaluator checks cancellation both before invoking the guard and after its promise settles. Each execution path also checks its active signal immediately after the await and before any executor call.

- cancellation before evaluation: do not call the guard or executor;
- cancellation while awaiting a guard: record cancellation and do not call the executor;
- explicit denial: record `execution_denied` and do not call the executor;
- guard exception, malformed response, or clone failure: fail closed and do not call the executor.

There is no automatic retry. The guard callback owns any provider-specific retry policy, but an embedding host must not retry or execute an ambiguous side effect through this API.

## Evidence

The unit and integration tests cover:

- configured allow and deny decisions;
- default denial reason;
- guard exception, malformed response, and clone failure;
- argument mutation isolation;
- cancellation before and during guard evaluation;
- final normalized arguments in the core and ACP paths;
- speculative execution stops at a boundary on denial;
- zero executor calls on denial and cancellation;
- `execution_denied` parity between core and ACP tool-result records; and
- existing unconfigured execution through the surrounding scheduler and ACP suites.

No E2E plan is required for this PR because it adds no CLI, setting, daemon route, or other user-activatable behavior. Cross-platform CI remains required before merge.

## Follow-up boundary

A future external policy provider may extend the context with trusted runtime-owned session and prompt identity and adapt the in-process callback across the `qwen serve` to ACP child boundary. That follow-up must be default off, independently reviewed, and prove that an unconfigured CLI and daemon do not initialize a provider or change their child process environment.

Result observation should reuse existing structured tool lifecycle events unless a separate issue demonstrates a concrete correlation gap. Product-specific orchestration and policy remain outside Qwen Code.

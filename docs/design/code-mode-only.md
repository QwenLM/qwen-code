# CodeModeOnly MVP

## Status

Implemented for [#10377](https://github.com/QwenLM/qwen-code/issues/10377).
The feature is opt-in and defaults off.

## Goal

Add a `tools.codeModeOnly` setting that replaces the ordinary model-facing
tool surface with one `exec` JavaScript tool plus the small set of tools that
must remain direct control-plane calls. `exec` code can call ordinary tools
through `tools.<name>(args)` without bypassing Qwen Code's validation,
permissions, approvals, hooks, telemetry, cancellation, concurrency, or output
budgets.

Direct mode is a compatibility boundary: when the setting is false, tool
registration, deferred-tool behavior, provider requests, and execution remain
unchanged.

## Non-goals

- Hybrid direct/code exposure.
- Persistent cells, globals, or values between `exec` calls.
- Background jobs, `wait`, `yield`, `store`, or `load`.
- Raw/freeform provider calls.
- Making `tool_search` or a `tool_call` bridge available inside code mode.
- A Node.js-compatible sandbox.

## Configuration

```json
{
  "tools": {
    "codeModeOnly": true
  }
}
```

The setting resolves once to the effective `ToolMode` value `direct` or
`code_mode_only`. `ToolRegistry` and the execution surfaces consume that mode.
`exec` is only registered when the setting is enabled, so disabling the setting
also removes it from diagnostics and registry listings.

## Exposure policy

The registry remains the source of truth. Exposure is a view over registered
tools, never a second registry.

| Category                                   | Model top level   | `tools.*` inside `exec` |
| ------------------------------------------ | ----------------- | ----------------------- |
| `exec`                                     | CodeModeOnly only | No                      |
| Direct control                             | Yes               | No                      |
| Ordinary registered tool                   | No                | Yes                     |
| Hidden bridge (`tool_search`, `tool_call`) | No                | No                      |

The direct-control allowlist is centralized and deliberately small. It covers
user interaction (`ask_user_question`), delegation (`agent`), terminal output
contracts, plan/goal/task/team/worktree/session controls, and ACP host controls
whose lifecycle cannot safely be hidden behind an interpreted program. New
tools default to code-mode-callable; adding a direct-only or hidden tool
requires an explicit policy edit.

Deferred tools remain registered and callable from `exec`. Their full schemas
may be omitted from the generated `exec` description, but their names and
descriptions remain in `ALL_TOOLS`. CodeModeOnly skips deferred preload and
ToolSearch reminders because neither mechanism is part of its model-facing
protocol.

## Deterministic JavaScript interface

Before each provider tool sync, the `exec` description is generated from the
current registry. Tools are sorted by canonical name. A name is normalized to
a JavaScript property by replacing invalid identifier characters and prefixing
names that begin with a digit. If two canonical names normalize to the same
property, the lexicographically first name wins and one warning names the
omitted collision.

The description defines:

- a fresh async JavaScript execution environment;
- `tools.<normalizedName>(args)` for nested calls;
- `ALL_TOOLS`, including canonical and JavaScript names;
- `text(value)`, `image(value)`, `audio(value)`, and `exit()`;
- TypeScript-like signatures generated deterministically from JSON Schema;
- the absence of Node.js, imports, network APIs, timers, and persistent state.

The nested call returns a JSON-safe object containing the real call id, tool
name, status, output, and structured content. Failed and cancelled calls reject
the guest promise with the scheduler/ACP error.

## Sandbox and transport

`exec` runs QuickJS compiled to WebAssembly in a dedicated child process. Each
call creates a fresh QuickJS runtime and context. The child process receives a
small framed JSON protocol over stdio; it has no tool implementations or Qwen
configuration. The parent maps JavaScript names back to canonical registry
names and dispatches each call.

The guest has no Node globals, `require`, `process`, filesystem, sockets,
module loader, `console`, timers, `Atomics`, `SharedArrayBuffer`, or
`WebAssembly`. Dynamic and static imports fail because no module loader is
installed. Runtime memory and stack limits are fixed. QuickJS's interrupt hook
enforces a guest CPU budget. That budget and the parent's fallback watchdog
pause while the guest is suspended on registered host tools, whose own
scheduler/ACP timeouts remain authoritative, and resume before guest jobs run
again. This lets long builds keep their declared tool timeout without allowing
guest CPU loops to escape the fixed budget. Source, protocol frames, helper
output, and the final result are bounded.

Cancellation aborts every nested call and terminates the child. Settling the
top-level promise also cancels unawaited nested calls before teardown. No child,
timer, promise handle, or guest global survives the call.

The child receives a minimal sanitized environment and cannot inspect it from
the guest. The separate process is defense in depth for interpreter failures;
QuickJS/WASM is the guest capability boundary.

## Reentrant dispatch

`CoreToolScheduler.schedule()` cannot be called recursively: a child call would
queue behind its still-running parent and deadlock. Scheduler execution
therefore binds an async-local `ToolCallRuntime` context at the invocation
boundary. `exec` only talks to that context.

The scheduler runtime batches nested calls received in one event-loop turn and
runs them through a sibling scheduler configured from the same `Config` and
observers. This preserves the existing build/validation, permission,
confirmation, hook, execution, truncation, telemetry, and concurrency path
without direct `tool.execute()` calls. Sequential guest awaits produce
sequential batches; `Promise.all` calls enter one batch, where the existing
read-only concurrency classifier applies. Nested request ids include the parent
id and carry `source: code_mode` plus `parentCallId`.

Nested scheduler updates are merged into the owning scheduler's visible calls,
and confirmation responses for nested ids are delegated to it. The outer model
still receives only the completed `exec` response.

ACP keeps its existing independently audited execution chain. Its invocation
boundary binds the same runtime interface, with nested dispatch re-entering
`Session.runTool`. Thus ACP top-level and nested calls use the same ACP
permissions, approvals, hooks, telemetry, persistence, and cancellation rather
than borrowing CLI scheduler state or executing tools directly. ACP serializes
ordinary nested calls, matching its existing direct-tool ordering; the Core
scheduler retains its existing safe-read parallel batches.

## Provider behavior

All providers continue to consume `FunctionDeclaration[]` from
`ToolRegistry`. In Direct mode this array is byte-for-byte the existing view.
In CodeModeOnly it is the exposure-policy view, so Gemini/Qwen,
OpenAI-compatible, and Anthropic adapters all receive the structured `exec`
declaration without provider-specific prompting.

Filtered subagent declarations apply the same policy. For a read-only teammate
or a fork with an execution allowlist, `exec` is the audited gateway while the
exact allowed nested names are carried in its invocation context. The same set
generates the description and is checked again before Core dispatch, so an
explicit allowlist can narrow code-mode-callable nested tools without becoming
prompt-only policy, exposing a hidden bridge, or making `exec` recursive.
For cache-compatible forks, an inherited `exec` declaration represents its
ordinary bindings: an omitted `fork_tools` inherits them, while an explicit
list replaces them with the requested subset.

## Failure and rollback

Unknown, collided, hidden, direct-only, and recursively requested tools fail
closed before scheduling. Invalid arguments continue to fail in the normal
execution chain. A sandbox startup, protocol, timeout, memory, or teardown
failure becomes an `exec` tool error.

Rollback is setting `tools.codeModeOnly` to false. No session migration or
registry cleanup is required because code mode has no persistent state and the
ordinary registry was never replaced.

## Verification

Unit and integration coverage must include:

- Direct and CodeModeOnly exposure, deferred retention, collision handling,
  deterministic descriptions, and explicit subagent filtering.
- Valid/invalid JavaScript, async sequencing, `Promise.all`, helper output,
  thrown errors, CPU loops, memory limits, imports, unavailable globals,
  isolation, output limits, cancellation, unawaited work, and recursive calls.
- Nested permissions, confirmation, Pre/Post hooks, failures, output budgets,
  true-name telemetry/UI updates, MCP tools, and the scheduler deadlock
  regression.
- Gemini/Qwen, OpenAI-compatible, Anthropic, headless, interactive, subagent,
  and ACP surfaces.

The implementation is complete only after focused package tests, build,
typecheck, E2E probes, and two clean full-diff audit passes.

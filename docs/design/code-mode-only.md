# CodeModeOnly MVP

## Scope

Add an experimental `tools.codeModeOnly` switch. It defaults to `false`.
Direct mode remains the rollback path and keeps its current declarations and
deferred `tool_search` / `tool_call` bridge unchanged. When enabled, the model
sees a structured `exec({ source: string })` tool plus the audited direct-only
control surface. Ordinary tools remain registered but are callable only as
`tools.<name>(args)` inside `exec`.

This MVP deliberately has no hybrid mode, `wait`, cells, yielding, persistent
JavaScript state, or freeform provider wire format. `exec` waits for the whole
script to finish, fail, time out, or be cancelled.

## Reference facts

The implementation baseline is Codex `rust-v0.150.1`, commit
`90854393966b21e9ebfd21b122334eb09a20c93d`. At that revision Codex separates
registry membership from model exposure, deterministically compiles nested
tool declarations into the exec description, and sends nested calls through a
reentrant `ToolCallRuntime`. Its runtime is a V8 sandbox implemented in Rust.

Qwen Code does not ship that host and its existing workflow sandbox uses
`node:vm`, which is not a security boundary for model-authored JavaScript.
This design follows the behavior shape, not the Rust implementation.

## Effective mode and exposure

`Config.getEffectiveToolMode()` returns one of `direct` or `code_mode_only`.
A centralized planner assigns every registered tool one of four exposures:

- `code_mode_control`: `exec`; directly visible only in CodeModeOnly and never
  nested.
- `direct_only`: user interaction and control-plane tools whose semantics
  depend on a top-level model call or mutate the active session/turn.
- `code_mode_callable`: ordinary built-ins, MCP tools, and discovered tools.
- `hidden`: `tool_search` and `tool_call` in CodeModeOnly; neither direct nor
  nested.

The initial direct-only audit retains `ask_user_question`, `agent`, skill
activation, plan lifecycle, goal lifecycle, structured output, sub-session /
worktree lifecycle, and team/agent control tools. These either require a user
or host control interaction, change the active turn/session contract, or have
terminal semantics that an inner JavaScript result cannot faithfully carry.
The ACP Live provider-hosted screen, speech, and task tools also stay direct;
their registration is session-hosted and their live interaction contract is
not an ordinary nested tool operation.
Regular filesystem, shell, web, media, MCP, cron, monitor, artifact, and todo
tools are code-mode callable because the normal dispatcher preserves their
permissions, hooks, UI events, and output policy.

Direct mode continues to call `ToolRegistry.getFunctionDeclarations()` with
its existing deferred behavior. CodeModeOnly asks the planner for the stable
model-visible declarations. Registry entries are never removed because of
exposure. Startup and dynamic deferred-bridge reminders are also suppressed in
CodeModeOnly because the exec catalog is the only nested discovery surface.

## Exec description and catalog

The catalog is rebuilt from the warmed registry in stable canonical-name
order. Tool names are normalized to JavaScript identifiers by replacing
invalid characters with `_` and prefixing an invalid leading character. A
normalized-name collision is first-wins in stable order and produces a
warning; it never overwrites an earlier binding silently.

`ALL_TOOLS` contains stable `{ name, description }` entries for every nested
tool. Non-deferred tools also receive deterministic TypeScript-style
declarations generated from their existing JSON Schema. Deferred tools remain
present in `tools` and `ALL_TOOLS` but may omit their full declaration from the
description. `exec`, `tool_search`, `tool_call`, and direct-only tools never
enter the nested catalog.

## Runtime boundary

Each call creates a fresh Node worker and, inside that worker, a fresh QuickJS
WASM runtime/context. Model source is evaluated only by QuickJS. The worker
receives an empty environment and injects only `tools`, frozen `ALL_TOOLS`,
`text`, and `exit`. QuickJS receives no Node globals, module loader, filesystem,
network, `process`, `require`, `Buffer`, `console`, `Atomics`,
`SharedArrayBuffer`, or `WebAssembly`.

The QuickJS runtime enforces memory and stack limits plus an interrupt
deadline. The main thread independently enforces the wall timeout and turn
cancellation by terminating the worker, so a guest CPU loop cannot block the
host from cancelling it. Source, nested-call count, and final output are
bounded. When the top-level promise settles, the worker is terminated and all
unsettled nested calls are aborted; unawaited promises cannot outlive exec.
There is no `node:vm` or in-process fallback. A missing worker/WASM/runtime
fails closed.

The WASM package is pure JavaScript/WASM and supports Node 22 on macOS, Linux,
and Windows. The normal package build keeps the WASM beside its dependency;
the standalone esbuild worker embeds the exact WASM bytes with the repository's
existing `*.wasm?binary` plugin.

## Reentrant tool dispatch

`ToolCallRuntime` is the only callback accepted by exec. A dispatch request
contains the canonical nested tool name, JSON-object arguments, parent exec
call id, nested call id, and `source: code_mode`.

For interactive and headless Core execution, a nested call receives an
isolated scheduler lane. The lane is a new `CoreToolScheduler` instance sharing
the same Config, ToolRegistry, permission manager, hooks, telemetry, and UI
callbacks. It therefore executes the same validation, permission,
approval, hook, invocation, truncation, persistence, and lifecycle code as a
top-level call without re-entering the busy parent scheduler. A shared
read/exclusive concurrency gate lets safe reads run concurrently while
serializing unsafe tools. Nested approvals are routed back to the owning lane.

ACP binds the same `ToolCallRuntime` contract around its existing complete
`Session.runTool` chain and re-enters that method for nested calls. This keeps
ACP's existing permission queue, lifecycle emitter, and daemon semantics
rather than bypassing them with `tool.execute()`.

Tool errors reject the corresponding JavaScript promise. Parent cancellation
aborts every lane and terminates the worker. Only the outer exec response is
recorded and sent back to the provider; nested lifecycle/UI events and
telemetry retain the real tool name and correlation metadata. This avoids an
orphan function response for a tool call the provider never made.

## Provider compatibility

All providers continue to receive Google-style `functionDeclarations` from the
client. CodeModeOnly changes the declarations before provider conversion, so
Gemini/Qwen, OpenAI-compatible, and Anthropic adapters all receive the same
structured exec schema and direct-only list. Provider-specific raw/custom
tools are out of scope.

## Failure behavior

- Invalid source, parameters, unknown/forbidden tools, collisions, timeouts,
  cancellation, and worker/runtime failures return explicit exec errors.
- A nested tool result with an execution error rejects the JavaScript promise.
- Output is truncated deterministically at the exec boundary after existing
  per-tool scheduler truncation.
- CodeModeOnly never falls back to Direct or `node:vm` after runtime failure.

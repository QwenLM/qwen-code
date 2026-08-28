# Deferred Tool Call Bridge

## Problem

`tool_search` previously revealed each matched deferred tool and refreshed the
active model tool list. The refreshed list lets the model call the tool
directly on the next turn, but it also changes the request prefix after every
reveal. Providers can no longer reuse the prompt cache built for the earlier
prefix.

## Design

Keep the model-facing tool list stable by adding an always-visible
`tool_call` bridge. Deferred tool use becomes a two-step flow:

1. `tool_search` returns the matching tool's name, description, and parameter
   schema as informational output. It does not reveal the tool or refresh the
   active declaration list.
2. The model calls `tool_call` with the exact deferred tool name and arguments.

The existing deferred-tools startup reminder carries the compact live catalog
(names and short descriptions). Do not embed that catalog in either bridge
schema: `tool_search` and `tool_call` remain byte-stable even when MCP tools are
added, removed, or changed. Later catalog changes continue to arrive as tail
reminders rather than mutations to the model-facing tool declarations.

The core scheduler unwraps `tool_call` before permissions, approvals, hooks,
invocation guards, concurrency, telemetry, and execution. The ACP session
executor unwraps it before the corresponding per-call policies and execution;
its outer batcher remains conservatively sequential for bridge calls. The
headless CLI uses the resolved target for concurrency, progress, completion
tracking, and output finalization. Those consumers therefore receive the
underlying tool name and arguments. The function response sent back to the
model retains the bridge name and original call id so it still matches the
model-emitted function call.

The bridge accepts hidden deferred tools only. Eager, preloaded, and explicitly
visible tools must still be called directly. Unknown tools, bridge recursion,
and tools unavailable in the current subagent context are rejected before
execution.

## Compatibility

Existing reveal state remains in the registry for startup preloading,
explicitly visible tools, plan lifecycle setup, and replay of older histories
that contain direct calls to deferred tools. Only `tool_search` stops creating
new reveal state.

Disabling `tools.toolSearch` also disables `tool_call`; the existing fallback
continues to declare all deferred schemas eagerly. Permission allowlists keep
both bridge tools registered unless an explicit deny rule removes them.

## Verification

- `tool_search` returns schemas without calling `setTools()` or changing the
  declaration list.
- `tool_call` rejects malformed, unknown, visible, recursive, and
  context-forbidden targets.
- A valid bridge call runs the underlying invocation and applies its
  permission and hook identity while returning a `tool_call` function response.
- Direct calls and startup preloading continue to work unchanged.

# Deferred Tool Call Bridge

[English](deferred-tool-call-bridge.md) | [简体中文](deferred-tool-call-bridge.zh-CN.md)

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

Both halves resolve a requested name the same way, so the schema `tool_search`
returns is the tool `tool_call` invokes: a legacy alias is canonicalized first
(`search_file_content` → `grep_search`, `replace` → `edit`, `task` → `agent`),
then an exact registered match wins, then a single case-insensitive match
resolves. A name that matches several registered tools only by case resolves to
none of them — registration order decides nothing — and both halves refuse it:
`tool_search` reports it as ambiguous and lists the spellings that do resolve,
`tool_call` refuses and asks for the exact name. A tool that was never reviewed
in this session still resolves by name.

When `tool_search` returns a hidden deferred tool, it records a fingerprint of
that tool's invocation contract — its MCP server (empty for a built-in), the
name in its schema, and its `parametersJsonSchema`. `tool_call` recomputes the
fingerprint and refuses a hidden tool whose live value differs, telling the
model to re-run `tool_search` with `select:<name>`. A re-review overwrites the
record, so that loop closes in one round trip. The free-text `description` is
not part of the fingerprint: shipped deferred tools rebuild it from mutable
state on every `schema` access (`web_search` interpolates the current month,
`read_file` the effective input modalities), so hashing that prose would refuse
calls whose parameters still match the reviewed schema.

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

Startup preloading becomes opt-in: `tools.toolSearch.threshold` now defaults to
`0`. The gate shipped on by default because a reveal then rewrote the
declaration list and busted the prompt-cache prefix; a bridge reveal does not,
so always-defer is affordable and the extra `tool_search` round trip is the
only remaining cost. See
[ToolSearch preload threshold](toolsearch-preload-threshold.md).

In direct tool mode, disabling `tools.toolSearch` also disables `tool_call`;
the existing fallback declares ordinary deferred schemas eagerly. Tools demoted
by `tools.eager` stay hidden unless separately revealed, and a per-session
warning explains that the bridge is unavailable; a direct call by name still
undergoes normal validation and permission checks. CodeModeOnly instead hides
both bridge tools, keeps full nested schemas for callable deferred tools in
`exec`, and skips deferred reminders and this warning. Permission allowlists
keep both bridge tools registered unless an explicit deny rule removes them.

An explicit subagent `tools` list does not implicitly add the bridge tools.
Naming an ordinary deferred target declares it directly, but `tools.eager`
demotion still applies. Using discovery and bridge invocation together needs the target and both bridge
tools in the allowed surface; existing subagent exclusions and deny rules still win.
A resumed fork reconstructs the launching main session's live surface and
reapplies its persisted fork policy, independent of the wake-up caller's
ambient allowlist. Post-compaction file restoration unwraps successful bridge
calls only after matching their outer response IDs. ACP parameter-error loop
accounting uses a validated bridge target name; malformed envelopes retain
the wrapper bucket, and so does any refusal that resolves to no target — an
ambiguous name has no validated target to account against, so its strike lands
in the same `tool_call` bucket as a malformed envelope.

## Known limitations

`tool_call` records no per-session presentation mark. A hidden tool whose schema
never entered the active model context is still invocable by name, because the
startup reminder already lists every hidden deferred tool's name and
description, and only a tool `tool_search` returned in this session carries a
fingerprint to compare against. The declaration check therefore narrows the
name-only authorization boundary instead of closing it; the presentation-mark
half of the precondition proposed in #6721 remains open in #11321.

A change limited to a tool's `description` is not detected, deliberately: those
getters must keep recomputing so a long-lived process is not stale across a
month boundary or a mid-session model switch.

The fingerprint's only server component is the server's name label, so a
replacement server republishing identical tool names and schemas is accepted
with arguments written against the previous connection. Telling a connection
identity apart from a name label needs a channel the registry does not have
today; it is tracked in the #11321 discussion rather than approximated here.

Review records live on the registry instance and survive `/clear`: a stale
entry can only make `tool_call` ask for a fresh review, never let a changed tool
through. Removing a tool (MCP disconnect or disable, discovered-tool refresh)
replaces its retained declaration with a tombstone, which reclaims the
serialized schema while still forcing a re-review of anything re-registered
under that name.

## Verification

- `tool_search` returns schemas without calling `setTools()` or changing the
  declaration list.
- `tool_call` rejects malformed, unknown, visible, recursive, and
  context-forbidden targets.
- A valid bridge call runs the underlying invocation and applies its
  permission and hook identity while returning a `tool_call` function response.
- Direct calls and startup preloading continue to work unchanged.
- A legacy alias resolves to the same registered tool on both halves, and
  `select:` listing an alias plus its registered name reviews that tool once.
- A name matching several registered tools only by case is refused by
  `tool_call`, reported as ambiguous by `tool_search` with the resolvable
  spellings listed, projected name-only into the AUTO classifier transcript,
  and reviewed as two tools when both spellings are named explicitly.
- A hidden tool whose recorded fingerprint no longer matches the live one is
  refused until `tool_search` returns it again, including after an MCP
  disconnect/reconnect that republishes an identical declaration.

# Lazy Code Mode

[English](lazy-code-mode.md) | [简体中文](lazy-code-mode.zh-CN.md)

## Problem and scope

CodeModeOnly currently puts every callable tool's signature and description in
the initial `exec` declaration, including deferred tools. This removes the
prompt-size benefit of deferral. The existing `tool_call` bridge also describes
target arguments as a generic object; issue #12889 reports repeated empty
arguments with Responses providers. Code Mode lets the model express these
arguments as JavaScript, with ordinary runtime validation still enforced.

This change makes the existing experimental `tools.codeModeOnly` mode load
deferred descriptions and schemas through `tool_search`. Direct mode keeps its
current protocol. This extends the original CodeModeOnly MVP's scope.

## Design

### Declarations and execution

Expose `tool_search` at the top level alongside `exec` and existing direct
controls. Keep `tool_call` hidden. When search is available in the current tool
scope, include only eager or explicitly visible bindings in the `exec`
description, including its embedded metadata. Describe how to discover other
tools without listing their names or descriptions. Keep the complete binding
plan and runtime `ALL_TOOLS`: schema visibility does not grant execution rights.

When search is disabled or excluded from an agent's scope, retain full
signatures in that scope's `exec` declaration. This preserves access for existing
configurations. Use the existing deferred state, `tools.visible`, and
`tools.eager`; add no setting. Deferred preloading and startup tool-list
reminders stay disabled in CodeModeOnly.

### Discovery

Reuse ToolSearch keyword scoring, exact lookup, result limits, and JSON escaping.
In CodeModeOnly, search only tools in the current callable binding plan. Return
the original description and JSON Schema together with the actual normalized
JavaScript name and signature, and instructions to call it through `exec` in a
later turn. The raw schema remains authoritative for constraints that the
TypeScript-like signature cannot express. Direct-only and collided tools are
excluded from Code Mode discovery.

Search does not reveal tools in the registry or rewrite declarations. Its
results enter the conversation as tool output. With otherwise unchanged
configuration, searching and invoking deferred tools leave the provider tool
array unchanged. Provider cache hits remain subject to provider behavior.

### Invocation guidance and context compression

Describe `tool_search` as a separate top-level call, outside the JavaScript
runtime. Nested calls use the returned `jsName` exactly. Reuse schemas already
present in the current context; if a schema is missing after compression,
discover it again before constructing arguments.

In Code Mode, an exact-name miss explains that `select:` requires the registered
name, including the `mcp__<server>__<tool>` prefix for MCP tools, and suggests
keyword discovery without `select:`. Keep exact lookup semantics and scoped
visibility unchanged; the hint does not enumerate other tools. Direct mode
retains its current response.

Compression can replace earlier discovery results with a summary. Verify
rediscovery, execution and subsequent reuse after an actual history rewrite.
The declarations must remain stable across compression; history replacement
can reduce cache reuse, so observe the retained prefix and cache rebuilding
separately from ordinary append-only turns. Use the existing compression
pipeline without adding schema persistence or another recovery mechanism.

### Agent scopes

Treat search as a discovery gateway for a scoped agent, honoring explicit
disallowed-tool rules. Carry the same effective nested-tool allowlist used by
`exec` on search requests through the existing tool-call runtime context.
Filter both keyword and exact lookup against that scoped binding plan.
Permission-deferred tools remain eligible for an agent that is allowed to use
them. Search cannot broaden execution permissions.

The Core scheduler already owns scoped agent execution. The ACP session adapter
uses the shared exposure policy and unrestricted top-level registry; its nested
execution path remains unchanged. Forks inherit tool names and resolve current
declarations before running. Their execution allowlists also constrain discovery;
disallowing search produces full signatures for their allowed nested tools.

## Affected components

- `packages/core/src/tools/code-mode.ts`: exposure, signature formatting, and
  conditional description generation.
- `packages/core/src/tools/tool-registry.ts`: scoped discovery availability.
- `packages/core/src/tools/tool-search.ts`: Code Mode description and results.
- `packages/core/src/core/coreToolScheduler.ts` and
  `packages/core/src/agents/runtime/agent-core.ts`: scoped search context.
- Collocated tests and Code Mode runtime tests; settings documentation and its
  source schema descriptions.

## Constraints and validation

No new sandbox, provider adapter, persistent guest state, or alternate execution
path is introduced. Parameter validation, permissions, hooks, cancellation, and
output limits continue through the existing scheduler. Generated JavaScript can
still contain invalid arguments; this change requires real-model validation for
the reported provider combination.

Manual compression probes verified rediscovery and continued cache reuse, but
also exposed an existing summary-cleanup defect: a literal `<analysis>` quoted
inside the summary can cause its remaining text to be discarded while
compression is reported as successful. This can lose task state and requires a
separate compression fix. Stable tool declarations and cache hits alone do not
establish that the summary preserved the information needed to continue.

Acceptance criteria:

- Initial requests omit deferred names, descriptions, and signatures from `exec`
  when discovery is available; eager and visible bindings remain documented.
- Search returns complete tool information and a usable JavaScript name, then
  nested execution succeeds. Invalid arguments still fail validation.
- Search and nested calls do not change provider tool declarations.
- Exact and keyword discovery respect scoped allowlists, exclusions, unavailable
  tools, and normalized-name collisions. Disabled search falls back to full
  signatures for allowed tools only.
- Direct mode retains existing behavior. Build, typecheck, focused unit tests,
  deterministic CLI checks, and Responses model probes verify the change.
- Exact-name misses offer scoped-safe recovery guidance. After compression,
  missing schemas can be rediscovered and tools invoked and reused; actual
  request history and provider usage establish the cache behavior.

The E2E plan and results are kept in `.qwen/e2e-tests/lazy-code-mode.md`.
There are no open design questions for this first version.

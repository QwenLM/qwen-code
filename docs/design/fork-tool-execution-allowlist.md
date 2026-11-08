# Fork Tool Execution Allowlist

## Summary

Add an optional `fork_tools` parameter to the Agent tool's existing
`subagent_type: "fork"` runtime. The parameter narrows which tools a fork can
execute without changing the tool declarations sent to the model.

This is the first phase of #7625. Named profile files, shell argument patterns,
overlay filesystems, and `/btw` integration are out of scope. A launch-prompt
hint tells the fork which visible tools the allowlist permits.

## Goals

- Preserve the inherited fork execution surface when `fork_tools` is omitted,
  except for interaction tools that forks must never execute.
- Treat an empty list as deny-all rather than as the existing `tools: []`
  wildcard behavior.
- Keep the fork's current model-visible declarations unchanged so adding an
  execution restriction does not alter its prompt-cache prefix.
- Reject disallowed calls before tool construction, tool hooks, permission
  classification, scheduling, or approval.
- Preserve the restriction when a background fork is revived from its
  persisted sidecar.

## Parameter and Matching

`fork_tools` is valid only with an explicit `subagent_type: "fork"` and cannot
be combined with a named teammate. Every entry must be a non-empty string
without surrounding whitespace. Unknown exact names remain in the allowlist
and match nothing; they are not filtered away, because turning an invalid
non-empty list into an omitted restriction would fail open.

Built-in tools use exact canonical function names from the model-visible
declarations. MCP entries support exact canonical names plus server and
trailing-wildcard patterns. Patterns are matched against the registered tool's
raw MCP server/tool identity rather than only its provider-sanitized name, so
distinct server names that sanitize to the same prefix cannot cross-match.
Bare `*` is rejected; omission already allows every otherwise-executable
inherited tool.
Wildcard entries are limited to `mcp__*` or a trailing MCP tool-prefix pattern
such as `mcp__github__read_*`. `mcp__*` deliberately matches all MCP tools
without matching built-in tools.

Shell argument patterns are not part of this phase. Listing
`run_shell_command` allows the tool call to continue through the normal
permission pipeline but does not pre-approve its command.

## Runtime Separation

`ToolConfig.tools` remains the source for `AgentCore.prepareTools()` and the
function declarations on every model request. A separate
`executionAllowedTools` field is snapshotted when `AgentCore` is created.
Exact entries and MCP wildcard entries are precomputed separately so a tool
miss does not allocate or rescan unrelated built-in names.

`processFunctionCalls()` first verifies that a requested name is present in
the declaration set. It then applies the optional execution allowlist. A
disallowed call produces one synthetic error response with the original call
ID and name, while other calls in the same batch continue to the scheduler.
Because this check precedes scheduler construction, the rejected call cannot
open an approval prompt or execute a pre-tool hook.

The allowlist only narrows the existing surface. It cannot re-enable tools
removed by subagent exclusions, bypass normal permissions for an allowed
tool, or add declarations.

Every fork receives an in-memory execution allowlist, even when `fork_tools`
is omitted. The runtime-owned floor removes `ask_user_question` after applying
the caller-supplied list, so a caller cannot re-enable it. The tool remains in
the parent-derived declaration list for prompt-cache sharing, but a call is
rejected before scheduling or approval. A blocked fork reports the missing
input to its parent instead of trying to interact with the user directly.

The fork receives a restriction notice in the task prompt after the inherited
cacheable prefix. This avoids trial-and-error calls without changing the
parent-derived system instruction, history prefix, or tool declarations.

## Background Revival

Background forks persist inherited history in the `agent_bootstrap` transcript
record and the launch task prompt in a separate record. System instruction and
tool declarations are capabilities, so cold revival rebinds them from the
current parent runtime and resolves current tool names through the live
registry.

Caller-supplied `executionAllowedTools` is launch-time policy instead.
Restricted forks store it in the `AgentMeta` sidecar, including an empty
deny-all list, and cold revival reapplies it to the live `ToolConfig`. Forks
launched without `fork_tools` do not persist the derived list, allowing revival
to recompute it from the current parent tool surface. The resulting executable
surface is the current parent-derived tool surface narrowed by the persisted
policy and the mandatory interaction-tool exclusion.

The field remains optional for compatibility. Older transcripts and forks
launched without `fork_tools` restore with the current parent-derived tool
surface minus the mandatory interaction-tool exclusion.

## Boundary

`fork_tools` is supplied by the parent model or caller on each Agent tool call.
It is therefore a child-capability restriction, not a user- or
administrator-enforced security sandbox. A future profile layer can provide a
short, project-controlled policy name on top of this execution mechanism.

The restriction cannot be laundered through another child: fork execution runs
inside the fork runtime context, whose authoritative Agent-tool guard rejects
all sub-agent spawning. More generally, `fork_tools` cannot make an excluded
or undeclared tool executable.

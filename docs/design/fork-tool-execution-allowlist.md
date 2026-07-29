# Fork Tool Execution Allowlist

## Summary

Add an optional `fork_tools` parameter to the Agent tool's existing
`subagent_type: "fork"` runtime. The parameter narrows which tools a fork can
execute without changing the tool declarations sent to the model.

This is the first phase of #7625. Named profile files, prompt hints, shell
argument patterns, overlay filesystems, and `/btw` integration are out of
scope.

## Goals

- Preserve existing fork behavior when `fork_tools` is omitted.
- Treat an empty list as deny-all rather than as the existing `tools: []`
  wildcard behavior.
- Keep the fork's current model-visible declarations unchanged so adding an
  execution restriction does not alter its prompt-cache prefix.
- Reject disallowed calls before tool construction, tool hooks, permission
  classification, scheduling, or approval.
- Preserve the restriction when a background fork is revived from its
  transcript.

## Parameter and Matching

`fork_tools` is valid only with an explicit `subagent_type: "fork"` and cannot
be combined with a named teammate. Every entry must be a non-empty string.
Unknown names remain in the allowlist and match nothing; they are not filtered
away, because turning an invalid non-empty list into an omitted restriction
would fail open.

Built-in tools use exact canonical function names from the model-visible
declarations. MCP entries support exact canonical names plus server and
trailing-wildcard patterns. Patterns are matched against the registered tool's
raw MCP server/tool identity rather than only its provider-sanitized name, so
distinct server names that sanitize to the same prefix cannot cross-match.
Bare `*` is rejected; omission already represents unrestricted execution.
`mcp__*` deliberately matches all MCP tools without matching built-in tools.

Shell argument patterns are not part of this phase. Listing
`run_shell_command` allows the tool call to continue through the normal
permission pipeline but does not pre-approve its command.

## Runtime Separation

`ToolConfig.tools` remains the source for `AgentCore.prepareTools()` and the
function declarations on every model request. A separate
`executionAllowedTools` field is copied into an instance-local `ReadonlySet`
when `AgentCore` is created.

`processFunctionCalls()` first verifies that a requested name is present in
the declaration set. It then applies the optional execution allowlist. A
disallowed call produces one synthetic error response with the original call
ID and name, while other calls in the same batch continue to the scheduler.
Because this check precedes scheduler construction, the rejected call cannot
open an approval prompt or execute a pre-tool hook.

The allowlist only narrows the existing surface. It cannot re-enable tools
removed by subagent exclusions, bypass normal permissions for an allowed
tool, or add declarations.

## Background Revival

Background forks persist their launch-time system instruction, history, and
tool declarations in an `agent_bootstrap` transcript record. A restricted fork
also persists `executionAllowedTools` in that record. Cold revival restores
both fields into `ToolConfig`.

The field remains optional for compatibility. Older transcripts and forks
launched without `fork_tools` restore with no additional execution
restriction.

## Boundary

`fork_tools` is supplied by the parent model or caller on each Agent tool call.
It is therefore a child-capability restriction, not a user- or
administrator-enforced security sandbox. A future profile layer can provide a
short, project-controlled policy name on top of this execution mechanism.

# Workspace Agents API

## Goal

Expose the complete persisted subagent definition through daemon CRUD APIs,
while keeping prompt generation a generic workspace text-generation concern.

## Resource shape

Agent list entries expose all YAML frontmatter fields that affect execution:

- `name`, `description`, `level`, source/read-only metadata
- `tools` and `disallowedTools`, including MCP tool names
- `model`, `approvalMode`, `permissionMode`, `maxTurns`, and `color`
- MCP server names, Hook event names, `background`, and legacy `runConfig`

`GET /workspace/agents/:agentType` returns the same shape plus
`systemPrompt`, `mcpServers`, and complete `hooks`. MCP environment variables,
headers, and OAuth client secrets use the same `__redacted__` placeholders as
the settings API. The list intentionally omits those three potentially large
or sensitive values and returns `mcpServerNames` / `hookEvents` instead.
Existing summary fields remain for compatibility.

`POST /workspace/agents` and `POST /workspace/agents/:agentType` accept the
same persisted fields. The route validates optional values strictly before
writing; invalid API input returns `422 invalid_config` rather than being
silently dropped on the next disk read. Empty arrays and records are valid on
updates and clear the corresponding frontmatter field. `null` clears optional
scalar policy fields on updates.

Workspace-qualified routes use the same resource shape and validation, while
remaining project-scope only.

## Prompt generation

The create and edit pages send their prompt to `POST /workspace/generate`,
consume the standard workspace generation SSE envelope, and generate the
description and system prompt as two plain-text requests. This avoids coupling
the generic endpoint to an Agent JSON schema.

Generation is an optional dialog launched below the system-prompt field. Both
results stream into reviewable draft fields inside the dialog; cancelling
leaves the form untouched, while confirming copies both drafts into the form.
There is no separate generation mode in the persisted Agent resource.

The existing `POST /workspace/agents/generate` compatibility route remains
unchanged, but this UI does not use its structured
`{name, description, systemPrompt}` response. The name and execution policy
remain user-owned form fields; the generated description and system prompt are
both reviewable before saving.

The editor preheats the workspace ACP runtime before loading the tool catalog.
It obtains built-in tools from the workspace tools status, initializes MCP
discovery using the same polling flow as the MCP manager, and then loads MCP
tools from each workspace MCP server's tools endpoint. MCP tools are never
inferred from the workspace tools response, so the two sources remain distinct.

Allowed and disallowed tools use the same cascading picker: choose built-in or
MCP, choose an MCP server when applicable, then choose a canonical tool. The
selected tools remain visible as removable rows. Configured MCP servers use a
compact select-and-add control instead of free-form JSON or an expanded list.
An empty allowed-tool selection preserves the documented "inherit all tools"
behavior.

When the editor sends a selected server configuration back, the route restores
redacted MCP values from the effective workspace settings (or the existing
Agent during an edit) before writing. Responses remain redacted, so secrets do
not cross the daemon HTTP boundary.

## Compatibility

- Existing Agent CRUD fields and response fields remain valid.
- `hasTools` remains as a derived compatibility field.
- `runConfig.max_turns` remains readable/writable, while `maxTurns` is the
  canonical documented turn limit and wins at runtime.
- Existing Agent-specific generation endpoints and SDK helpers remain
  available for compatibility.

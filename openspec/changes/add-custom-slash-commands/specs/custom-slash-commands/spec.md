# custom-slash-commands — spec delta

## ADDED Requirements

### Requirement: Command file format and loading

The daemon SHALL load custom slash commands from two roots:

1. `<workspace>/.qwen/commands/*.md` (workspace source)
2. `~/.qwen/commands/*.md` (user source)

Each file SHALL contain YAML front-matter (between two `---` lines
at the top of the file) with at minimum the fields `name`,
`description`, and `scope`. The `name` value SHALL match the regex
`^[a-z][a-z0-9_-]{0,31}$`. The `scope` value SHALL be one of
`read`, `write`, `approve`, `bridge`. `owner` is forbidden as a
declared scope.

The file body (everything after the front-matter) SHALL be retained
verbatim as the command's prompt-template string.

#### Scenario: Valid command loaded

- **GIVEN** a file `.qwen/commands/triage.md` with valid front-matter
  declaring `name: triage`, `description: …`, `scope: write`
- **WHEN** the daemon starts
- **THEN** `GET /rc/commands` returns an entry with
  `name: "triage"`, `source: "workspace"`

#### Scenario: Owner-scope declaration rejected

- **GIVEN** a file declares `scope: owner`
- **WHEN** the daemon loads it
- **THEN** the file is skipped
- **AND** an audit event `slash_command_parse_failed` is written
  with reason `owner_scope_forbidden`

#### Scenario: Invalid name rejected

- **GIVEN** a file declares `name: "Has-Caps"` (uppercase)
- **WHEN** the daemon loads it
- **THEN** the file is skipped
- **AND** an audit event `slash_command_parse_failed` is written
  with reason `name_invalid`

#### Scenario: Parse error on one file does not block others

- **GIVEN** `.qwen/commands/good.md` is valid and
  `.qwen/commands/bad.md` has broken front-matter
- **WHEN** the daemon loads
- **THEN** `good` is registered
- **AND** `bad` is skipped with a parse-failure audit event

### Requirement: Hot reload

The daemon SHALL watch both command roots for file changes and
rebuild the in-memory registry within 500 ms of a write, debounced
to coalesce 250 ms bursts. A reload SHALL emit a `commands_reloaded`
SSE event on the global daemon stream so clients can refresh their
palettes without polling.

#### Scenario: Edit reflects in next listing

- **GIVEN** a registered command `triage` with description
  `"old desc"`
- **WHEN** the operator edits the file to set
  `description: "new desc"`
- **THEN** within 500 ms `GET /rc/commands` returns the new
  description
- **AND** all attached clients receive a `commands_reloaded` event

### Requirement: Naming precedence

When two command files declare the same `name`, the registry SHALL
select the winner by precedence: workspace > user > built-in. The
loader SHALL emit an audit event identifying the shadow:

- `command_collision_workspace_wins` (workspace shadows user or
  built-in)
- `command_collision_user_wins` (user shadows built-in)

The losing entries SHALL NOT appear in `/rc/commands`.

#### Scenario: Workspace shadows built-in

- **GIVEN** the built-in registry has a command `compact`
- **AND** the workspace has a file `.qwen/commands/compact.md`
- **WHEN** the daemon loads
- **THEN** `GET /rc/commands` returns the workspace `compact`
- **AND** an audit event `command_collision_workspace_wins` is
  written

#### Scenario: User shadows built-in

- **GIVEN** no workspace command for `usage`
- **AND** `~/.qwen/commands/usage.md` exists
- **WHEN** the daemon loads
- **THEN** the user version wins
- **AND** an audit event `command_collision_user_wins` is written

### Requirement: List endpoint

The daemon SHALL expose `GET /rc/commands` returning a JSON object
`{ v: 1, commands: [...] }` containing all visible custom commands.
Each entry SHALL include `name`, `description`, `scope`, `tool`
(nullable), `sessionScope`, `args` (nullable), `source`
(`workspace` | `user`), and `invocableByYou` (boolean computed per
caller).

The response SHALL carry `X-Commands-Revision: <hex>` where the
revision is a content hash of the registry; clients MAY use
`If-None-Match` to short-circuit polls.

#### Scenario: invocableByYou reflects caller scope

- **GIVEN** a registered command `lint` with declared scope `write`
- **WHEN** a read-scope token GETs `/rc/commands`
- **THEN** the response includes the `lint` entry with
  `invocableByYou: false`

- **WHEN** a write-scope token GETs `/rc/commands`
- **THEN** the response includes the `lint` entry with
  `invocableByYou: true`

#### Scenario: 304 on unchanged revision

- **GIVEN** a client has previously fetched with response
  `X-Commands-Revision: abc123`
- **WHEN** the registry has not changed and the client sends
  `If-None-Match: "abc123"`
- **THEN** the daemon responds `304 Not Modified` with no body

### Requirement: Invoke endpoint — prompt path

The daemon SHALL expose `POST /rc/commands/:name/invoke` accepting:

```jsonc
{
  "sessionId": "<id>",
  "args": ["positional..."],
  "named": { "key": "value", ... },
  "fileContext": "<workspace-relative path>"
}
```

For commands WITHOUT a `tool:` declaration, the daemon SHALL:

1. Reject with `403 Forbidden` if the caller's scope is below the
   command's declared scope.
2. Resolve placeholders `${arg}`, `${arg.N}`, `${args}`,
   `${named.<key>}`, `${file}` in the command body. Missing
   placeholders are replaced with empty string AND an audit event
   `slash_command_arg_missing` is written.
3. Submit the resolved string as a session prompt via the same
   internal path as `POST /session/:id/prompt`.
4. Write an audit event `slash_command_prompt_submitted` with
   `commandName`, `args`, `named`, `resolvedPromptText` fields.

The audit `resolvedPromptText` SHALL be visible only to owner-scope
subscribers via the `audit_event` SSE filter.

#### Scenario: Read-scope blocked

- **GIVEN** a command `triage` declared `scope: write`
- **WHEN** a read-scope token POSTs to
  `/rc/commands/triage/invoke`
- **THEN** the response is `403 Forbidden` with code
  `scope_required: write`

#### Scenario: Placeholder substitution

- **GIVEN** a command body `Triage issue ${arg}.`
- **WHEN** a write-scope token invokes with `args: ["1234"]`
- **THEN** the prompt submitted to the session is
  `Triage issue 1234.`

#### Scenario: Missing arg recorded

- **GIVEN** a command body `Triage issue ${arg}.`
- **WHEN** the caller invokes with `args: []`
- **THEN** the prompt submitted is `Triage issue .`
- **AND** an audit event `slash_command_arg_missing` is written

### Requirement: Invoke endpoint — direct-tool path

When a command's front-matter declares `tool: <name>`, the invoke
endpoint SHALL bypass the agent and invoke the named built-in tool
directly. The invocation SHALL still emit a `permission_request`
event (subject to workspace policy from `add-policy-engine` if
enabled). The tool's argv SHALL be derived from the resolved
template body, treated as a single argv string by default. Audit
event SHALL be `slash_command_tool_invoked`.

#### Scenario: Direct tool fires permission_request

- **GIVEN** a command `lint` with `tool: shell` and body
  `npm run lint`
- **WHEN** a write-scope token invokes it
- **THEN** a `permission_request` is emitted on the session SSE
  stream with `tool: "shell"`, `args.cmd: "npm run lint"`
- **AND** after approval, the tool runs and emits a tool-result
  event

#### Scenario: Direct tool skips the model

- **GIVEN** the same setup
- **WHEN** the command runs to completion
- **THEN** no `session_update` from the LLM is observed for this
  invocation
- **AND** no LLM tokens are consumed

### Requirement: Scope clamp on execution

Custom commands SHALL NEVER execute with a scope higher than the
caller's. The effective scope for execution is
`min(declared, caller)`. This rule SHALL apply uniformly to both
the prompt path and the direct-tool path.

#### Scenario: Caller cannot escalate

- **GIVEN** a command `lint` with declared scope `write`
- **WHEN** a read-scope token attempts to invoke it
- **THEN** the response is `403`
- **AND** the command does not execute under elevated scope

#### Scenario: Declared scope below caller is honored

- **GIVEN** a command `peek` with declared scope `read`
- **WHEN** an owner-scope token invokes it
- **THEN** execution proceeds with read-equivalent permissions only
  (no owner-only side effects are reachable from the body)

### Requirement: Capability advertisement

`GET /capabilities`'s `remoteControl` block SHALL include:

```jsonc
{
  "customCommands": {
    "enabled": true,
    "paths": ["<workspace>/.qwen/commands/", "~/.qwen/commands/"],
  },
}
```

Clients SHALL merge the custom palette with their built-ins only
when `enabled: true`.

#### Scenario: Capability present

- **WHEN** any token GETs `/capabilities`
- **THEN** the response's `remoteControl.customCommands.enabled` is
  `true`

### Requirement: Operator CLI

The CLI SHALL expose `qwen rc commands list` which prints registered
commands with columns `name | source | scope | tool | shadows`. The
`shadows` column SHALL indicate which lower-precedence command (if
any) is being shadowed by each entry.

#### Scenario: list shows shadowing

- **GIVEN** workspace defines `compact` shadowing the built-in
- **WHEN** the operator runs `qwen rc commands list`
- **THEN** the row for `compact` shows `shadows: builtin`

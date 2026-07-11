# Design — add-custom-slash-commands

## Context

`qwen-code` already has a built-in slash-command system implemented
inside the TUI. Built-ins are split: some are pure-client (`/mcp`,
`/plugin`, `/resume`) and some have cross-client effects (`/compact`,
`/clear`, `/context`, `/usage`) and are dispatched to the daemon as
`ui_command` events. `add-remote-control`'s `clients` spec captures
that split.

For user-defined commands, the daemon is the natural source of truth
because:

1. Every client (terminal, web, bridge sidecar) needs the same
   palette without duplicating discovery logic.
2. Workspace-rooted files match `QWEN.md`/`.qwen/` conventions
   already used for system prompts and tool config.
3. Hot-reload is a daemon job; we already do this for the policy
   engine and the rate table.

This change defines the file format, the loader, the discovery
endpoint, and the execution endpoint. Built-ins stay in the clients;
custom commands are merged on top.

## Goals / Non-Goals

**Goals:**

- Repo-tracked, plain-text commands editable without restarting the
  daemon.
- A single discovery API any client can hit.
- An execution API that runs the command server-side so all clients
  see the same outcome (transcript line, tool-call card).
- Scope clamp so custom commands cannot quietly grant more capability
  than the caller already has.

**Non-Goals:**

- Sandboxed scripting. The prompt is a template; placeholder
  substitution is the only computation.
- A marketplace.
- Signed commands.
- Versioning of command files (the repo handles that).

## Architecture

```
Workspace                            Daemon
─────────                            ──────
.qwen/commands/lint.md ───┐
.qwen/commands/triage.md ─┼──watch──▶ CommandLoader
                          │           │
~/.qwen/commands/foo.md ──┘           ├─▶ in-memory registry
                                      │   (workspace > user)
                                      │
                                      ├──── GET /rc/commands
                                      │     (scope-filtered listing)
                                      │
                                      └──── POST /rc/commands/:name/invoke
                                            │
                                            ├── if tool: → invoke tool directly
                                            │    (emits permission_request
                                            │     as normal; agent skipped)
                                            │
                                            └── else → substitute placeholders
                                                       in body, post as
                                                       session prompt via
                                                       internal call equivalent
                                                       to /session/:id/prompt
                                                       with audit annotation
                                                       `via_slash_command: true`
```

## File format

```markdown
---
name: lint
description: Run the project lint
scope: write # required: read | write | approve | bridge
tool: shell # optional: skip-agent direct tool call
sessionScope:
  required # optional: required | optional | none
  #   required: invoke must be on a session
  #   none:     invoke is workspace-level
---

npm run lint
```

Front-matter fields:

| Field          | Required | Notes                                                                                                            |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`         | yes      | `^[a-z][a-z0-9_-]{0,31}$`; uniqueness scoped to source.                                                          |
| `description`  | yes      | One line, ≤140 chars. Shown in palette.                                                                          |
| `scope`        | yes      | Minimum scope required to invoke. Cannot be `owner`.                                                             |
| `tool`         | no       | If set, name of a built-in tool. Bypasses agent.                                                                 |
| `sessionScope` | no       | Default `required`.                                                                                              |
| `args`         | no       | Array of `{ name, required, default? }` declarations for argument validation. If omitted, args are pass-through. |

Body: template string with placeholders:

- `${arg}` — first positional argument
- `${args}` — all positional args joined with spaces
- `${arg.N}` — Nth positional (0-indexed)
- `${named.foo}` — value of `--foo` flag from the invoke body
- `${file}` — sugar for current workspace-relative file context if
  the client supplies one

Substitution is plain string replacement. No nested templates, no
escape characters; missing placeholders are replaced with empty
string and a `slash_command_arg_missing` audit event is written.

## Discovery and invocation endpoints

### `GET /rc/commands`

```jsonc
{
  "v": 1,
  "commands": [
    {
      "name": "lint",
      "description": "Run the project lint",
      "scope": "write",
      "tool": "shell",
      "sessionScope": "required",
      "args": null,
      "source": "workspace"
    },
    { ... }
  ]
}
```

Filtering: callers with read scope see all commands but the response
flags `invocableByYou: false` for those above their scope. Clients
use this to gray-out unavailable commands rather than hide them.

### `POST /rc/commands/:name/invoke`

Request:

```jsonc
{
  "sessionId": "...", // required if sessionScope=required
  "args": ["1234"], // positional
  "named": { "branch": "main" },
  "fileContext": "src/auth/login.ts", // optional, fills ${file}
}
```

Two execution paths:

1. `tool: <name>` declared. Daemon calls the tool with the resolved
   arg string as the tool's input. Emits a `permission_request` for
   the tool just like an agent-initiated call (so workspace policy
   still applies — see `add-policy-engine`). On approval the tool
   runs; result is rendered as a tool-call card in the transcript.
   Audit logged as `slash_command_tool_invoked`.

2. No `tool:`. Daemon resolves placeholders, calls the same internal
   prompt-submission path as `POST /session/:id/prompt`. Audit
   logged as `slash_command_prompt_submitted` with the command name
   and the original args. The resolved prompt text is recorded in
   audit so the operator can audit what was actually sent to the
   model.

Response: `{ ok: true }` (and a `Location` header pointing to the
session if the command implicitly created one).

## Decisions

### D1 — Workspace > user > built-in precedence

**Choice**: A name collision resolves in favor of the most-specific
source. Workspace beats user beats built-in.

**Alternative considered**: Refuse to load on collision; error at
startup.

**Why**: Users who fork a repo with custom commands should be able
to override locally without renaming. Refusing-to-load makes the
daemon fragile (one bad command file breaks the palette).

**Cost**: A user can shadow a built-in (`compact`) and produce
surprise. Mitigation: audit event on every collision; `qwen rc
commands list` shows shadowed entries.

### D2 — Scope clamp, never elevate

**Choice**: `effectiveScope = min(declared, caller)`. A command
declared with `scope: write` invoked by a read-scope caller returns
`403`. A command declared `scope: read` invoked by a write-scope
caller runs with read scope's permissions during execution.

**Alternative considered**: Custom commands run with the declared
scope regardless of caller (sudo-style).

**Why**: Sudo-style is exactly the privilege-escalation footgun the
scope system is designed to prevent. If the workspace can elevate,
then any contributor with commit rights to the repo can write a
command that exfiltrates audit data on the next owner's invocation.

**Cost**: A workspace-trusted operator can't write commands that
"act as owner". Acceptable; owner-scope features are operator
concerns, not workspace concerns.

### D3 — Direct-tool path bypasses the agent

**Choice**: When `tool:` is declared, the daemon invokes the tool
directly without prompting the model. This saves tokens and
latency.

**Alternative considered**: Always route through the agent, treating
the prompt as "please call this tool with these args."

**Why**: Many operator commands are mechanical (`npm test`, `git
status`). Spending agent tokens to ask "please run the obvious
shell command I literally wrote" is wasteful. The direct path still
runs through the same `permission_request` flow and is audited.

**Cost**: Two execution paths to test. Mitigated by sharing the
post-permission tool-call dispatch with the agent's normal path.

### D4 — String substitution only, no scripting

**Choice**: Placeholders are plain string replacement.

**Alternative considered**: A small templating language (e.g.,
Handlebars), or expressions like `${arg | trim | lower}`.

**Why**: Templating engines are an injection-attack surface and a
maintenance burden. Plain substitution covers the 95% case and is
trivial to reason about.

**Cost**: Power users who want conditionals can chain commands or
ask the model to do the work. Acceptable.

### D5 — Loader is workspace-rooted, daemon enforces

**Choice**: Loader watches exactly two roots: `<workspace>/.qwen/
commands/` and `~/.qwen/commands/`. No env-var override, no extra
search paths.

**Alternative considered**: A `QWEN_RC_COMMAND_PATH` env var with
colon-separated paths.

**Why**: Predictable security boundary. Operator knows where
commands come from. Configurable search paths invite
trojan-via-env-var attacks.

**Cost**: An operator who wants project-shared commands across
multiple repos must symlink or duplicate. Acceptable.

## Threat model

| Attacker                                     | Capability                                          | Mitigation                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace contributor adds malicious command | Get other users to execute a destructive shell call | Custom commands cannot exceed caller scope; `tool: shell` still goes through `permission_request` (policy engine + human approval). Audit records the command name and resolved invocation. |
| Read-scope token invokes write command       | Run a write-level command                           | Scope clamp returns `403`; audit logs the attempt.                                                                                                                                          |
| Command shadows a built-in                   | Surprise behavior on `/compact`                     | Collision audit event on load; `qwen rc commands list` shows source priority.                                                                                                               |
| Front-matter parse failure                   | Daemon-wide palette breakage                        | Per-file loader; bad files are skipped with `slash_command_parse_failed` audit, palette continues to serve good files.                                                                      |

## Risks

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                                                               |
| ------------------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Operator forgets a workspace command is shadowing a built-in | M          | M      | Collision audit; palette renders shadow indicator.                                                                                       |
| File watcher fires on transient editor save sequence         | M          | L      | 250 ms debounce; idempotent reload.                                                                                                      |
| `${file}` semantics differ per client                        | M          | L      | Spec mandates client fills `fileContext` field; daemon trusts the value.                                                                 |
| Direct-tool commands skip the agent's safety prompts         | L          | M      | Permission flow still fires; policy engine still gates. Documented.                                                                      |
| Argument injection into shell tool                           | M          | M      | Direct-tool path uses the tool's argument shape, not bash-style string concat. Substituted args become a single argv element by default. |

## Open questions

1. **Should `args` declarations be enforced or advisory?** Leaning
   enforced: a command declaring `args: [{ name: issue, required:
true }]` should fail-fast with `400` if missing. This makes
   command authors document their inputs.

2. **Should the loader expose a versioned ETag on `/rc/commands` so
   clients can poll cheaply?** Leaning yes; emit a header
   `X-Commands-Revision: <hash>` and let clients short-circuit on
   match.

3. **`${file}` resolution.** Today the spec puts the responsibility
   on the client (it sends `fileContext`). An alternative is to let
   the daemon look up the current file context from session state.
   Cleaner if session state actually tracks a "current file" — which
   it does not today.

4. **Should we surface `slash_command_prompt_submitted` audit's
   `resolvedPromptText` to read-scope subscribers?** Probably yes
   (it's just what the model received), but it could be a
   reflection-of-sensitive-args concern. Conservative default: only
   owner sees the resolved text; lesser scopes see the command name
   and arg shape.

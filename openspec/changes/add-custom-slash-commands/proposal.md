# add-custom-slash-commands

## Why

Slash commands today are baked into the client binaries. `/compact`,
`/clear`, `/context`, `/usage`, `/mcp` are built-in; an operator who
wants a project-specific `/lint`, `/release-notes`, or `/triage` has
nowhere to put them. The Anthropic equivalent (`code.claude.com`
custom commands) puts them in repo-tracked markdown files, which
matches `qwen-code`'s philosophy: instructions live in
`QWEN.md`/`.qwen/`; the repo is the trust boundary.

`add-remote-control` introduced multiple symmetric clients (terminal,
web, future mobile) that all want the same slash palette. Hard-coding
the palette per client would force every change to ship in lockstep.
Instead, the daemon is the source of truth: a workspace folder of
markdown command files, read at daemon startup and hot-reloaded on
change, exposed via two endpoints. Every client (and every future
bridge) gets the same commands automatically.

## What Changes

- **File layout.** `<workspace>/.qwen/commands/*.md`. Each file is one
  command, with YAML front-matter declaring `name`, `description`,
  `scope` (which client scopes may invoke), and an optional `tool`
  (a built-in tool name to call directly, bypassing the agent). The
  body is the prompt template with placeholders `${arg}`, `${file}`,
  `${args}` (positional joined).
- **Reload.** File watcher with 250 ms debounce (same primitive as
  `add-policy-engine` and `add-cost-tracking`).
- **Endpoint.** `GET /rc/commands` lists declared front-matter for
  visible commands. `POST /rc/commands/:name/invoke { args }` runs
  the command — either by composing the resolved prompt and posting
  it as a normal session prompt, or by directly invoking the named
  built-in tool when `tool:` is declared.
- **Scope clamp.** A custom command's effective scope is
  `min(declared, caller)`. A read-scope caller invoking a
  `scope: write` command gets `403`. Custom commands NEVER acquire
  `owner` scope regardless of declaration.
- **Web and terminal palette.** Both clients merge built-ins with the
  result of `GET /rc/commands` and present a unified palette.
- **Naming.** Workspace > user (`~/.qwen/commands/`) > built-in.
  Collisions logged at load time as a warning audit event.

## Capabilities

### New Capabilities

- `custom-slash-commands` — file format and front-matter schema,
  loader and watcher semantics, `/rc/commands` listing endpoint,
  `/rc/commands/:name/invoke` execution semantics, scope clamping,
  collision precedence, client-palette merging, and the security
  model for the optional direct-tool path.

## User Stories

**SC1. `/lint` runs npm script.** I drop
`.qwen/commands/lint.md` in my repo:

```
---
name: lint
description: Run the project lint
scope: write
tool: shell
---
npm run lint
```

From any client palette, `/lint` invokes the shell tool directly.
The result is rendered as a tool-call card. The agent is not
consulted; this saves tokens.

**SC2. `/triage` synthesizes a triage prompt.** I drop
`.qwen/commands/triage.md`:

```
---
name: triage
description: Triage an issue
scope: write
---
Read issue #${arg} from the GitHub remote and propose:
1. likely root cause
2. minimal reproduction
3. files to investigate first
```

`/triage 1234` resolves to that prompt with `${arg}` = `1234`,
posts as a normal session prompt, agent responds.

**SC3. Read-scope caller blocked.** A read-scope partner-viewer
tries `/lint` from the web palette. The daemon returns `403`;
the palette grays out write-scope commands for read-scope tokens.

**SC4. Edit + reload.** I edit `.qwen/commands/triage.md`. Within
500 ms the palette refreshes; the next `GET /rc/commands` returns
the new description. No daemon restart.

**SC5. Collision warning.** Workspace defines `compact` (collides
with the built-in). Daemon writes a `command_collision_workspace_wins`
audit and prefers the workspace definition. Operator can rename or
remove the workspace file.

## Impact

- **qwen-code repo**: new module
  `packages/cli/src/serve/remoteControl/commands/` containing the
  loader, watcher, route, and execution dispatcher. Two endpoints
  added to the daemon.
- **Web client**: palette component reads `/rc/commands` and merges
  with its built-ins.
- **Terminal client**: same merge logic in the existing slash
  registry.
- **Capability advertisement**: `/capabilities` gains
  `remoteControl.customCommands: { enabled, paths }`.
- **No new dependencies**: YAML front-matter parsed with the same
  YAML library already used elsewhere; markdown bodies are kept as
  opaque template strings (no markdown rendering required server
  side).
- **Out of scope** (deliberately):
  - A marketplace, registry, or external sharing mechanism beyond
    git.
  - Encrypted or signed command files.
  - Templating beyond simple `${arg}` / `${file}` / `${args}`
    placeholder substitution. No Handlebars, no JS-eval.
  - Composing built-in slash commands inside a custom command body
    (e.g. a custom command that invokes `/compact` then sends a
    prompt). Future change.
  - Per-user (per-paired-client) command files. The two scopes are
    workspace and `~/.qwen/commands/` (single operator); not per
    paired client.

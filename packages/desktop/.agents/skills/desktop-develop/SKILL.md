---
name: desktop-develop
description: Develop, debug, and verify the OpenWork desktop/Electron app with an agent-readable harness. Use when working on packages/desktop, Electron renderer/main/preload code, desktop UI bugs, local desktop runtime failures, Chrome DevTools MCP investigation, desktop logs, messaging gateway issues, or when improving the development feedback loop for desktop features.
---

# Desktop Development Harness

## Overview

Use this skill to turn desktop work into a tight harness loop: gather runtime
context, reproduce with the UI and logs visible to the agent, make the smallest
fix, verify through the same path, and encode any missing affordance back into
the repo.

Read `references/harness-principles.md` when the task changes the development
workflow, observability, docs, tests, or agent-facing harness itself.

## Quick Context

For bug reports, UI failures, hangs, startup problems, messaging issues, or
anything involving the running desktop app, inspect the runtime logs directly.
Important paths:

- `~/Library/Logs/@craft-agent/electron/main.log`
- `~/Library/Logs/@craft-agent/electron/main.old.log`
- `~/.craft-agent/logs/messaging-gateway.log`

Search logs before guessing:

```bash
rg -n "error|warn|failed|exception|crash|Unhandled|rejection|browser-cdp|messaging-gateway" \
  "$HOME/Library/Logs/@craft-agent/electron/main.log" \
  "$HOME/.craft-agent/logs/messaging-gateway.log"
```

## Harness Loop

1. **Map the surface.** Identify whether the task touches Electron main,
   preload, renderer, shared desktop packages, server, messaging, or browser
   CDP. Read nearby code and tests before editing.
2. **Collect live evidence.** Read and tail the relevant log while reproducing.
   Treat missing or ambiguous logs as part of the bug.
3. **Drive the UI.** Use Chrome DevTools MCP when a browser/renderer page is
   involved: `list_pages`, `select_page`, `take_snapshot`, then console/network
   inspection. Prefer accessibility snapshots over screenshots for reasoning.
4. **Reproduce first.** For bugs, capture the exact observed behavior and the
   evidence that proves it. If reproduction differs from the user's report,
   compare environment, app state, build artifact, account, timing, and logs.
5. **Patch narrowly.** Keep changes scoped to the proven cause. Add structure
   only when it removes real repeated work or makes the app more readable to
   future agents.
6. **Verify through the same path.** Re-run the reproduction, inspect logs and
   DevTools again, then run focused tests/typechecks for touched packages.
7. **Improve the harness when needed.** If the fix required hidden knowledge,
   add a small doc, test, log field, or skill update so the next agent
   can see it directly.

## Running Desktop

Use desktop-specific commands from `packages/desktop`:

```bash
cd packages/desktop
bun run electron:dev
bun run electron:dev:terminal
bun run electron:dev:logs
```

Use `electron:dev:terminal` when the bug involves process output, startup, or
shutdown. Use `electron:dev:logs` when the app is already running and you need a
live log tail.

## Chrome DevTools MCP

If DevTools tools are not loaded, search for `chrome-devtools` tools first.
Then:

1. Call `mcp__chrome_devtools.list_pages`.
2. Select the relevant page with `mcp__chrome_devtools.select_page`.
3. Capture an accessibility snapshot with
   `mcp__chrome_devtools.take_snapshot`.
4. Inspect runtime failures with
   `mcp__chrome_devtools.list_console_messages`, then
   `mcp__chrome_devtools.get_console_message` for important entries.
5. Inspect selected network requests with
   `mcp__chrome_devtools.get_network_request` when network state is involved.
6. For memory issues, save a heap snapshot with
   `mcp__chrome_devtools.take_heapsnapshot` and keep it under `.qwen/` or
   `/tmp`, not in source directories.

Always take a fresh snapshot after each UI-changing action. Do not rely on stale
element ids or old console state.

## Focused Verification

Choose the narrowest checks that cover the touched surface:

```bash
cd packages/desktop && bun run typecheck:electron
cd packages/desktop && bun run typecheck:all
cd packages/desktop && bun run validate:dev
cd packages/desktop/apps/electron && bun run lint
cd packages/desktop/packages/shared && bun test path/to/file.test.ts
```

For root CLI/core changes, use the root repository commands from `AGENTS.md`
instead. For desktop-only changes, prefer desktop package commands first.

## Agent-Readable Changes

Favor changes that future agents can inspect and verify:

- Add structured log fields near failure boundaries instead of vague messages.
- Add accessible names or stable UI affordances when DevTools snapshots are
  hard to interpret.
- Keep docs as maps with links to deeper sources. Do not create giant manuals.
- Convert repeated manual debugging steps into docs, tests, or structured logs.
- Record non-trivial investigation notes in `.qwen/investigations/`.

Stop and ask the user only when the missing input cannot be discovered locally
and a reasonable assumption would risk changing the wrong behavior.

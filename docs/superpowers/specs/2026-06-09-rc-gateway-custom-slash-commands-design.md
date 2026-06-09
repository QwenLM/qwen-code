# Design — rc-gateway custom slash commands (cycle 20, part 1)

**Proposal:** `add-custom-slash-commands` (slice 1 of N).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## Goal of this slice

Repo-tracked, plain-text slash commands that any gateway client can
discover and run. Drop `<workspace>/.qwen/commands/triage.md` or
`~/.qwen/commands/foo.md`, then:

- `GET /rc/commands` lists declared command metadata (scope-filtered
  with an `invocableByYou` flag).
- `POST /rc/session/:id/command/:name` resolves the body template's
  placeholders and posts the result as a normal session prompt
  (reusing the cycle-7 `daemon.prompt()` path).

This delivers proposal stories **SC2** (prompt-composition command),
**SC3** (read-scope caller blocked), **SC4** (edit + reload — via
on-demand reads, no restart), and **SC5** (collision warning, audited
once).

## The gateway deviation (explicit)

`add-custom-slash-commands/design.md` is daemon-centric: it puts the
loader, watcher, and the two endpoints **inside the daemon**
(`packages/cli/src/serve/remoteControl/commands/`) and has the daemon
invoke built-in tools directly. Our hard invariant forbids editing any
file outside `packages/rc-gateway/`. So we deliver the **same
user-facing capability gateway-side**:

| design.md prescribes                                                       | this slice does                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon loads `.qwen/commands/` at startup + file watcher (250 ms debounce) | **Gateway** reads both command roots **on-demand** per request (always fresh → SC4 hot-reload is free; the debounced watcher is a deferred optimization)                           |
| Daemon endpoints `GET /rc/commands`, `POST /rc/commands/:name/invoke`      | Gateway endpoints `GET /rc/commands`, `POST /rc/session/:id/command/:name` (session in the URL → reuses our `requireScope`/`recordActivity`/`enforceSessionLock` session pipeline) |
| `tool:` path invokes a built-in tool directly, bypassing the agent         | **Deferred** — the SDK exposes no clean direct-tool-invocation API. A `tool:`-declared command lists with `invocableByYou:false`; invoking returns `400 direct_tool_unsupported`.  |
| Audit records `resolvedPromptText`                                         | We record `{name, sessionId, stopReason, argc}` — **never the resolved text** (see D3).                                                                                            |

No upstream file is touched. Workspace root comes from the unmodified
daemon's `capabilities().workspaceCwd` (the "1 daemon = 1 workspace"
root — used raw, NOT through cycle-19's `resolveChatsDir`, which builds
the _chats-storage_ dir, a different location).

## File format (this slice)

```markdown
---
name: triage
description: Triage an issue
scope: write # read | write | approve  (owner/bridge → file skipped)
tool: shell # optional; if present → not invocable this slice
sessionScope: required # optional; parsed, but invoke is always session-scoped
---

Read issue #${arg} and propose root cause, repro, and files to check.
```

Front-matter validation (a file failing any check is **skipped**, the
palette continues serving good files):

| Field          | Rule                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | required, `^[a-z][a-z0-9_-]{0,31}$`                                                                                                                   |
| `description`  | required, string, clamped to ≤140 chars                                                                                                               |
| `scope`        | required, one of `read`/`write`/`approve`. `owner` or `bridge` → **skip** (D2: a custom command must never grant owner; we have no bridge scope yet). |
| `tool`         | optional string (captured; renders the command non-invocable this slice)                                                                              |
| `sessionScope` | optional; captured for the listing, not enforced (invoke is always session-scoped by URL)                                                             |

Declared `scope` → gateway `RcScope` for gating:
`read→session:read`, `write→write`, `approve→approve`.

### Placeholder substitution

Plain single-pass string replacement over the body
(`/\$\{([^}]+)\}/g`); replacement values are **not** re-scanned (so a
value containing `${...}` cannot trigger nested expansion — no
injection). Unknown/missing placeholders → empty string.

- `${args}` → all positional args joined with a single space
- `${arg}` → first positional (`args[0]`)
- `${arg.N}` → Nth positional, 0-indexed
- `${named.KEY}` → `named[KEY]`
- `${file}` → `fileContext`

Invoke body: `{ args?: string[] | string, named?: Record<string,string>,
fileContext?: string }`. `args` as a string is split on whitespace.

## Endpoints

### `GET /rc/commands` — `requireScope(session:read)`

```jsonc
{
  "v": 1,
  "commands": [
    {
      "name": "triage",
      "description": "...",
      "scope": "write",
      "tool": null,
      "sessionScope": "required",
      "source": "workspace",
      "invocableByYou": true,
    },
  ],
}
```

`invocableByYou` **must mirror the actual invoke gate exactly** (else
the palette lies — it would show a command as runnable that then
403s/400s):

```
invocableByYou =
  caller has WRITE
  ∧ caller has mapped(declared scope)
  ∧ command has no `tool:`
```

Per the proposal, commands above the caller's scope are **listed**
(not hidden) so clients can gray them out.

### `POST /rc/session/:id/command/:name`

Pipeline (same order as the prompt route, plus the clamp in-handler):
`requireScope(WRITE)` → `recordActivity` → `enforceSessionLock` →
handler.

Handler:

1. Load commands; find by `:name`. Not found → `404 unknown_command`.
   (`:name` is only ever a registry-key lookup — never a filesystem
   path — so `../` simply misses → 404; no traversal surface.)
2. `command.tool` present → `400 direct_tool_unsupported`.
3. Declared-scope clamp: if caller lacks `mapped(command.scope)` →
   `403 insufficient_scope` (+ audit `scope_denied {required}`).
4. Resolve placeholders → `daemon.prompt(sessionId,
{prompt:[{type:'text',text:resolved}]}, signal)`. Abort wiring
   copies the prompt route exactly: abort on `res.on('close')` (NOT
   `req`), and `if (signal.aborted) return` after the await.
5. Daemon throws (and not aborted) → `502 daemon_unavailable`.
6. Success → audit `slash_command_invoked
{name, sessionId, stopReason, argc}`; respond `200 {stopReason}`.

## Decisions

### D1 — On-demand load; collision audit emitted at most once per name

The loader reads both roots fresh on every request (no watcher state to
go stale → SC4 for free). **But** a naive per-request collision audit
would flood the log. The single `CommandLoader` instance (built once in
`createGatewayApp`) holds a persistent `Set<string>` of names it has
already warned about; `command_collision_workspace_wins` is recorded
**once per colliding name** for the process lifetime, then suppressed.
Precedence (workspace > user) is resolved silently every read.

Parse-failure audit (`slash_command_parse_failed`) is **deferred** this
slice — bad files are skipped silently (still satisfies the
"one bad file doesn't break the palette" threat-model row). Adding the
once-per-path audit later is trivial (same memoization).

### D2 — Requiring WRITE to invoke is the _faithful_ translation, not over-protection

The proposal's D2 says `effectiveScope = min(declared, caller)` and a
`scope: read` command "runs with read scope's permissions." That
assumes the daemon can run a command under a downgraded permission
context. **Our gateway has exactly one execution path: post a prompt
via `daemon.prompt()`.** In our scope model `WRITE` _is_ the capability
"can cause a prompt to be posted to a session." Therefore invoking
_any_ command — even a `scope: read` one — exercises WRITE capability;
letting a read-only caller trigger it would be privilege escalation.
Requiring WRITE on the invoke route is the correct translation of the
scope system to the gateway, not an arbitrary tightening. The declared
scope is enforced as an **additional** gate (caller must also hold the
mapped declared scope). Consequence: a `scope: read` command needs both
`session:read` and `WRITE` to invoke — stated plainly so the behavior
isn't surprising.

### D3 — Resolved prompt text is never audited

The proposal wants `resolvedPromptText` in the audit "so the operator
can audit what was actually sent to the model," reasoning that a slash
command is a templating indirection the operator didn't type verbatim.
We **deviate**: cycle 7 established that the gateway never logs prompt
text (the `prompt_sent` audit excludes it), and a resolved command body
can embed `${named.*}` / `${args}` values that are exactly as sensitive
as a hand-typed prompt. We log `{name, sessionId, stopReason, argc}` —
enough to see _which_ command ran with _how many_ args, without
persisting message content. (Recovering the exact text later, if
wanted, is a conscious future opt-in, not a default.)

## Security notes for review

- Arg-injection into the prompt path is **moot**: any caller reaching
  the invoke route already holds WRITE and could `POST /rc/session/:id/
prompt` with arbitrary text directly. The command path grants no new
  capability — point the reviewer at the gating, not the templating.
- The real risk surfaces: (a) `invocableByYou` drifting from the actual
  route gate (palette lies / scope confusion); (b) the collision audit
  flooding; (c) `:name` ever reaching the filesystem (it must not).

## Deferred (NOT in this slice)

- `tool:` direct-tool invocation (no SDK API; lists non-invocable,
  invoke → 400).
- File watcher + 250 ms debounce (on-demand reads make it an
  optimization, not a correctness need).
- `slash_command_parse_failed` audit (files skipped silently for now).
- `args:` front-matter declarations / required-arg `400` validation.
- `slash_command_arg_missing` audit on empty substitution.
- `sessionScope: none` (workspace-level invoke) — our URL forces a
  session; all commands are session-scoped this slice.
- `X-Commands-Revision` ETag / cheap-poll header.
- Web + terminal palette UI (endpoints only this slice).
- Surfacing resolved text to owner-only subscribers.

## Verification

- vitest: loader (front-matter parse, name/scope validation, skip bad
  files, workspace>user precedence, collision-audit-once), substitution
  (each placeholder, missing→empty, no nested re-expansion), routes
  (GET shape + `invocableByYou` matrix across scope combos + tool
  commands; invoke 404/400/403/200; abort/disconnect; audit content
  excludes resolved text).
- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` extended: GET `/rc/commands` → 200
  shape against the real daemon's `workspaceCwd`; a workspace fixture
  command appears in the listing; invoke unknown command → 404; invoke
  without WRITE → 403.

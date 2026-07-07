---
title: 'Session Shell Permission Policy'
date: '2026-06-12'
status: 'implemented'
---

# Session Shell Permission Policy

## Problem

`POST /session/:id/shell` executes a shell command directly through the daemon,
without an LLM tool call or the normal agent permission mediation flow. Before
this change, the endpoint was a non-strict mutation and could be reached with a
daemon token plus a session id, or on the tokenless loopback developer default.

That is too much authority for a direct shell surface. A caller should not be
able to execute shell commands unless the daemon operator explicitly enables
the surface and the caller proves it is attached to the target session.

## Goals

- Disable direct session shell by default.
- Require explicit operator opt-in with `qwen serve --enable-session-shell`.
- Require bearer-token configuration before the opt-in becomes effective.
- Require a client id that is registered on the addressed session.
- Apply the same policy at the REST route, ACP HTTP dispatcher, and bridge
  execution sink.
- Keep normal agent shell tool approvals and permission mediation unchanged.

## Non-Goals

- Do not route direct shell through `PermissionMediator`.
- Do not change prompt submission, prompt queueing, or SDK pending prompt
  behavior.
- Do not add a shell-specific rate limiter.
- Do not add an environment-variable alias for the opt-in flag.

## Design

`runQwenServe` resolves and trims the bearer token once. After that it computes
one effective boolean:

```ts
sessionShellCommandEnabled =
  opts.enableSessionShell === true && token !== undefined;
```

That value is threaded into the bridge, REST app, and ACP dispatcher. Embedded
callers that invoke `createServeApp` directly compute token presence using a
non-empty string check so `token: ''` behaves like no token for both strict
mutation gating and shell capability advertisement.

The REST route uses `mutate({ strict: true })`. On a tokenless loopback daemon,
the strict gate returns `401 token_required` before the handler runs. When a
token is configured, the handler rejects disabled shell with
`session_shell_disabled`, then requires `X-Qwen-Client-Id`, then validates the
command body, and finally delegates to the bridge.

The ACP dispatcher keeps `_qwen/session/shell` dispatchable for old clients, but
does not advertise it in the initialize `_qwen.methods` list unless the
effective policy is enabled. Disabled ACP calls return a stable
`session_shell_disabled` JSON-RPC error without logging the command or calling
the bridge. Enabled calls still require the connection to own the session and
must use the bridge-stamped session binding client id.

The bridge enforces the final defense-in-depth check at
`executeShellCommand()`: disabled, missing client id, unknown session, then
unbound client id. Only after those checks pass does it publish shell events,
execute the command, or write shell history.

## Error Contract

REST:

- no token: `401`, `code: token_required`
- disabled: `403`, `code/errorKind: session_shell_disabled`
- missing client id: `403`, `code/errorKind: client_id_required`
- malformed or unbound client id: existing `400 invalid_client_id`
- unknown session: existing `404 SessionNotFoundError` mapping

ACP:

- disabled: `RPC.INVALID_REQUEST`, `data.errorKind: session_shell_disabled`
- missing session binding client id: `RPC.INVALID_REQUEST`,
  `data.errorKind: client_id_required`
- unowned session and invalid client id keep existing JSON-RPC mappings

## Compatibility

`DaemonSessionClient.shellCommand()` continues to work when the daemon is
explicitly enabled and authenticated because the session client carries the
session-bound client id. Bare `DaemonClient.shellCommand(sessionId, command)`
must pass `opts.clientId`, otherwise it receives `client_id_required`.

## Test Coverage

The implementation is covered by focused bridge, REST, ACP transport, serve
boot, and command-parser tests. The highest-value checks are default-disabled
behavior, tokenless strict gating, capability advertisement, ACP initialize
method filtering, bridge sink enforcement, and propagation of the session-bound
client id.

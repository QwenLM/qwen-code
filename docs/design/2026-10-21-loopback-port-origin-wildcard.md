# Loopback port wildcard for `--allow-origin`

[English](2026-10-21-loopback-port-origin-wildcard.md) | [简体中文](2026-10-21-loopback-port-origin-wildcard.zh-CN.md)

- Status: implemented
- Date: 2026-10-21
- Issue: [#14939](https://github.com/QwenLM/qwen-code/issues/14939)

## Problem

The desktop client serves its own Web Shell from its bundled daemon at
`http://127.0.0.1:<OS-assigned port>`. Every request it makes to a remote
`qwen serve` daemon is therefore cross-origin with a page origin that changes
on every launch. `--allow-origin` matches canonical origins exactly, so no
fixed entry can name that origin. With a static entry every
`OPTIONS /capabilities` preflight returns `403` and the connect gate retries
forever.

`--allow-origin '*'` unblocks the REST API but not the WebSocket upgrade gate,
which deliberately ignores the any-origin literal. Terminal and voice channels
therefore stay broken even under `*`. Before this change there was no
configuration that made the desktop's remote-daemon flow work.

## Current behavior

- `parseAllowOriginPatterns` accepts `*` or a canonical origin and matches by
  exact scheme, host, and port string equality.
- Two origin-stripping shims run ahead of the CORS wall. One requires the
  request port to equal the daemon's own port; the other requires a genuine
  same-origin request against the daemon's `Host`. Both miss the desktop page
  origin.
- The WebSocket CSRF gate consults the static origin set only, so `*` does not
  apply there.

## Goals

- Let the desktop client reach a remote daemon without `--allow-origin '*'`.
- Apply the same admission rule to the REST CORS gate and the WebSocket gate.
- Keep the bearer token as the authentication boundary.

## Non-goals

- Host or subdomain wildcards.
- Changing what `*` means, or making `*` apply to the WebSocket gate.
- Same-origin navigation of the desktop webview to the remote daemon (the
  larger design option in the issue).
- Any desktop client code change.

## Syntax

`--allow-origin <scheme>://<loopback-host>:*`

- Scheme is `http` or `https` and must match the request origin.
- Host must be a loopback host (`127.0.0.0/8`, `localhost`, or `[::1]`) and
  matches exactly. `127.0.0.1`, `localhost`, and `[::1]` are distinct entries.
- The entry must not also name a port; the wildcard replaces it.
- A bearer token must be configured. A tokenless loopback daemon refuses to
  boot with a wildcard entry, matching the existing `*` guard: otherwise any
  local page on any port could drive the daemon.

Example: `qwen serve --hostname 0.0.0.0 --token <token> --allow-origin http://127.0.0.1:*`

## Implementation

- The parser stores wildcard entries separately from exact origins; a malformed
  or non-loopback wildcard raises the existing `InvalidAllowOriginPatternError`
  with a specific reason.
- `allowOriginMatches` is the REST matcher: `*`, exact origins, then loopback
  wildcards. `originIsExplicitlyAllowed` is the WebSocket matcher: the same
  explicit entries without `*`.
- Both `runQwenServe` and the embedded `createServeApp` enforce the token
  requirement, so callers cannot bypass it by constructing the app directly.
- The MCP App sandbox's `hostOrigin` trust callback uses the same allowlist.
  A wildcard entry therefore also lets a page from that loopback host embed the
  pre-auth sandbox document. That document carries no bearer and no data; the
  data-mode resource is still minted by an authenticated route.

## Security

- The wildcard admits any page served from that exact loopback host, on any
  port. The bearer remains mandatory on every API route, `Origin: null` is
  always rejected, and non-loopback hosts cannot be expressed by the new form.
- `*` keeps its current behavior and stays REST-only for WebSocket upgrades.
- Residual risk: a local page that already holds the bearer can read responses,
  which is the same principal model as any other allowlisted browser origin.
  The change does not create an authentication bypass.

## Validation

- Parser and matcher unit tests, including IPv6, `localhost`, scheme mismatch,
  `Origin: null`, non-loopback hosts, explicit ports, and scheme-default ports.
- A `runQwenServe` regression test boots with the wildcard and asserts
  `204` + `Access-Control-Allow-Origin` for an ephemeral loopback origin, plus
  a tokenless-bind refusal test.
- A WebSocket test derives the parsed allowlist through the parser and asserts
  `101` for the wildcard origin and `403` for wrong-host, wrong-scheme, and
  non-loopback origins.
- Runtime check on macOS: before, a static entry returned `403` and `*` returned
  `403` on the WebSocket; after, the wildcard returned `204` on REST and `101`
  on the WebSocket, with `localhost` and non-loopback controls still `403`.

## Acceptance criteria

- The documented remote-daemon flow works from the desktop client with
  `--allow-origin http://127.0.0.1:*` and a bearer token.
- A tokenless daemon refuses that entry at boot.
- Non-loopback hosts, `Origin: null`, and non-matching schemes/hosts stay
  rejected.
- `*` behavior is unchanged, including the WebSocket gate.

## Follow-ups

- Desktop E2E on Windows against a remote daemon, which needs the desktop
  binary and cannot run in this repository's unit environment.
- Same-origin navigation (the issue's option 3) remains a separate design if
  the loopback wildcard is not enough.

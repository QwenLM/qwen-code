# Ephemeral authentication for `qwen serve --open`

- Status: Proposed
- Baseline: `main` at `ea872a4621` (2026-08-22)
- Related tracking issue:
  [#4514](https://github.com/QwenLM/qwen-code/issues/4514)
- Implementation plan: [2026-08-22-serve-open-ephemeral-auth.md](../plans/2026-08-22-serve-open-ephemeral-auth.md)

## Goal

Make the interactive Web Shell launch work without asking the operator to
invent and copy a daemon bearer token:

```bash
qwen serve --open
```

When this command can actually open a local Web Shell, it should create a
strong process-lifetime bearer token, protect the daemon API with the existing
authentication stack, and hand the token to the opened browser through the
existing URL-fragment flow.

This is an interactive convenience for a single-user loopback launch. It is
not a general daemon credential store or a replacement for an explicitly
managed token in multi-client and non-loopback deployments.

## Current behavior

`runQwenServe()` resolves a bearer token from `ServeOptions.token`, falling
back to `QWEN_SERVER_TOKEN`, and trims the selected value. A configured token
makes the global bearer middleware protect API routes. On loopback, `/health`
remains outside that middleware unless `--require-auth` is also set. A
non-loopback primary listener refuses to start without a token.

With no token, the loopback developer default leaves the primary bearer
middleware open. Non-strict routes, including `/capabilities`, can therefore
be called by another local process without `Authorization`. Routes using the
strict mutation gate still return `401 token_required`.

`--open` currently changes none of those rules. Once the listener and runtime
are ready, it opens the mounted Web Shell if the environment supports browser
launch. When a token was configured separately, the resolved token is added as
`#token=...`; otherwise the browser opens without credentials.

The Web Shell already implements the required handoff. It reads `#token=`,
stores the value in per-tab `sessionStorage`, removes the fragment from the
visible URL, and sends the token in `Authorization: Bearer ...` headers.
Refresh therefore works, while closing the tab intentionally discards the
credential.

## Decision

The CLI will automatically create an ephemeral bearer token for a bare
`qwen serve --open` invocation only when all of these conditions hold:

1. `--open` is enabled.
2. The primary listener is bound to loopback.
3. Web Shell serving is enabled and built assets are available.
4. The current environment is eligible for browser launch.
5. The existing token resolution produces no non-empty token.

The token is 32 cryptographically random bytes encoded with base64url. The CLI
places it in `ServeOptions.token` before calling `runQwenServe()`. From that
point onward, the generated token is indistinguishable from an explicitly
configured runtime token: the existing bearer middleware, WebSocket
authentication, strict mutation gate, internal worker handoff, redaction, and
`RunHandle.resolvedToken` behavior remain authoritative.

The existing selection rule remains unchanged: choose `ServeOptions.token`
when it is not `undefined`; otherwise choose `QWEN_SERVER_TOKEN`; then trim the
selected value. A non-empty selected value wins and suppresses generation. A
selected empty or whitespace-only value is treated as no configured token for
this interactive flow.

No new flag, environment variable, capability tag, protocol field, SDK option,
or embedded `runQwenServe()` behavior is introduced. Automatic generation is a
property of the two CLI entry paths that own `--open`, not a daemon API default.

## Behavior matrix

| Invocation or environment                                                         | Automatic token                            | Result                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `qwen serve` on loopback                                                          | No                                         | Existing token-less developer default                                               |
| `qwen serve --open` on an interactive loopback host                               | Yes, if no configured token exists         | Browser receives the token; API routes require it                                   |
| `qwen serve --open --require-auth` on an interactive loopback host                | Yes, if no configured token exists         | Browser receives the token; `/health` also requires it                              |
| `QWEN_SERVER_TOKEN=... qwen serve --open`                                         | No                                         | Existing configured token is reused                                                 |
| `qwen serve --token ... --open`                                                   | No                                         | Explicit CLI token is reused                                                        |
| `qwen serve --open --no-web`                                                      | No                                         | Existing API-only behavior; `--open` is a no-op                                     |
| `qwen serve --open` with missing Web Shell assets                                 | No                                         | Existing API-only degradation                                                       |
| `qwen serve --open` in CI, SSH without a display, or another headless environment | No                                         | Existing browser-launch no-op and loopback auth default                             |
| `qwen serve --hostname 0.0.0.0 --open` without a token                            | No                                         | Existing non-loopback boot refusal                                                  |
| `qwen serve --open --local-control`                                               | Yes for the primary listener when eligible | Primary uses the ephemeral runtime token; LAN keeps its separate pairing credential |
| `qwen serve --open --allow-origin '*'` on eligible loopback                       | Yes, if no configured token exists         | Generated bearer satisfies the existing wildcard-origin boot guard                  |

Static Web Shell assets remain mounted before bearer authentication because
address-bar navigation and script loading cannot attach an Authorization
header. Normal API routes require the generated bearer. Loopback `/health`
remains pre-authentication unless `--require-auth` is present.

## Lifecycle and recovery

The server does not persist an automatically generated token and does not
export it as `QWEN_SERVER_TOKEN`. It lives for the daemon process and rotates on
every restart. The normal internal authenticated-child path may receive it in
the same way it receives an explicit runtime token; existing redaction and
environment-separation rules continue to apply.

The browser receives the token in the launch command's URL fragment. The
fragment is not sent in HTTP requests, access logs, or Referer headers. The Web
Shell removes it from the URL after reading it and retains it only in that
tab's `sessionStorage`.

Consequences of this intentionally short lifetime are:

- Refreshing the opened tab keeps working.
- Closing the only tab loses the browser copy. Restarting
  `qwen serve --open` creates a new token and opens a new authenticated tab.
- A browser launcher failure follows the existing recovery path, which may
  print the secret-bearing fragment URL for manual opening.
- A long-running or multi-client workflow should configure
  `QWEN_SERVER_TOKEN` explicitly so the operator can give the same credential
  to each authorized client and reopen the Web Shell without restarting.

The CLI emits a non-secret breadcrumb when it generates a token. Existing
warnings continue to state that a token-bearing browser launch command can be
visible through `ps` or `/proc`. This mode is therefore intended for a trusted,
single-user host, not a shared workstation where process command lines or
terminal output cross trust boundaries.

## Compatibility

The behavior of `qwen serve` without `--open` is unchanged. Direct embedded
callers of `runQwenServe()` are also unchanged.

Bare `--open` is intentionally different. Today, another local curl or SDK
client can use non-strict routes without a token while the Web Shell is open.
After this change, that client receives `401 Unauthorized` because the
generated token becomes the daemon's full runtime credential. The token is not
published for discovery.

Users who combine the Web Shell with another local client have two supported
migrations:

1. Set `QWEN_SERVER_TOKEN` before starting `qwen serve --open`, and configure
   the other client with the same token.
2. Start plain `qwen serve` without `--open` when the token-less loopback
   developer contract is desired.

On eligible loopback launches, automatic generation also means combinations
that already require a configured bearer, such as `--allow-origin '*'` or an
explicit `--enable-session-shell`, can use the generated credential. Their
existing independent safety checks and opt-in flags remain unchanged.

The generated token is not browser-scoped. Possession grants the same daemon
authority as an explicitly configured runtime token. Per-client credentials,
identity binding, and independent revocation require the larger credential
store work tracked by #4514.

## Failure behavior

- Browser eligibility and Web Shell asset availability are checked before a
  token is generated, so a known no-op `--open` path does not leave the operator
  with an inaccessible authenticated daemon.
- Non-loopback binding is never made implicitly usable by token generation; it
  continues to demand explicit operator-supplied credentials.
- `--require-auth` still fails closed when automatic generation is ineligible
  and no explicit token exists.
- If browser launch fails after eligibility was established, the existing
  browser launcher retains its manual-URL fallback. No persistent recovery
  credential is added.
- Runtime startup failure keeps the existing daemon shutdown/error behavior;
  the ephemeral token does not create a second lifecycle.

## Alternatives considered

### Keep the loopback API token-less under `--open`

This is the current behavior. It avoids breaking other local clients, but the
Web Shell cannot call strict routes and every non-strict route remains
available to other local processes. It does not meet the goal of a complete
interactive Web Shell without manual authentication setup.

### Add `--ephemeral-auth`

An opt-in flag preserves the exact semantics of bare `--open`, but leaves the
common command with the same manual token requirement. The selected product
contract treats `--open` as the browser-owned interactive mode and accepts the
documented compatibility change.

### Persist a generated token

A file-backed token would support reopening tabs and client discovery, but it
requires secure storage permissions, stale-instance cleanup, rotation,
revocation, and a client identity model. That work should be designed together
with #4514's pair-token and per-client revocation scope, not introduced as a
one-off file for `--open`.

### Mint a browser-scoped pairing token

Keeping the primary listener open while accepting a second browser credential
would avoid breaking token-less clients. It would also require a new primary
listener credential scope, optional authentication on an otherwise-open
listener, separate session semantics, and revocation behavior. Reusing the
existing runtime bearer is smaller and uses enforcement already exercised by
all daemon transports.

## Out of scope

- Persistent token storage or discovery
- Cross-tab or cross-browser credential sharing
- `localStorage`, cookies, or a new browser bootstrap endpoint
- Pair tokens, per-client identity, audit ownership, or independent revocation
- Automatic credentials for non-loopback binds
- Changes to SDK token discovery
- Changes to Local Control's listener-scoped pairing credential

## Acceptance criteria

- An eligible bare `qwen serve --open` opens a Web Shell that can call strict
  and non-strict API routes without manual token configuration.
- An unauthenticated local API client receives 401 from protected routes on
  that daemon.
- Plain `qwen serve`, direct `runQwenServe()` callers, headless `--open`,
  API-only mode, and non-loopback boot checks preserve their existing behavior.
- Explicit CLI and environment tokens retain precedence and are never replaced.
- The generated token is not persisted by the daemon or printed during a
  successful browser launch.
- Refresh works through the existing per-tab Web Shell storage; closing the tab
  does not create cross-tab persistence.

# Authenticated Web Shell launch for `qwen serve`

- Status: Implemented in [#9738](https://github.com/QwenLM/qwen-code/pull/9738)
- Baseline: `main` at `ea872a4621` (2026-08-22)
- Revalidated: `main` at `7385b278b2` (2026-08-23)
- Related tracking issue:
  [#4514](https://github.com/QwenLM/qwen-code/issues/4514)
- Implementation plan: [2026-08-22-serve-open-with-auth.md](../plans/2026-08-22-serve-open-with-auth.md)

## Goal

Make the interactive Web Shell launch work without asking the operator to
invent and copy a daemon bearer token:

```bash
qwen serve --open-with-auth
```

The explicit `--open-with-auth` flag should ensure that the launch uses the
existing bearer authentication stack. It creates a strong process-lifetime
token when no configured token exists and hands the selected token to the
opened browser through the existing URL-fragment flow. Bare
`qwen serve --open` keeps its current token-less loopback behavior.

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

The Desktop Shell already uses a related per-launch pattern: it creates a
256-bit token, passes it to a child daemon through `QWEN_SERVER_TOKEN`, starts
that daemon with `--require-auth`, and hands the credential to the Web Shell in
a URL fragment. This proposal deliberately reuses the fragment and bearer
semantics while differing at the CLI boundary: the token is base64url-encoded,
is assigned to `ServeOptions.token` without mutating `process.env`, and leaves
loopback `/health` pre-authentication unless the operator passes
`--require-auth`. See
[Desktop Web Shell release](./2026-07-31-desktop-web-shell-release.md).

## Decision

Add one default-off CLI flag, `--open-with-auth`. The mode requires these
structural conditions, validated before the daemon listens:

1. `isLoopbackBind()` classifies the primary listener as loopback.
2. Web Shell serving is enabled and built assets are available.

The flag includes the browser-opening intent; operators do not also need to
pass `--open`. Internally, both CLI entry paths treat `--open-with-auth` as an
effective `--open`. Passing both is harmless and has the same authenticated
behavior.

These checks are deterministic, so a failure is a command error before the
daemon listens, even when a token is already configured; the explicit request
must not silently degrade or describe a browser-delivery mode that cannot
run.

Browser-launch eligibility is deliberately not one of these hard gates.
`shouldLaunchBrowser()` is a heuristic with common false negatives — a truthy
`CI`, `DEBIAN_FRONTEND=noninteractive`, a Linux session without
`DISPLAY`/`WAYLAND_DISPLAY`/`MIR_SOCKET`, a blocklisted `BROWSER` command, or
SSH on a non-Linux host — and several of those environments still let the
operator open a printed URL manually, for example over SSH port forwarding.
When the heuristic reports ineligible, the CLI therefore starts the daemon and
prints the fragment-bearing manual URL instead of auto-opening it. This matches
the existing secure launcher's recovery after a browser command fails, so
"the browser did not open" has exactly one actionable outcome without adding a
second browser-eligibility API.

After the structural checks, the CLI creates an ephemeral bearer only when the
existing token resolution produces no non-empty token. A non-empty configured
token remains authoritative and suppresses generation.

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

No new environment variable, capability tag, protocol field, SDK option, or
embedded `runQwenServe()` behavior is introduced. Automatic generation is a
property of the two CLI entry paths when the new flag is present, not a daemon
API default.

## Behavior matrix

| Invocation or environment                                                                    | Automatic token                                            | Result                                                                             |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `qwen serve` on loopback with no configured token                                            | No                                                         | Existing token-less developer default                                              |
| `qwen serve --open` on an interactive loopback host with no configured token                 | No                                                         | Existing browser launch and token-less loopback contract                           |
| `qwen serve --open-with-auth` on an eligible loopback host                                   | Yes, if no configured token exists                         | Browser receives the token; API routes require it                                  |
| `qwen serve --open-with-auth --require-auth`                                                 | Yes, if no configured token exists                         | Browser receives the token; `/health` also requires it                             |
| `QWEN_SERVER_TOKEN=... qwen serve --open-with-auth`                                          | No                                                         | Existing configured token is reused                                                |
| `qwen serve --token ... --open-with-auth`                                                    | No                                                         | Explicit CLI token is reused                                                       |
| `qwen serve --open --open-with-auth`                                                         | Yes, if no configured token exists                         | Same as `--open-with-auth`; the extra `--open` is redundant                        |
| `qwen serve --open-with-auth --no-web`                                                       | No                                                         | CLI validation error before listen                                                 |
| `qwen serve --open-with-auth` with missing Web Shell assets                                  | No                                                         | CLI validation error before listen                                                 |
| `qwen serve --open-with-auth` in CI, headless SSH, or another ineligible browser environment | Yes, if no configured token exists                         | The daemon starts and the CLI prints the fragment-bearing manual URL               |
| `qwen serve --hostname 0.0.0.0 --open-with-auth`                                             | No                                                         | CLI validation error; automatic credentials remain loopback-only                   |
| `qwen serve --open-with-auth --local-control`                                                | Yes for the primary listener if no configured token exists | Primary uses the selected runtime token; LAN keeps its separate pairing credential |
| `qwen serve --open-with-auth --enable-session-shell`                                         | Yes, if no configured token exists                         | The explicit shell opt-in becomes active and remains bearer-gated                  |
| `qwen serve --open-with-auth --allow-origin '*'`                                             | Yes, if no configured token exists                         | Selected bearer intentionally satisfies the existing wildcard-origin boot guard    |
| `qwen serve --open-with-auth --allow-origin chrome-extension://<id>`                         | Yes, if no configured token exists                         | Opened tab works; the extension does not receive or discover the generated token   |

Static Web Shell assets remain mounted before bearer authentication because
address-bar navigation and script loading cannot attach an Authorization
header. Normal API routes require the selected runtime bearer. Loopback
`/health` remains pre-authentication unless `--require-auth` is present.

Satisfying the `--allow-origin '*'` boot guard is intentional only when the
operator explicitly selects `--open-with-auth`. The selected bearer prevents an
unrelated page from calling protected API routes without the credential. It
does not change the residual pre-authentication surfaces: static Web Shell
assets remain readable, and loopback `/health` remains pre-authentication
unless `--require-auth` is present. Operators who do not want those surfaces
should combine `--require-auth` and, where appropriate, `--no-web` with an
explicitly managed token rather than ephemeral mode.

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
  `qwen serve --open-with-auth` creates a new token and opens a new
  authenticated tab.
- Opening a bookmark, pasting the cleaned URL into another tab, restoring a tab
  after the browser process exits, or refreshing after `sessionStorage` was
  unavailable loads the static shell without the credential. API requests then
  receive plain `401 Unauthorized`. The current Web Shell has no global
  authentication-recovery screen; restart
  `qwen serve --open-with-auth`, or use an explicitly managed token for
  a workflow that must be reopened or shared.
- A browser launcher failure, or an environment the eligibility heuristic
  reports as ineligible, follows the existing recovery path, which may print
  the secret-bearing fragment URL for manual opening.
- A long-running or multi-client workflow should configure
  `QWEN_SERVER_TOKEN` explicitly so the operator can give the same credential
  to each authorized client and reopen the Web Shell without restarting.

The CLI emits a non-secret breadcrumb when it generates a token. Existing
warnings continue to state that a token-bearing browser launch command can be
visible through `ps` or `/proc`. This mode is therefore intended for a trusted,
single-user host, not a shared workstation where process command lines or
terminal output cross trust boundaries.

## Compatibility

Apart from help text advertising the new option, all existing serve execution
modes retain their current runtime behavior. This includes plain `qwen serve`,
bare `qwen serve --open`, the Chrome extension's documented serve command,
daemon-backed channel commands, and direct embedded callers of
`runQwenServe()`. The new flag is the runtime compatibility boundary.

Inside an explicitly opted-in ephemeral launch, another local curl, SDK, or
first-party client without the selected bearer receives `401 Unauthorized`.
An automatically generated token is not published for discovery. Multi-client
users should instead set `QWEN_SERVER_TOKEN` before starting
`qwen serve --open` and configure each client with the same stable credential.

Daemon-backed `qwen channel set` and `qwen channel reload`, plus the
`--daemon-url` forms of `qwen channel status` and `qwen channel stop`, cannot
discover an ephemeral token. The Chrome extension likewise cannot receive it.
Those clients remain compatible by omitting `--open-with-auth`, or can join an
authenticated daemon when the operator supplies a shared stable token. No
extension default or prompt change is needed.

An explicit `--enable-session-shell` has a separate posture change. Without a
configured token today, the daemon ignores the flag with a warning. Only the
explicit combination with `--open-with-auth` supplies that token and
therefore enables direct session shell execution. This is a double opt-in, and
must still be called out in user documentation and tests.

The generated token is not browser-scoped. Possession grants the same daemon
authority as an explicitly configured runtime token. Per-client credentials,
identity binding, and independent revocation require the larger credential
store work tracked by #4514.

## Failure behavior

- Bare `--open` keeps its existing no-op and API-only degradation behavior.
  With `--open-with-auth`, loopback binding, Web Shell enablement, and asset
  availability are validated before listen; an invalid explicit request fails
  instead of leaving an inaccessible authenticated daemon.
- Browser-launch eligibility is a heuristic and is not a hard gate. An
  ineligible environment falls back to the printed manual URL — the same
  outcome as a launch failure after eligibility passed.
- Non-loopback binding is never made implicitly usable by token generation; it
  continues to demand explicit operator-supplied credentials and cannot use
  `--open-with-auth`.
- `--require-auth` keeps its existing behavior without the new flag. In an
  eligible opted-in launch, the selected credential satisfies it and also moves
  loopback `/health` behind the bearer.
- If browser launch fails after eligibility was established, the existing
  browser launcher retains its manual-URL fallback. The heuristic-ineligible
  path prints the same form of manual URL. No persistent recovery credential
  is added.
- Runtime startup failure keeps the existing daemon shutdown/error behavior;
  the ephemeral token does not create a second lifecycle. The ordinary yargs
  path uses the default `runQwenServe()` contract, which does not return a
  `RunHandle` before runtime readiness. The listen-first fast path already
  closes the handle and exits when `runtimeReady` rejects.

## Alternatives considered

### Automatically generate for bare `--open`

This gives the shortest complete Web Shell command, but changes the contract
of an existing invocation. Other local curl and SDK clients, daemon-backed
channel commands, and the Chrome extension cannot discover the generated
credential; an explicit session-shell flag also changes from inert to active.
The compatibility cost is larger than the one-extra-flag convenience, so bare
`--open` remains unchanged.

### Make authenticated opening the default for `--open`

An opt-out would make the compatibility-changing behavior the default and ask
existing users to discover a new escape hatch. A default-off opt-in flag
preserves every existing invocation and makes the authenticated contract
explicit, so no opt-out flag is added.

### Add a separate `--ephemeral-auth` modifier

Requiring `--open --ephemeral-auth` exposes token lifetime as a user-facing
mechanism, creates an invalid standalone flag combination, and is inaccurate
when a configured token is reused. `--open-with-auth` names the user intent and
contains the opening behavior in one default-off option.

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
- Chrome extension token discovery or automatic credential delivery
- A new global Web Shell 401 or credential-recovery screen
- Changes to Local Control's listener-scoped pairing credential

## Acceptance criteria

- An eligible `qwen serve --open-with-auth` opens a Web Shell that can
  call strict and non-strict API routes without manual token configuration.
- An unauthenticated local API client receives 401 from protected routes on
  that daemon.
- Plain `qwen serve`, bare `qwen serve --open`, direct `runQwenServe()` callers,
  headless `--open`, API-only mode, and non-loopback boot checks preserve their
  existing behavior.
- `--open-with-auth` with an ineligible bind or disabled or missing Web Shell
  fails before listen even when another token is configured; remove the
  inapplicable flag to use the existing mode. A headless or otherwise
  browser-ineligible environment starts the daemon and prints the manual URL.
- A non-empty token selected by the existing CLI-over-environment precedence is
  never replaced. An empty or whitespace-only selected value is treated as
  absent.
- The generated token is not persisted by the daemon or printed during a
  successful browser launch.
- Refresh works through the existing per-tab Web Shell storage; closing the tab
  does not create cross-tab persistence.

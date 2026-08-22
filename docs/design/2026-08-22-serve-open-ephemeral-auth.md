# Ephemeral authentication for `qwen serve --open`

- Status: Proposed
- Baseline: `main` at `ea872a4621` (2026-08-22)
- Revalidated: `main` at `2172721405` (2026-08-23)
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

The CLI will automatically create an ephemeral bearer token for a bare
`qwen serve --open` invocation only when all of these conditions hold:

1. `--open` is enabled.
2. `isLoopbackBind()` classifies the primary listener as loopback.
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
| `qwen serve --open --enable-session-shell` on eligible loopback                   | Yes, if no configured token exists         | The explicit shell opt-in becomes active and remains bearer-gated                   |
| `qwen serve --open --allow-origin '*'` on eligible loopback                       | Yes, if no configured token exists         | Generated bearer intentionally satisfies the existing wildcard-origin boot guard    |
| `qwen serve --open --allow-origin chrome-extension://<id>`                        | Yes, if no configured token exists         | Opened tab works; the extension does not receive or discover the generated token    |

Static Web Shell assets remain mounted before bearer authentication because
address-bar navigation and script loading cannot attach an Authorization
header. Normal API routes require the generated bearer. Loopback `/health`
remains pre-authentication unless `--require-auth` is present.

Automatically satisfying the `--allow-origin '*'` boot guard is intentional.
The operator still has to pass the wildcard flag explicitly, and the generated
bearer prevents an unrelated page from calling protected API routes without
the credential. It does not change the residual pre-authentication surfaces:
static Web Shell assets remain readable, and loopback `/health` remains
pre-authentication unless `--require-auth` is present. Operators who do not
want those surfaces should combine `--require-auth` and, where appropriate,
`--no-web` with an explicitly managed token.

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
- Opening a bookmark, pasting the cleaned URL into another tab, restoring a tab
  after the browser process exits, or refreshing after `sessionStorage` was
  unavailable loads the static shell without the credential. API requests then
  receive plain `401 Unauthorized`. The current Web Shell has no global
  authentication-recovery screen; restart `qwen serve --open`, or use an
  explicitly managed token for a workflow that must be reopened or shared.
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

This compatibility change also reaches first-party clients. Daemon-backed
`qwen channel set` and `qwen channel reload`, plus the `--daemon-url` forms of
`qwen channel status` and `qwen channel stop`, cannot discover the ephemeral
token. Use a shared `QWEN_SERVER_TOKEN` or pass the same stable `--token` to
those commands. The Chrome extension's documented command remains plain
`qwen serve --allow-origin chrome-extension://<id>` without `--open`. Combining
that command with `--open` protects the primary API but does not deliver the
generated credential to the extension, so the extension cannot authenticate;
omit `--open` for the existing extension flow. Automatic extension credential
delivery is not part of this proposal. No extension default or prompt change is
needed because both already recommend the plain command without `--open`.

An explicit `--enable-session-shell` has a separate posture change. Without a
configured token today, the daemon ignores the flag with a warning. On an
eligible `--open` launch, generation supplies that token and the explicit flag
therefore enables direct session shell execution. The operator opt-in and
bearer gate remain unchanged, but the formerly inert combination becomes live
and must be called out in user documentation and tests.

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
  the ephemeral token does not create a second lifecycle. The ordinary yargs
  path uses the default `runQwenServe()` contract, which does not return a
  `RunHandle` before runtime readiness. The listen-first fast path already
  closes the handle and exits when `runtimeReady` rejects.

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

### Add `--no-ephemeral-auth`

An opt-out would preserve browser auto-launch for the old token-less loopback
contract, but the resulting Web Shell would still fail every strict route. It
would add a second `--open` contract, two CLI parsing paths, documentation, and
tests for a deliberately partial UI. Plain `qwen serve` preserves the old
contract cleanly, while an explicit shared token supports a complete
multi-client Web Shell, so no opt-out flag is added.

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

- An eligible bare `qwen serve --open` opens a Web Shell that can call strict
  and non-strict API routes without manual token configuration.
- An unauthenticated local API client receives 401 from protected routes on
  that daemon.
- Plain `qwen serve`, direct `runQwenServe()` callers, headless `--open`,
  API-only mode, and non-loopback boot checks preserve their existing behavior.
- Non-empty explicit CLI and environment tokens retain precedence and are never
  replaced. An empty or whitespace-only selected value is treated as absent.
- The generated token is not persisted by the daemon or printed during a
  successful browser launch.
- Refresh works through the existing per-tab Web Shell storage; closing the tab
  does not create cross-tab persistence.

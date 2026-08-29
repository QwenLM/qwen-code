# Trusted loopback full API access for `qwen serve`

- Status: Implemented
- Baseline: `origin/main` at `f470b122fa22` (2026-08-28)
- Related issue: [#3803](https://github.com/QwenLM/qwen-code/issues/3803)
- Historical implementation:
  [#3889](https://github.com/QwenLM/qwen-code/pull/3889),
  [#4236](https://github.com/QwenLM/qwen-code/pull/4236),
  [#9106](https://github.com/QwenLM/qwen-code/pull/9106), and
  [#9738](https://github.com/QwenLM/qwen-code/pull/9738)

## Decision summary

Treat the primary listener of a tokenless loopback daemon as an
operator-authorized surface. In that mode, every primary-listener operator API
is available without a bearer token, including routes currently registered
with `mutate({ strict: true })`, subject to its existing feature, trust,
ownership, permission, and input checks.

This is authorization by deployment boundary, not credential authentication.
An open loopback request must not be stamped as bearer-authenticated. The code
must retain the distinction between these two facts:

- `requestWasAuthenticated(req)`: the request presented a valid credential for
  the listener on which it arrived.
- operator authority: the request was credential-authenticated, or it arrived
  on the primary listener while the daemon is in trusted-loopback mode.

The mode is active only when all three conditions hold:

```text
loopback bind AND no resolved runtime token AND requireAuth is false
```

Non-loopback listeners, `--require-auth`, the Local Control LAN listener,
channel webhook authentication, workspace trust, permission mediation,
client/session ownership, and explicit feature switches retain their current
checks.

## Problem

`qwen serve` is primarily used as a local companion process. Its existing
loopback default is nevertheless split into two inconsistent authority tiers:

- non-strict routes are open without a token;
- strict routes return `401 { code: "token_required" }`;
- direct session shell stays disabled even when the operator explicitly passed
  `--enable-session-shell`;
- Local Control can be enabled, but its pairing URL is withheld from the same
  tokenless local API client and printed only to the daemon terminal.

That split means a local Web Shell or SDK can create and drive sessions but
cannot perform many settings, file, skill, tool, MCP, authentication, trust,
workspace, or session-management operations unless the operator separately
creates and distributes a bearer token.

The current strict surface is not a small list that should be edited route by
route. At the baseline above, 133 production registrations across 27 files use
`mutate({ strict: true })`. The central mutation gate is therefore the correct
policy seam.

## Goals

1. Make a default tokenless loopback daemon fully operable through REST, ACP,
   WebSocket, the Web Shell, and SDK clients.
2. Keep `runQwenServe()`'s bearer requirement for non-loopback primary
   listeners and for explicitly hardened loopback deployments.
3. Keep Local Control's LAN credential listener-scoped and revocable.
4. Preserve all non-token authorization and safety checks.
5. Express the change once at the central authorization boundary instead of
   editing every strict route.
6. Keep bare `qwen serve`, `qwen serve --open`, and direct tokenless local
   clients simple: they do not need token discovery or browser credential
   handoff.

## Non-goals

- Making `--open` generate a token. `--open-with-auth` already serves that
  explicit hardened-launch use case.
- Removing `mutate({ strict: true })` markers or weakening them for embedded,
  non-loopback, or LAN requests.
- Enabling session shell by default. `--enable-session-shell` remains required.
- Treating workspace trust as an ACL replacement, automatically trusting a
  workspace, bypassing permission mediation, or weakening client/session
  ownership checks.
- Removing CORS, Host, Origin, rate, connection, body-size, or resource limits.
- Persisting, discovering, refreshing, or revoking a primary runtime token.
- Introducing OS-user authentication. A TCP loopback connection does not carry
  a portable operating-system identity.

## Current architecture and why it exists

### Runtime bearer authentication

The original daemon implementation in #3889, authored by Shaojin Wen,
introduced `QWEN_SERVER_TOKEN`. A configured runtime token protects the
primary REST and WebSocket surfaces. `runQwenServe()` refuses a non-loopback
bind without a token. On loopback, no token leaves the primary listener open
for developer convenience.

Bearer values are opaque credentials. Plain HTTP exposes them to any process
or network observer that can inspect the connection; the current non-loopback
guidance therefore still needs TLS or a trusted terminating proxy. Removing
the token from a loopback deployment avoids token distribution, not the need
to define who can connect.

### Strict mutation gate

#4236 added `createMutationGate({ tokenConfigured, requireAuth })` and the
`--require-auth` option. The gate deliberately allowed non-strict requests on a
tokenless loopback daemon but returned `token_required` for strict routes.
Subsequent APIs reused that central gate.

The marker now covers more than HTTP verbs normally described as mutations.
Some sensitive reads and control operations are strict too. The design must
therefore preserve the marker as a policy annotation rather than infer
authority from `GET` versus `POST`.

### Listener-scoped Local Control credentials

#9106 moved Local Control into the daemon. The primary listener accepts only
the runtime token; the LAN listener accepts only revocable pairing tokens. The
same Express app serves both listeners, and the HTTP server object is tagged so
middleware can resolve the listener for every request. WebSocket upgrades
repeat the same Host, Origin, and credential scoping because they bypass
Express middleware.

On a tokenless daemon, the Local Control status and enable responses currently
redact the pairing URL unless `requestWasAuthenticated(req)` is true. That
prevents an arbitrary local process from minting and exporting LAN authority
under the current model, in which strict APIs do not trust arbitrary local
processes.

This proposal intentionally changes that local-process model. Once every local
primary request is operator-authorized, hiding the pairing secret only makes a
first-party tokenless Web Shell incomplete; it no longer protects a boundary
the daemon claims to enforce. The LAN listener itself remains closed until a
pairing credential is presented.

### Authenticated browser launch

#9738 added loopback-only `--open-with-auth`. It reuses or generates a runtime
bearer, passes it to the Web Shell in a URL fragment, and the Web Shell retains
it per tab in `sessionStorage`. This remains useful on a shared host or whenever
the operator wants every primary API request to prove possession of a
credential. It is not the default local workflow proposed here.

## Threat model

### Trusted-loopback mode trusts reachable local callers

The trust decision is made from the actual bind address, not from a claim in an
HTTP header. `runQwenServe()` resolves `localhost` once, pins the listener to
that address, and verifies after listen that it is `::1` or in the complete
`127.0.0.0/8` range before publishing the daemon. A direct `createServeApp()`
embed has no socket to verify, so its caller remains responsible for ensuring
that a declared loopback hostname is bound only to loopback.

Host-header and same-origin checks also admit the exact bound loopback address,
so valid `127.0.0.0/8` binds do not drift from the trusted-mode predicate while
unrelated authorities remain rejected.

The guarantee is deliberately no stronger than that. Loopback is not user or
process identity. Another local account, a compromised browser process, a
desktop networking proxy, or a container that can reach a host service may be
able to call the daemon. The existing Host and Origin checks reduce DNS
rebinding and browser cross-origin attacks, but they do not authenticate a
local process.

The daemon already accepts `host.docker.internal` as a primary Host and
self-origin value. Docker documents that name as a way for containers to reach
host services. Operators must therefore treat reachable local containers and
desktop proxies as part of the trusted boundary, or use a token.

### Shared or untrusted hosts must opt into credentials

The migration rule is explicit:

```bash
QWEN_SERVER_TOKEN="<secret>" qwen serve --require-auth
```

Use this on shared workstations, CI hosts, remote development machines,
multi-tenant containers, or whenever local processes are not mutually trusted.
`--open-with-auth` remains the convenient single-browser version of the same
hardened posture.

### Browser secure context is not daemon authorization

Browsers may treat correctly resolved `localhost` origins as potentially
trustworthy so powerful web APIs can work without public TLS. That browser
classification provides neither process identity nor authorization to modify
the daemon. The daemon's trusted-loopback decision and its Host/Origin defenses
remain separate concepts.

## Required invariants

1. A primary request may receive trusted-loopback authority only when the
   actual primary bind is loopback, no resolved runtime token exists, and
   `requireAuth` is false.
2. A request on the Local Control listener never receives authority merely
   because the primary listener is trusted loopback.
3. A token or `--require-auth` never activates trusted-loopback authority. When
   a token exists, the existing bearer middleware authenticates the primary
   listener before route policy. `runQwenServe()` continues to reject
   `--require-auth` without a token before listen.
4. A non-loopback primary bind without a token remains a boot error in
   `runQwenServe()` and never receives trusted-loopback authority in direct
   `createServeApp()` use.
5. Pairing tokens remain invalid on the primary listener; runtime tokens remain
   invalid on the Local Control listener.
6. WebSocket upgrades keep their current listener-scoped credential behavior.
   Tokenless primary WebSockets are already open only when the socket is
   loopback; LAN upgrades still require pairing.
7. Workspace trust, runtime ownership, session-bound client id, generation
   fencing, permission mediation, and route-specific validation run after this
   authorization decision exactly as they do today.
8. `--enable-session-shell` remains a separate explicit operator decision.
9. `--allow-origin '*'` without a token remains a boot error. Wildcard CORS
   actively admits arbitrary web origins and is not implied by local-process
   trust.
10. Static Web Shell assets and loopback `/health` retain their current
    pre-authentication behavior. `--require-auth` continues to protect
    loopback `/health`.
11. Local Control remains available only when the primary listener is bound to
    loopback. Trusted-loopback authority does not make Local Control composable
    with a wildcard or LAN primary bind that already owns the target address
    and port.

## Detailed design

### 1. Compute one effective deployment mode

Add a small pure helper next to the serve authentication policy. It accepts
already-resolved facts instead of reading the environment:

```ts
interface TrustedLoopbackModeInput {
  loopbackBind: boolean;
  tokenConfigured: boolean;
  requireAuth: boolean;
}

function isTrustedLoopbackMode(input: TrustedLoopbackModeInput): boolean {
  return input.loopbackBind && !input.tokenConfigured && !input.requireAuth;
}
```

`runQwenServe()` calls it after `resolveServeToken()` has normalized option and
environment input. `createServeApp()` calls it from `opts.hostname`, the same
non-empty-token rule it already uses, and `opts.requireAuth`. Keeping the helper
pure avoids a second token-resolution path and makes direct embeds testable.

`createServeApp()` rejects `requireAuth: true` without a token before assembling
the application. That configuration is invalid independently of the socket and
otherwise leaves non-strict routes open even though the public option claims
that every normal API route requires a bearer. The exported mutation gate also
treats the same inconsistent dependency as unauthenticated and fails strict
routes closed. Channel webhook ingress remains under its independent
shared-secret contract.

The app factory does not add the runner's non-loopback/no-token boot check. It
constructs an Express application and does not own the socket on which an
embedder may host it. A direct no-token embed declaring a non-loopback hostname
therefore keeps its existing non-strict REST behavior, but it does not receive
trusted-loopback authority: strict routes, direct session shell, and Local
Control pairing material remain unavailable. `runQwenServe()` remains the
documented deployment entry point that rejects a non-loopback/no-token
configuration before listen.

Do not infer the mode from `requestWasAuthenticated(req) === false`. A wrong or
missing bearer on a protected daemon is unauthenticated too, and must have
already been rejected by `bearerAuth`.

### 2. Add operator-authority evaluation without forging authentication

Add one request policy helper:

```ts
function requestHasOperatorAuthority(
  req: Request,
  trustedLoopbackMode: boolean,
): boolean {
  return (
    requestWasAuthenticated(req) ||
    (trustedLoopbackMode && listenerIdentityOf(req).kind === 'primary')
  );
}
```

Do not set `AUTHENTICATED_REQUEST` for open primary requests. That symbol means
a listener-scoped credential was verified and may remain useful for audit,
telemetry, or future client identity work. Authorization by deployment mode is
a different fact.

An untagged synthetic request continues to resolve as `primary`, matching the
existing listener-identity test convention. It receives local authority only
when the caller explicitly constructs the app in trusted-loopback mode.

### 3. Change the central strict gate, not route registrations

Extend `CreateMutationGateDeps` with optional `trustedLoopbackMode`, defaulting
to `false`. The helper is exported today, so making omission fail closed
preserves source compatibility for existing direct callers without silently
granting them local authority. Its behavior becomes:

- `tokenConfigured` mode: all requests reaching the route already
  authenticated; return the cached passthrough handler;
- tokenless trusted-loopback mode: both strict and non-strict primary requests
  pass; authenticated Local Control requests pass;
- any tokenless non-trusted direct embed: non-strict behavior remains unchanged,
  while strict requests pass only when a listener credential was verified;
  otherwise they retain `401 token_required`.

Only `tokenConfigured` may select the unconditional passthrough. The current
gate also treats `requireAuth` alone as proof that global bearer authentication
already ran, relying on `runQwenServe()` to reject the no-token combination.
That assumption is not valid for a direct `createServeApp()` caller. Stop using
the flag as an authentication fact: `requireAuth: true` with no token must fail
closed at strict routes even in an embedded app. The effective trusted flag is
also accepted only when `tokenConfigured` and `requireAuth` are both false, so
an inconsistent injected dependency cannot broaden access.

The implementation may return the cached passthrough for every route in
trusted-loopback mode only if the Local Control listener remains protected by
the global `bearerAuth` middleware. That is true today. Keeping an explicit
operator-authority strict handler is slightly more defensive for embedded apps
or future listener changes and makes the primary-versus-LAN invariant visible.
Prefer that explicit handler unless measurement shows it matters.

No `mutate({ strict: true })` call site changes. The markers remain valuable if
the same application is hosted under a different deployment policy later.

### 4. Honor explicit session-shell opt-in in trusted-loopback mode

Change effective shell enablement from:

```text
enableSessionShell AND tokenConfigured
```

to:

```text
enableSessionShell AND (tokenConfigured OR trustedLoopbackMode)
```

Apply the same value in both construction paths:

- `runQwenServe()` for bootstrap capabilities and every workspace bridge;
- `createServeApp()` for direct app construction, REST registration, daemon
  status, ACP initialization, and ACP dispatch.

Remove the warning that says the flag is ignored merely because no token is
configured. In trusted-loopback mode, emit no ignore warning because the flag
is active. In a non-trusted direct embed with no token, it remains disabled.

The existing defenses remain mandatory: the route is still marked strict, a
valid session-bound `X-Qwen-Client-Id` is still required, the client must belong
to the session, workspace ownership/trust still applies, and the bridge still
checks the same effective boolean before execution.

### 5. Return Local Control pairing material to an authorized local operator

Use `requestHasOperatorAuthority()` instead of
`requestWasAuthenticated()` when deciding whether Local Control status and
enable responses may include `url` and `qrText`. Thread the mode into the route
dependencies as an optional, fail-closed boolean so isolated route mounts that
omit it retain the current redaction behavior.

Results:

- trusted-loopback primary Web Shell or SDK: receives the pairing URL/QR;
- bearer-authenticated primary client: unchanged, receives it;
- paired LAN client: unchanged, receives current status through its valid
  pairing credential;
- unpaired LAN client: rejected by the global listener-scoped bearer gate;
- tokenless non-trusted direct embed: pairing material remains redacted.

When the response contains the URL, the enable route no longer needs to print
that URL solely as a fallback for this case. The existing terminal output may
remain for CLI-initiated `--local-control`, but HTTP responses and terminal
logging must not print duplicate secret-bearing URLs.

The enable route stays primary-only. A paired LAN client may still disable
Local Control but cannot enable or move it.

### 6. Preserve browser and transport defenses

The loopback Host and same-origin accept sets gain the exact bound loopback
address so every supported `127.0.0.0/8` bind behaves like the canonical
loopback names. REST, Web Shell, and WebSocket checks mirror that narrow
widening. The enforcement mechanisms and remaining defenses stay unchanged:

- loopback Host validation still rejects unrelated authorities, and
  non-loopback boot checks are unchanged;
- REST CORS deny-by-default behavior and the explicit origin allowlist are
  unchanged;
- same-loopback-origin normalization for the Web Shell admits the exact bound
  loopback address without admitting unrelated origins;
- WebSocket Host and Origin checks admit the same exact bound loopback address,
  while loopback-socket and listener credential checks are unchanged;
- Local Control's authority-specific Host/Origin checks;
- connection, request, body-size, rate, and session limits;
- channel webhook shared-secret authentication;
- static Web Shell pre-authentication mounting.

Specific `--allow-origin <origin>` entries continue to be an explicit operator
choice. In trusted-loopback mode, an allowlisted browser origin can call the
full API without a bearer. The wildcard form remains forbidden without a
token because it removes that explicit-origin boundary entirely.

### 7. Preserve the existing CDP/browser-automation exception

The optional Chrome DevTools MCP bridge is currently advertised and registered
only when no runtime token is configured, because its local `/cdp` connection
does not carry that bearer. Trusted-loopback mode already satisfies this path.
Do not rewrite this inverse token check as part of the authorization change.

### 8. Capabilities, status, and errors

Do not add a capability tag. Capability tags describe implemented protocol
features, while trusted-loopback is a deployment policy. The existing daemon
status facts are sufficient to derive it:

```text
security.loopbackBind
&& !security.tokenConfigured
&& !security.requireAuth
```

`session_shell_command` and `multi_workspace_session_shell` are advertised when
the effective shell boolean is true, including the newly supported
tokenless-loopback combination.

`require_auth` remains present only when `--require-auth` is active. The
`token_required` error remains part of the protocol for older daemons,
non-trusted direct embeds, and defense-in-depth tests. First-party clients may
keep their existing error handling; successful calls in trusted-loopback mode
need no client change.

Update the tokenless startup breadcrumb so operators see the actual boundary:

```text
qwen serve: trusted loopback mode; local callers have full API access without
bearer authentication. Use --require-auth with QWEN_SERVER_TOKEN on shared or
untrusted hosts.
```

Keep the separate warning when client-hosted MCP over WebSocket is enabled
without a token.

## Behavior matrix

| Primary invocation                       | Primary API                      | Strict API                       | `/health`                    | Explicit session shell                     | Local Control LAN                       |
| ---------------------------------------- | -------------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------ | --------------------------------------- |
| Loopback, no token, no `--require-auth`  | Open                             | Open                             | Open                         | Enabled only with `--enable-session-shell` | Pairing token required                  |
| Loopback with token                      | Bearer required                  | Bearer required                  | Open                         | Enabled only with `--enable-session-shell` | Pairing token required                  |
| Loopback with token and `--require-auth` | Bearer required                  | Bearer required                  | Bearer required              | Enabled only with `--enable-session-shell` | Pairing token required                  |
| Loopback, no token, `--require-auth`     | Boot error                       | Boot error                       | Boot error                   | Boot error                                 | Not started                             |
| Non-loopback with token                  | Bearer required                  | Bearer required                  | Bearer required              | Enabled only with `--enable-session-shell` | Unavailable; primary must bind loopback |
| Non-loopback, no token                   | Boot error                       | Boot error                       | Boot error                   | Boot error                                 | Not started                             |
| `--open-with-auth` on loopback           | Generated/reused bearer required | Generated/reused bearer required | Open unless `--require-auth` | Enabled only with `--enable-session-shell` | Pairing token required                  |

“Open” in this table means no daemon bearer is required. It does not bypass
workspace trust, client ownership, permission, feature-enable, input, or
resource checks.

## Alternatives considered

### Remove strict markers from every route

Rejected. It edits 133 registrations across 27 production files, invites drift
as new routes land, does not fix session-shell enablement or Local Control
pairing presentation, and loses useful policy annotations for other deployment
modes.

### Automatically generate a token for bare `--open`

Rejected. Local SDKs, curl, channel commands, and extensions cannot discover an
ephemeral browser token. This also duplicates `--open-with-auth` and does not
satisfy the requirement that a tokenless local client can perform every
operator action.

### Add `--unsafe-local-full-access`

Rejected. The desired product contract is that local execution is the normal
case. A second flag would preserve today's partial and surprising default.
The security opt-in already exists in the safer direction as `--require-auth`.

### Treat every open loopback request as bearer-authenticated

Rejected. No credential was presented. Forging the authentication marker would
erase the distinction needed for listener-scoped credentials, audit semantics,
and future client identity work.

### Leave Local Control pairing material redacted

Rejected for the first-party trusted-loopback mode. It would leave the Web
Shell dependent on terminal access even after the design explicitly grants the
same local caller every other operator capability. Redaction remains correct
for any request without operator authority.

### Disable authentication unconditionally for all loopback requests

Rejected. Operators need a hardened local mode on shared hosts.
`QWEN_SERVER_TOKEN` and `--require-auth` must continue to override the trusted
default.

## Compatibility and migration

This is an intentional security and behavior change for one existing
invocation class: loopback, no token, and no `--require-auth`.

Before the change, local unauthenticated callers receive `token_required` from
strict routes and cannot activate direct session shell. After the change, those
callers receive the normal route result and an explicit shell opt-in becomes
effective.

Operators who relied on strict routes as a partial barrier against other local
processes must migrate before upgrading:

```bash
export QWEN_SERVER_TOKEN="$(openssl rand -hex 32)"
qwen serve --require-auth
```

The concrete secret-generation mechanism is operator choice; documentation
must not encourage placing a long-lived token directly in a process command
line on multi-user systems.

First-party SDK method signatures do not change. Update stale SDK comments that
promise `token_required` on the default loopback path. Web Shell code that maps
`token_required` to a friendly authentication error should remain for older
daemons and non-trusted embeds.

No stored data or wire schema migration is required. Reverting the central
policy restores the previous strict behavior.

## Implementation touchpoints

The expected production changes are narrow:

- `packages/cli/src/serve/auth.ts`: deployment-mode and operator-authority
  helpers; mutation-gate dependency and behavior; comments and matrix.
- `packages/cli/src/serve/loopback-binds.ts`: recognize the complete supported
  IPv4 loopback range and format bound addresses for authority comparisons.
- `packages/cli/src/serve/server.ts`: derive trusted-loopback mode once, pass it
  to the mutation gate and Local Control routes, and use it for effective
  session-shell enablement.
- `packages/cli/src/serve/server/self-origin.ts` and
  `packages/cli/src/serve/acp-http/index.ts`: align REST/Web Shell and WebSocket
  Host/Origin checks with the exact bound loopback address.
- `packages/cli/src/serve/run-qwen-serve.ts`: derive the same mode from the
  resolved token; align bridge/bootstrap shell enablement and startup warning.
- `packages/cli/src/serve/capabilities.ts`: update the conditional session-shell
  documentation; advertisement still consumes the existing effective boolean.
- `packages/cli/src/serve/routes/workspace-local-control.ts`: authorize pairing
  material by operator authority instead of credential fact alone.
- `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx`:
  derive operator authority from the existing daemon security status when no
  bearer is present, so trusted-loopback channel controls are not left
  client-side read-only.
- `packages/cli/src/serve/types.ts` and
  `packages/acp-bridge/src/bridgeOptions.ts`: update shell-policy documentation.
- user/developer protocol and authentication documentation: describe the new
  default, threat boundary, and migration command.
- TypeScript SDK comments: remove the obsolete default-loopback
  `token_required` promise.

No production strict-route file should change solely to adopt this design.

## Verification plan

### Policy unit tests

Cover the complete deployment predicate and request authority matrix:

- loopback + no token + no `requireAuth` is trusted;
- loopback + token is not trusted-open;
- loopback + `requireAuth` is not trusted-open;
- non-loopback is never trusted-open;
- `requireAuth` without a token does not make the strict gate passthrough for a
  direct embed;
- authenticated primary and authenticated Local Control requests have operator
  authority;
- unauthenticated Local Control and non-trusted primary requests do not;
- trusted primary strict requests pass;
- non-trusted no-token strict requests retain `token_required`;
- cached middleware identity/allocation assertions remain correct.

### Representative REST tests

Do not duplicate all 133 registrations. Test the central gate directly, then
exercise representative downstream categories on a tokenless loopback app:

- file write or memory write;
- tool/skill or settings mutation;
- MCP server mutation/restart;
- workspace trust/lifecycle mutation;
- auth/device-flow entry point;
- session shell with the explicit flag and valid client id.

Each representative test must assert the downstream handler was actually
called, not merely that the response stopped being 401.

Existing route-unit tests that intentionally model an untrusted embedded app
may omit `trustedLoopbackMode` or pass `false` explicitly and retain their
denial assertions. Tests describing the ordinary loopback default must change
to success assertions. At the baseline, 34 `token_required` references across
11 test files require classification; they must not be mechanically flipped.

### Session shell tests

- `runQwenServe()` with loopback, no token, and `--enable-session-shell`
  advertises `session_shell_command` through bootstrap and runtime
  capabilities.
- ACP `initialize` advertises `_qwen/session/shell` in the same mode.
- REST and ACP dispatch both execute only with a valid session-bound client id.
- Omitting the flag still returns `session_shell_disabled` and advertises no
  shell capability.
- token-protected and multi-workspace shell behavior remains unchanged.

### Local Control tests

- trusted primary status/enable responses include URL and QR;
- bearer-authenticated primary and paired LAN responses remain complete;
- unpaired LAN requests return 401 before the route;
- enable remains primary-only;
- runtime token is rejected on LAN and pairing token is rejected on primary;
- disable revokes the pairing token and closes LAN WebSockets;
- a non-trusted direct embed still redacts pairing material.

### Web Shell tests

- channel management remains writable with a bearer;
- tokenless trusted-loopback status enables channel create/edit/lifecycle
  controls and exercises the downstream action;
- tokenless non-trusted status keeps those controls read-only.

### Boot and browser security regression tests

- non-loopback without token still fails before listen;
- `--require-auth` without token still fails before listen;
- wrong/missing bearer still returns 401 in protected modes;
- `--allow-origin '*'` without token still fails before listen;
- specific-origin, Host, self-origin, and WebSocket CSRF tests retain their
  current results;
- `--open-with-auth` continues to generate/reuse and deliver its bearer;
- tokenless browser-automation MCP remains available under its existing
  feature conditions.

### End-to-end scenarios

1. Start `qwen serve --port 0 --open` without token configuration. In the real
   Web Shell, perform file/settings/skill/MCP operations that previously
   returned `token_required`.
2. Repeat with a TypeScript SDK client and no token.
3. Start with `--enable-session-shell`, create a session, and run a shell command
   with its real client id; repeat without the flag and confirm rejection.
4. Enable Local Control from the tokenless Web Shell, scan the returned QR, and
   confirm LAN REST/WebSocket access requires the pairing credential and is
   revoked on disable.
5. Start a hardened local daemon with a managed token and `--require-auth`;
   confirm anonymous `/health`, REST, and WebSocket calls are rejected.

Implementation verification should include the focused CLI and ACP bridge unit
tests, package builds and typechecks, lint/format checks, and the repository's
CLI/interactive integration suites after bundling.

## Rollout and observability

Ship the change with release notes that lead with the compatibility warning,
not merely the convenience benefit. The tokenless startup breadcrumb makes the
active trust boundary visible in terminals, service logs, and bug reports.

Release-note copy:

> `qwen serve` now grants the token-less loopback primary listener full operator API access, including strict routes and explicitly enabled session shell. On shared hosts, CI runners, remote development machines, or environments with untrusted local processes, configure `QWEN_SERVER_TOKEN` and start with `--require-auth` before upgrading.

No gradual runtime flag is proposed: adding another default-off flag would
defeat the requested default. The change is still operationally reversible by
setting a token and `--require-auth`, and code-reversible through the one
central policy dependency.

For support diagnostics, `GET /daemon/status` already exposes the three facts
needed to identify the mode. Do not log token values, Authorization headers,
or Local Control fragment URLs beyond existing deliberate terminal handoff
paths.

## External reference points

- [Jupyter Server security](https://jupyter-server.readthedocs.io/en/latest/operators/security.html)
  enables token authentication by default because its APIs can execute code,
  and warns that disabling authentication is appropriate only when another
  access restriction supplies the boundary. This design names loopback and
  local-process trust as that boundary rather than treating no token as
  intrinsically safe.
- [VS Code server options](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/serverEnvironmentService.ts)
  distinguish the normal generated connection token from an explicit
  `--without-connection-token` mode that should be used only when another
  mechanism secures the connection. This supports keeping hardened and
  trusted-local modes explicit and distinct.
- [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/)
  permits user agents to treat correctly resolved localhost origins as
  potentially trustworthy, while also documenting incomplete isolation. That
  browser transport classification is not used as daemon authorization.
- [Docker Desktop networking](https://docs.docker.com/desktop/features/networking/networking-how-tos/)
  documents `host.docker.internal` for container-to-host service access. This
  is why the trusted local boundary must explicitly mention reachable
  containers and proxies.
